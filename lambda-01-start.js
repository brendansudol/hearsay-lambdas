import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda"
import axios from "axios"

const SUPPORTED_FILE_TYPES = ["audio/mpeg", "audio/mp3", "audio/x-m4a"] // TODO: add more
const MAX_FILE_SIZE = 200_000_000 // 200 MB

const lambdaClient = new LambdaClient({
  region: process.env.AWS_REGION_NAME,
})

export const handler = async (event) => {
  try {
    const { dbId, audioUrl } = getParams(event)
    if (dbId == null || audioUrl == null) {
      return errorResponse("missing params")
    }

    const { contentType, contentLength } = await getFileMetadata(audioUrl)
    if (
      contentType == null ||
      contentLength == null ||
      !SUPPORTED_FILE_TYPES.includes(contentType) ||
      contentLength > MAX_FILE_SIZE
    ) {
      console.log("invalid file", { contentType, contentLength })
      return errorResponse("invalid file", { contentType, contentLength })
    }

    const lambdaInput = {
      FunctionName: "hearsay-transcribe-main",
      InvocationType: "Event",
      Payload: JSON.stringify({ audioUrl, dbId }),
    }

    const command = new InvokeCommand(lambdaInput)
    const response = await lambdaClient.send(command)
    console.log(`lambda invoke status code: ${response.StatusCode}`)
    return makeResponse(200, { status: "success" })
  } catch (error) {
    console.log("error", error)
    return errorResponse(error.message ?? "unknown error")
  }
}

function makeResponse(statusCode, body) {
  return { statusCode, body: JSON.stringify(body) }
}

function errorResponse(message, details = {}) {
  return makeResponse(500, {
    status: "error",
    error: message,
    ...details,
  })
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

function getParams(event) {
  if (event == null) {
    return {}
  }

  return {
    ...event.queryStringParameters,
    ...parseJSON(event.body),
  }
}

function parseJSON(content) {
  try {
    return JSON.parse(content ?? "{}")
  } catch (_) {
    return
  }
}
