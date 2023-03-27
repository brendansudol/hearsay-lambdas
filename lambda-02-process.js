import ffmpegInstaller from "@ffmpeg-installer/ffmpeg"
import { createClient } from "@supabase/supabase-js"
import axios from "axios"
import child_process from "child_process"
import { fileTypeFromFile } from "file-type"
import fs from "fs"
import https from "https"

const TEMP_DIR = process.env.TEMP_DIR
const SEGMENT_PREFIX = "segment-"
const SEGMENT_LENGTH = 60 * 20 // 20 minutes
const MAX_SIZE = 20_000_000

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

export const handler = async (event) => {
  try {
    const { audioUrl, dbId } = event
    if (audioUrl == null) {
      return toResponse(500, { error: "no audio url" })
    }

    const taskStart = process.hrtime() // kick off timer

    await updateDatabaseEntry(dbId, { status: "RUNNING" })

    const audioPathTemp = `${TEMP_DIR}/audio-temp`
    await fetchAndSave(audioUrl, audioPathTemp)
    const { ext, mime } = (await fileTypeFromFile(audioPathTemp)) ?? {}
    const { size } = fs.statSync(audioPathTemp)

    // TODO: validate proper mime types

    const completeAudioPath = `${TEMP_DIR}/audio.${ext}`
    fs.renameSync(audioPathTemp, completeAudioPath)

    const needsSplit = size > MAX_SIZE
    if (needsSplit) {
      await ffmpeg([
        "-i",
        completeAudioPath,
        "-f",
        "segment",
        "-segment_time",
        SEGMENT_LENGTH,
        "-c",
        "copy",
        `${TEMP_DIR}/${SEGMENT_PREFIX}%03d.${ext}`,
      ])
    }

    const files = needsSplit
      ? fs
          .readdirSync(TEMP_DIR)
          .filter((f) => f.startsWith(SEGMENT_PREFIX))
          .map((fname) => `${TEMP_DIR}/${fname}`)
      : [completeAudioPath]

    // TODO: make sure we're not sending too many concurrent requests
    const results = await Promise.all(files.map((file) => transcribe(file, mime)))

    await updateDatabaseEntry(dbId, { status: "SUCCESS", results })
    return toResponse(200, {
      input: audioUrl,
      fileCount: files.length,
      results: results,
      taskDuration: process.hrtime(taskStart)[0],
    })
  } catch (error) {
    const reason = error.message ?? "unknown error"
    await updateDatabaseEntry(dbId, { status: "FAILED", reason })
    return toResponse(500, { error: reason })
  }
}

function updateDatabaseEntry(id, results) {
  return db.from("transcriptions").update({ results }).eq("id", id)
}

function toResponse(statusCode, body) {
  return {
    statusCode,
    body: JSON.stringify(body),
  }
}

function fetchAndSave(url, filename) {
  return new Promise((resolve) => {
    const file = fs.createWriteStream(filename)
    https.get(url, (response) => {
      response.pipe(file)
      file.on("finish", resolve)
    })
  })
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

async function transcribe(fileName, mime) {
  const buffer = fs.readFileSync(fileName)
  const blob = new Blob([buffer], { type: mime })

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
