import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export function makeR2Client(env) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
  })
}

export async function presignDownload(client, bucket, key, expiresIn = 3600, filename) {
  const cmd = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(filename ? { ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` } : {}),
  })
  return getSignedUrl(client, cmd, { expiresIn })
}

export async function presignUpload(client, bucket, key, expiresIn = 86400) {
  return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key }), { expiresIn })
}

export async function headObject(client, bucket, key) {
  try { return await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })) }
  catch { return null }
}

export async function deleteObject(client, bucket, key) {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
}

export async function createMultipart(client, bucket, key) {
  const r = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }))
  return r.UploadId
}

export async function presignPart(client, bucket, key, uploadId, partNumber, expiresIn = 3600) {
  return getSignedUrl(
    client,
    new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn }
  )
}

export async function completeMultipart(client, bucket, key, uploadId, parts) {
  await client.send(new CompleteMultipartUploadCommand({
    Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts },
  }))
}

export async function abortMultipart(client, bucket, key, uploadId) {
  await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))
}

export async function validateMultipart(client, bucket, key, uploadId) {
  try {
    await client.send(new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MaxParts: 1 }))
    return true
  } catch { return false }
}
