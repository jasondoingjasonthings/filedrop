'use strict';

const { S3Client, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { GetObjectCommand, PutObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const ACCOUNT_ID  = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY  = process.env.R2_ACCESS_KEY_ID;
const SECRET_KEY  = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET      = process.env.R2_BUCKET || 'filedrop';

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
});

async function presignDownload(key, expiresIn = 3600, filename) {
  const cmd = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ...(filename ? { ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` } : {}),
  });
  return getSignedUrl(client, cmd, { expiresIn });
}

async function presignUpload(key, expiresIn = 86400) {
  return getSignedUrl(client, new PutObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });
}

async function deleteObject(key) {
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

async function headObject(key) {
  try {
    return await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch {
    return null;
  }
}

async function getObject(key) {
  const res    = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function getObjectStream(key) {
  const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return res.Body;
}

async function putObject(key, buffer, contentType = 'application/octet-stream') {
  await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }));
}

// Multipart helpers (used by agent)
async function createMultipart(key) {
  const r = await client.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key }));
  return r.UploadId;
}

async function presignPart(key, uploadId, partNumber, expiresIn = 3600) {
  return getSignedUrl(
    client,
    new UploadPartCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn }
  );
}

async function completeMultipart(key, uploadId, parts) {
  await client.send(new CompleteMultipartUploadCommand({
    Bucket: BUCKET,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: { Parts: parts },
  }));
}

async function abortMultipart(key, uploadId) {
  await client.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId }));
}

module.exports = {
  presignDownload, presignUpload, deleteObject, headObject, getObject, getObjectStream, putObject,
  createMultipart, presignPart, completeMultipart, abortMultipart,
  BUCKET,
};
