'use strict';

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');

const PART_SIZE        = 256 * 1024 * 1024; // 256 MB per part
const MULTIPART_ABOVE  =  10 * 1024 * 1024; // use multipart above 10 MB
const PART_CONCURRENCY = 2;                 // parallel parts per file (streaming, low memory)

// Pre-register a file so it appears in the dashboard immediately.
// Returns { id, r2Key } on success, or null if already available (skip).
async function registerFile({ serverUrl, agentToken, filePath, name, folder }) {
  const stat = fs.statSync(filePath);
  const size = stat.size;

  const ext   = path.extname(name);
  const base  = path.basename(name, ext).replace(/[^a-zA-Z0-9._-]/g, '_');
  const ts    = Date.now();
  const r2Key = folder ? `${folder}/${ts}-${base}${ext}` : `${ts}-${base}${ext}`;

  const regRes = await api(serverUrl, agentToken, 'POST', '/api/upload/register', {
    name, r2_key: r2Key, size, folder,
  });
  if (regRes.skip) {
    console.log(`[uploader] Already available, skipping: ${name}`);
    return null; // null = already on server
  }
  return { id: regRes.id, r2Key, size };
}

async function uploadFile({ serverUrl, agentToken, filePath, name, folder, preRegistered }) {
  let id, r2Key, size;

  if (preRegistered) {
    // Already registered — just upload
    ({ id, r2Key, size } = preRegistered);
  } else {
    // Register + upload in one call (legacy path)
    const reg = await registerFile({ serverUrl, agentToken, filePath, name, folder });
    if (!reg) return 'skipped';
    ({ id, r2Key, size } = reg);
  }

  console.log(`[uploader] Uploading ${name} → id=${id}`);

  try {
    if (size > MULTIPART_ABOVE) {
      await multipartUpload({ serverUrl, agentToken, id, filePath, r2Key, size });
    } else {
      await simpleUpload({ serverUrl, agentToken, id, filePath, r2Key, size });
    }

    // Mark complete
    await api(serverUrl, agentToken, 'PATCH', `/api/upload/${id}/complete`, { size });
    console.log(`[uploader] ✓ ${name} complete`);
    return 'uploaded';
  } catch (err) {
    console.error(`[uploader] Upload error for ${name}:`, err.message);
    await api(serverUrl, agentToken, 'PATCH', `/api/upload/${id}/fail`, {}).catch(() => {});
    throw err;
  }
}

// ── Heartbeat helper ─────────────────────────────────────────────────────────

function startHeartbeat(serverUrl, agentToken, id) {
  const interval = setInterval(() => {
    api(serverUrl, agentToken, 'PATCH', `/api/upload/${id}/heartbeat`, {})
      .catch(() => {}); // fire-and-forget
  }, 30_000);
  return () => clearInterval(interval);
}

// ── Retry helper ─────────────────────────────────────────────────────────────
// Retries fn up to maxAttempts times with exponential backoff.
// Useful when an external drive spins down mid-read and needs a few seconds to wake.

async function withRetry(fn, { maxAttempts = 4, baseDelayMs = 5000, label = 'op' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = baseDelayMs * attempt; // 5s, 10s, 15s
      console.warn(`[uploader] ${label} failed (attempt ${attempt}/${maxAttempts}): ${err.message} — retrying in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── Simple upload (small files) ──────────────────────────────────────────────

async function simpleUpload({ serverUrl, agentToken, id, filePath, r2Key, size }) {
  const { url } = await api(serverUrl, agentToken, 'POST', '/api/upload/presign', { r2_key: r2Key });

  const stopHeartbeat = startHeartbeat(serverUrl, agentToken, id);
  try {
    await withRetry(async () => {
      const stream = fs.createReadStream(filePath);
      const res = await fetch(url, {
        method: 'PUT',
        body: stream,
        headers: { 'Content-Length': String(size) },
        duplex: 'half',
      });
      if (!res.ok) throw new Error(`R2 PUT failed: ${res.status}`);
    }, { label: 'simple upload' });
    await api(serverUrl, agentToken, 'PATCH', `/api/upload/${id}/progress`, { progress: 100 });
  } finally {
    stopHeartbeat();
  }
}

// ── Multipart upload (large files) ──────────────────────────────────────────

async function multipartUpload({ serverUrl, agentToken, id, filePath, r2Key, size }) {
  const { uploadId } = await api(serverUrl, agentToken, 'POST', '/api/upload/multipart/create', { r2_key: r2Key });

  const numParts      = Math.ceil(size / PART_SIZE);
  const parts         = new Array(numParts);
  const stopHeartbeat = startHeartbeat(serverUrl, agentToken, id);
  let   completedParts = 0;

  try {
    // Upload PART_CONCURRENCY parts at a time — streamed from disk, no large buffers
    for (let batch = 0; batch < numParts; batch += PART_CONCURRENCY) {
      const batchIndices = [];
      for (let j = batch; j < Math.min(batch + PART_CONCURRENCY, numParts); j++) batchIndices.push(j);

      await Promise.all(batchIndices.map(i => {
        const partNumber = i + 1;
        const offset     = i * PART_SIZE;
        const partSize   = Math.min(PART_SIZE, size - offset);

        return withRetry(async () => {
          const { url } = await api(serverUrl, agentToken, 'POST', '/api/upload/multipart/part-url', {
            r2_key: r2Key, uploadId, partNumber,
          });

          // Stream the part directly from disk — no large Buffer in memory
          const stream = fs.createReadStream(filePath, { start: offset, end: offset + partSize - 1 });
          const res = await fetch(url, {
            method: 'PUT',
            body: stream,
            headers: { 'Content-Length': String(partSize) },
            duplex: 'half',
          });
          if (!res.ok) throw new Error(`Part ${partNumber} failed: ${res.status}`);
          parts[i] = { PartNumber: partNumber, ETag: res.headers.get('etag') };
        }, { label: `part ${partNumber}/${numParts}` });
      }));

      completedParts += batchIndices.length;
      const progress = Math.round((completedParts / numParts) * 100);
      await api(serverUrl, agentToken, 'PATCH', `/api/upload/${id}/progress`, { progress });
      console.log(`[uploader] Parts ${batch + 1}–${batch + batchIndices.length}/${numParts} (${progress}%)`);
    }
  } finally {
    stopHeartbeat();
  }

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

module.exports = { uploadFile, registerFile };
