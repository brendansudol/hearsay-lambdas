import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg"
import { createClient } from "@supabase/supabase-js"
import axios from "axios"
import child_process from "child_process"
import fs from "fs"
import https from "https"
import mime from "mime"
import path from "path"
import { v4 as uuidv4 } from "uuid"

const AWS_REGION = process.env.AWS_REGION_NAME
const S3_BUCKET = process.env.S3_BUCKET_NAME
const TEMP_DIR = process.env.TEMP_DIR

const SEGMENT_PREFIX = "segment-"
const SEGMENT_LENGTH = 60 * 20 // 20 minutes
const SPLIT_FILE_SIZE_THRESHOLD = 24_000_000 // 24 MB

const SUPPORTED_FILE_TYPES = ["audio/mpeg", "audio/mp3", "audio/x-m4a"] // TODO: add more
const MAX_FILE_SIZE = 200_000_000 // 200 MB

const supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
const s3Client = new S3Client({ region: AWS_REGION, useAccelerateEndpoint: true })

export const handler = async (event) => {
  const { audioUrl, dbId } = event ?? {}
  if (audioUrl == null || dbId == null) {
    return errorResponse("missing params")
  }

  try {
    const taskStart = process.hrtime() // kick off timer
    await updateDatabase(dbId, { results: { status: "RUNNING" } })

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

    // save to s3 (and update db)
    const s3Url = await uploadLocalFileToS3(audioPath, fileName)
    await updateDatabase(dbId, { audio_url: s3Url })

    // split audio into smaller files if needed
    const files = await maybeSplitFile(audioPath, contentLength)
    if (files.length === 0) {
      throw new Error("no files to transcribe")
    }

    // transcribe + update db (TODO: make sure we're not sending too many concurrent requests)
    const results = await Promise.all(files.map((filePath) => transcribe(filePath, contentType)))
    await updateDatabase(dbId, { results: { status: "SUCCESS", results } })

    const taskDuration = process.hrtime(taskStart)[0]
    const output = { audioUrl, taskDuration, numFiles: files.length }
    console.log("output: ", output)
    return makeResponse(200, { status: "success", output })
  } catch (error) {
    const reason = error.message ?? "unknown error"
    await updateDatabase(dbId, { results: { status: "FAILED", reason } })
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
    const response = await axios.head(url)
    const contentType = response.headers["content-type"]
    const contentLength = Number(response.headers["content-length"])
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

function saveUrlToLocalFile(url, filePath) {
  return new Promise((resolve) => {
    const stream = fs.createWriteStream(filePath)
    https.get(url, (response) => {
      response.pipe(stream)
      stream.on("finish", resolve)
    })
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

  const response = await axios.post("https://api.openai.com/v1/audio/transcriptions", formData, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
  })

  return { fileName, results: response.data }
}
