import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg"
import { createClient } from "@supabase/supabase-js"
import axios from "axios"
import child_process from "child_process"
import fs from "fs"
import mime from "mime"
import path from "path"
import { v4 as uuidv4 } from "uuid"
import { MAX_FILE_SIZE, SUPPORTED_FILE_TYPES } from "./utils"

const AWS_REGION = process.env.AWS_REGION_NAME
const S3_BUCKET = process.env.S3_BUCKET_NAME
const TEMP_DIR = process.env.TEMP_DIR

const SEGMENT_PREFIX = "segment-"
const SEGMENT_LENGTH = 60 * 20 // 20 minutes
const SPLIT_FILE_SIZE_THRESHOLD = 24_000_000 // 24 MB

const supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
const s3Client = new S3Client({ region: AWS_REGION, useAccelerateEndpoint: true })

export const handler = async (event) => {
  const { audioUrl, dbId } = event ?? {}
  if (audioUrl == null || dbId == null) {
    return errorResponse("missing params")
  }

  try {
    const taskStart = process.hrtime() // kick off timer
    await updateDatabase(dbId, { transcription: { status: "RUNNING" } })

    // validate file type and size
    const { contentType, contentLength } = await getFileMetadata(audioUrl)
    console.log("file metadata: ", { contentType, contentLength })
    if (
      contentType == null ||
      contentLength == null ||
      !SUPPORTED_FILE_TYPES.includes(contentType) ||
      contentLength > MAX_FILE_SIZE
    ) {
      console.log("invalid file", { contentType, contentLength })
      throw new Error("invalid file")
    }

    const extension = getExtension(contentType)
    const fileName = `${uuidv4()}.${extension}`
    console.log("new file name: ", fileName)

    // save audio to temp dir
    const audioPath = `${TEMP_DIR}/${fileName}`
    await saveUrlToLocalFile(audioUrl, audioPath)

    var { size } = fs.statSync(audioPath)
    console.log(`orig size: ${contentLength}; local size: ${size}`)
    if (size === 0) {
      throw new Error("empty file")
    }

    // save to s3 (and update db)
    const s3Url = await uploadLocalFileToS3(audioPath, fileName)
    await updateDatabase(dbId, { audioUrl: s3Url })

    // split audio into smaller files if needed
    const files = await maybeSplitFile(audioPath, contentLength)
    if (files.length === 0) {
      throw new Error("no files to transcribe")
    }

    // transcribe + summarize + update db
    // (TODO: make sure we're not sending too many concurrent requests)
    const transcript = await Promise.all(files.map((filePath) => transcribe(filePath, contentType)))
    const summary = await summarize(transcript)

    await updateDatabase(dbId, {
      transcription: { status: "SUCCESS", output: transcript },
      title: summary?.title ?? null,
      summary: summary?.paragraph ?? null,
    })

    const taskDuration = process.hrtime(taskStart)[0]
    const output = { s3Url, taskDuration, numFiles: files.length }
    console.log("output: ", output)
    return makeResponse(200, { status: "success", output })
  } catch (error) {
    console.log(error)
    const reason = error.message ?? "unknown error"
    await updateDatabase(dbId, { transcription: { status: "FAILED", reason } })
    return errorResponse(reason)
  }
}

function makeResponse(statusCode, body) {
  return { statusCode, body: JSON.stringify(body) }
}

function errorResponse(message) {
  return makeResponse(500, { status: "error", error: message })
}

function updateDatabase(id, fields) {
  return supabaseClient.from("transcriptions").update(fields).eq("id", id)
}

async function getFileMetadata(url) {
  try {
    const { headers } = await axios.head(url)
    const contentType = headers["content-type"]
    const contentLength = Number(headers["content-length"]) || undefined
    return { contentType, contentLength }
  } catch (error) {
    console.log("error fetching file metadata: ", error)
    return {}
  }
}

function getExtension(contentType) {
  const ext = mime.getExtension(contentType)
  return ext === "mpga" ? "mp3" : ext // TODO: revisit this
}

async function saveUrlToLocalFile(url, filePath) {
  const response = await axios({ method: "get", url, responseType: "stream" })
  const stream = fs.createWriteStream(filePath)
  response.data.pipe(stream)
  return new Promise((resolve, reject) => {
    stream.on("finish", resolve)
    stream.on("error", reject)
  })
}

