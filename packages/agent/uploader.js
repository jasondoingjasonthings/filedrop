'use strict';

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');
const { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const PART_SIZE       = 100 * 1024 * 1024; // 100 MB per part
const MULTIPART_ABOVE =  10 * 1024 * 1024; // use multipart above 10 MB

async function uploadFile({ serverUrl, agentToken, filePath, name, folder }) {
  const stat = fs.statSync(filePath);
  const size = stat.size;

  // Generate a unique r2 key
  const ext   = path.extname(name);
  const base  = path.basename(name, ext).replace(/[^a-zA-Z0-9._-]/g, '_');
  const ts    = Date.now();
  const r2Key = folder ? `${folder}/${ts}-${base}${ext}` : `${ts}-${base}${ext}`;

  // Register upload with server
  const regRes = await api(serverUrl, agentToken, 'POST', '/api/upload/register', {
    name, r2_key: r2Key, size, folder,
  });
  const { id } = regRes;
  console.log(`[uploader] Registered ${name} → id=${id}, key=${r2Key}`);

  try {
    if (size > MULTIPART_ABOVE) {
      await multipartUpload({ serverUrl, agentToken, id, filePath, r2Key, size });
    } else {
      await simpleUpload({ serverUrl, agentToken, id, filePath, r2Key, size });
    }

    // Mark complete
    await api(serverUrl, agentToken, 'PATCH', `/api/upload/${id}/complete`, { size });
    console.log(`[uploader] ✓ ${name} complete`);
  } catch (err) {
    console.error(`[uploader] Upload error for ${name}:`, err.message);
    await api(serverUrl, agentToken, 'PATCH', `/api/upload/${id}/fail`, {}).catch(() => {});
    throw err;
  }
}

// ── Simple upload (small files) ──────────────────────────────────────────────

async function simpleUpload({ serverUrl, agentToken, id, filePath, r2Key, size }) {
  // Get a presigned PUT URL from server
  const { url } = await api(serverUrl, agentToken, 'POST', '/api/upload/presign', { r2_key: r2Key });

  const stream = fs.createReadStream(filePath);
  const res = await fetch(url, {
    method: 'PUT',
    body: stream,
    headers: { 'Content-Length': String(size) },
    duplex: 'half',
  });
  if (!res.ok) throw new Error(`R2 PUT failed: ${res.status}`);

  await api(serverUrl, agentToken, 'PATCH', `/api/upload/${id}/progress`, { progress: 100 });
}

// ── Multipart upload (large files) ──────────────────────────────────────────

async function multipartUpload({ serverUrl, agentToken, id, filePath, r2Key, size }) {
  // Create multipart upload session via server
  const { uploadId } = await api(serverUrl, agentToken, 'POST', '/api/upload/multipart/create', { r2_key: r2Key });

  const parts    = [];
  const numParts = Math.ceil(size / PART_SIZE);
  const fd       = fs.openSync(filePath, 'r');

  try {
    for (let i = 0; i < numParts; i++) {
      const partNumber = i + 1;
      const offset     = i * PART_SIZE;
      const partSize   = Math.min(PART_SIZE, size - offset);

      // Get presigned URL for this part
      const { url } = await api(serverUrl, agentToken, 'POST', '/api/upload/multipart/part-url', {
        r2_key: r2Key, uploadId, partNumber,
      });

      // Read part into buffer
      const buf = Buffer.alloc(partSize);
      fs.readSync(fd, buf, 0, partSize, offset);

      // Upload part
      const res = await fetch(url, {
        method: 'PUT',
        body: buf,
        headers: { 'Content-Length': String(partSize) },
      });
      if (!res.ok) throw new Error(`Part ${partNumber} upload failed: ${res.status}`);

      const etag = res.headers.get('etag');
      parts.push({ PartNumber: partNumber, ETag: etag });

      const progress = Math.round((partNumber / numParts) * 100);
      await api(serverUrl, agentToken, 'PATCH', `/api/upload/${id}/progress`, { progress });
      console.log(`[uploader] Part ${partNumber}/${numParts} (${progress}%)`);
    }
  } finally {
    fs.closeSync(fd);
  }

  // Complete multipart upload
  await api(serverUrl, agentToken, 'POST', '/api/upload/multipart/complete', {
    r2_key: r2Key, uploadId, parts,
  });
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

async function api(serverUrl, agentToken, method, path, body) {
  const res = await fetch(`${serverUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Agent ${agentToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

module.exports = { uploadFile };
