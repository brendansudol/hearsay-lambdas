import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda"
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3"

const bucket = process.env.AWS_BUCKET_NAME
const region = process.env.AWS_REGION_NAME
const lambdaClient = new LambdaClient({ region })
const s3Client = new S3Client({ region })

export const handler = async (event) => {
  const { dbId, fileName } = getParams(event)
  if (fileName == null) {
    return toResponse(500, { error: "no file" })
  }

  const isFileValid = await validateFile(fileName)
  if (!isFileValid) {
    return toResponse(500, { error: "invalid file" })
  }

  const audioUrl = `https://${bucket}.s3.amazonaws.com/${fileName}`
  const input = {
    FunctionName: "hello-world",
    InvocationType: "Event",
    Payload: JSON.stringify({ audioUrl, dbId }),
  }

  try {
    const command = new InvokeCommand(input)
    const response = await lambdaClient.send(command)
    const status = response.StatusCode

    return toResponse(200, { status })
  } catch (error) {
    return toResponse(500, { error: error.message ?? "unknown error" })
  }
}

function toResponse(statusCode, body) {
  return {
    statusCode,
    body: JSON.stringify(body),
  }
}

async function validateFile(fileName) {
  try {
    const command = new HeadObjectCommand({ Bucket: bucket, Key: fileName })
    const response = await s3Client.send(command)
    return response.$metadata.httpStatusCode === 200
  } catch (error) {
    return false
  }
}

function getParams(event) {
  if (event == null) {
    return {}
  }

  const body = parseJSON(event.body)
  return { ...event.queryStringParameters, ...body }
}

function parseJSON(content) {
  try {
    return JSON.parse(content ?? "{}")
  } catch (_) {
    return {}
  }
}