async function uploadLocalFileToS3(filePath, key) {
  const fileStream = fs.createReadStream(filePath)
  const uploadParams = {
    Bucket: S3_BUCKET,
    Key: key,
    Body: fileStream,
    ACL: "public-read",
  }

  const command = new PutObjectCommand(uploadParams)
  const response = await s3Client.send(command)

  if (response.$metadata.httpStatusCode !== 200) {
    throw new Error("error uploading to s3")
  }

  return `https://${S3_BUCKET}.s3.amazonaws.com/${key}`
}

async function maybeSplitFile(filePath, fileSize) {
  if (fileSize < SPLIT_FILE_SIZE_THRESHOLD) {
    return [filePath]
  }

  const ext = path.extname(filePath)
  await ffmpeg([
    "-i",
    filePath,
    "-f",
    "segment",
    "-segment_time",
    SEGMENT_LENGTH,
    "-c",
    "copy",
    `${TEMP_DIR}/${SEGMENT_PREFIX}%03d${ext}`,
  ])

  return fs
    .readdirSync(TEMP_DIR)
    .filter((f) => f.startsWith(SEGMENT_PREFIX))
    .map((f) => `${TEMP_DIR}/${f}`)
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const allArgs = ["-y", "-loglevel", "warning", ...args.map(String)]

    child_process
      .spawn(ffmpegInstaller.path, allArgs)
      .on("message", (msg) => console.log(msg))
      .on("error", reject)
      .on("close", resolve)
  })
}

async function transcribe(fileName, fileType) {
  const buffer = fs.readFileSync(fileName)
  const blob = new Blob([buffer], { type: fileType })

  const formData = new FormData()
  formData.append("model", "whisper-1")
  formData.append("response_format", "verbose_json")
  formData.append("file", blob, fileName)

  const config = { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
  const response = await axios.post(
    "https://api.openai.com/v1/audio/transcriptions",
    formData,
    config
  )

  return { fileName, results: response.data }
}

const SUMMARY_PROMPT = `Please summarize the following transcript into one paragraph. Ignore advertisements. Here is the transcript:`
const TITLE_PROMPT = `Please summarize the following transcript into a short phrase that could be used as a title for the transcript. Ignore advertisements. Here is the transcript:`

async function summarize(results) {
  try {
    const textChunks = results.map((r) => r.results.text)
    if (textChunks.length === 0) return

    const transcript = formatTranscriptForPrompt(textChunks)
    const [title, paragraph] = await Promise.all([
      callGpt4(`${TITLE_PROMPT}\n\n\n${transcript}`),
      callGpt4(`${SUMMARY_PROMPT}\n\n\n${transcript}`),
    ])

    return { title, paragraph }
  } catch (error) {
    console.log("error during summarization: ", error)
    return
  }
}

async function callGpt4(prompt) {
  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
    },
    {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    }
  )

  return response.data?.choices?.[0]?.message.content
}

const MAX_CHARS = 12_000
const MIN_CHARS_FOR_FIRST_CHUNK = 4_000
const MAX_CHUNKS_TO_USE = 6
const JOIN_STR = " ... "

function formatTranscriptForPrompt(textChunks) {
  const n = Math.min(textChunks.length, MAX_CHUNKS_TO_USE)
  const charsPerChunk = Math.floor(MAX_CHARS / n)

  // if there are a lot of chunks, use more text from first chunk
  // since it probably has the most context re: what audio is about
  if (charsPerChunk < MIN_CHARS_FOR_FIRST_CHUNK) {
    const [first, ...rest] = textChunks
    const firstResult = sliceText(first, MIN_CHARS_FOR_FIRST_CHUNK)

    const restSize = Math.floor((MAX_CHARS - firstResult.length) / rest.length)
    const restResults = rest.map((t) => sliceText(t, restSize))

    return [firstResult, ...restResults].join(JOIN_STR)
  }

  // otherwise, use the same amount of text from each chunk
  return textChunks.map((t) => sliceText(t, charsPerChunk)).join(JOIN_STR)
}

function sliceText(text, numChars) {
  return text.length <= numChars ? text : text.slice(0, numChars) + "..."
}
