'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const fetch  = require('node-fetch');

const PART_SIZE        = 256 * 1024 * 1024; // 256 MB per part
const MULTIPART_ABOVE  =  10 * 1024 * 1024; // use multipart above 10 MB
const PART_CONCURRENCY = 3;                 // parallel parts per file
const RESUME_DIR       = path.join(os.homedir(), '.filedrop', 'resume');

// ── Checksum ──────────────────────────────────────────────────────────────────

function computeSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end',  ()    => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ── Resume state ──────────────────────────────────────────────────────────────
// Keyed by hash of filePath + size + mtime so a changed file starts fresh.

function resumeKey(filePath, size, mtimeMs) {
  return crypto.createHash('sha256')
    .update(`${filePath}|${size}|${mtimeMs}`)
    .digest('hex')
    .slice(0, 24);
}

function loadResume(filePath, size, mtimeMs) {
  try {
    const p = path.join(RESUME_DIR, resumeKey(filePath, size, mtimeMs) + '.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return null;
}

function saveResume(rKey, state) {
  try {
    fs.mkdirSync(RESUME_DIR, { recursive: true });
    fs.writeFileSync(path.join(RESUME_DIR, rKey + '.json'), JSON.stringify(state), 'utf8');
  } catch (e) {
    console.warn('[uploader] Could not save resume state:', e.message);
  }
}

function clearResume(rKey) {
  try { fs.unlinkSync(path.join(RESUME_DIR, rKey + '.json')); } catch {}
}

// Remove resume files older than 6 days (R2 multipart sessions expire at 7 days).
function pruneOldResumes() {
  try {
    if (!fs.existsSync(RESUME_DIR)) return;
    const cutoff = Date.now() - 6 * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(RESUME_DIR)) {
      const p = path.join(RESUME_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}

// ── Registration ──────────────────────────────────────────────────────────────

// Returns { id, r2Key, size } on success, or null if file already available on server.
// Pass forceR2Key when resuming so the same R2 object/multipart session is reused.
async function registerFile({ serverUrl, agentToken, filePath, name, folder, forceR2Key }) {
  const stat = fs.statSync(filePath);
  const size = stat.size;

  const ext   = path.extname(name);
  const base  = path.basename(name, ext).replace(/[^a-zA-Z0-9._-]/g, '_');
  const r2Key = forceR2Key
    ?? (folder ? `${folder}/${Date.now()}-${base}${ext}` : `${Date.now()}-${base}${ext}`);

  const regRes = await api(serverUrl, agentToken, 'POST', '/api/upload/register', {
    name, r2_key: r2Key, size, folder,
  });

  if (regRes.skip) {
    console.log(`[uploader] Already available, skipping: ${name}`);
    return null;
  }
  return { id: regRes.id, r2Key, size };
}

// ── Upload entry point ────────────────────────────────────────────────────────

async function uploadFile({ serverUrl, agentToken, filePath, name, folder }) {
  const stat    = fs.statSync(filePath);
  const size    = stat.size;
  const mtimeMs = stat.mtimeMs;
  const rKey    = resumeKey(filePath, size, mtimeMs);
  const resume  = loadResume(filePath, size, mtimeMs);

  // Compute SHA-256 of file content and register with the server concurrently.
  // Hashing runs a second read pass but local disk is fast and the network
  // upload is always the bottleneck, so wall-clock time is essentially unchanged.
  const [reg, checksum] = await Promise.all([
    registerFile({ serverUrl, agentToken, filePath, name, folder, forceR2Key: resume?.r2Key }),
    computeSha256(filePath),
  ]);

  if (!reg) {
    clearResume(rKey); // file already available — no point keeping resume state
    return 'skipped';
  }

  const { id, r2Key } = reg;
  console.log(`[uploader] Uploading ${name} (${fmtBytes(size)}) sha256=${checksum.slice(0, 12)}… → id=${id}`);

  try {
    if (size > MULTIPART_ABOVE) {
      await multipartUpload({ serverUrl, agentToken, id, filePath, r2Key, size, rKey, resume });
    } else {
      await simpleUpload({ serverUrl, agentToken, id, filePath, r2Key, size });
    }

    await api(serverUrl, agentToken, 'PATCH', `/api/upload/${id}/complete`, { size, checksum });

    // Verify the object landed in R2 with the right size
    await verifyUpload(serverUrl, agentToken, id, size, name);

    clearResume(rKey);
    console.log(`[uploader] ✓ ${name}`);
    return 'uploaded';
  } catch (err) {
    console.error(`[uploader] Upload error for ${name}:`, err.message);
    // Mark failed on server; keep resume state on disk for next attempt
    await api(serverUrl, agentToken, 'PATCH', `/api/upload/${id}/fail`, {}).catch(() => {});
    throw err;
  }
}

async function verifyUpload(serverUrl, agentToken, id, localSize, name) {
  try {
    const result = await api(serverUrl, agentToken, 'GET', `/api/upload/${id}/verify`);
    if (!result.exists) {
      throw new Error(`R2 object not found after upload`);
    }
    if (result.size !== undefined && result.size !== localSize) {
      throw new Error(`Size mismatch: R2=${result.size} local=${localSize}`);
    }
    console.log(`[uploader] ✓ Verified ${name} (${fmtBytes(localSize)})`);
  } catch (err) {
    if (err.message.startsWith('R2 object') || err.message.startsWith('Size mismatch')) throw err;
    // Verify endpoint unavailable — log and continue rather than failing the upload
    console.warn(`[uploader] Verification skipped (${err.message})`);
  }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

function startHeartbeat(serverUrl, agentToken, id) {
  const interval = setInterval(() => {
    api(serverUrl, agentToken, 'PATCH', `/api/upload/${id}/heartbeat`, {}).catch(() => {});
  }, 30_000);
  return () => clearInterval(interval);
}

// ── Retry helper ──────────────────────────────────────────────────────────────

async function withRetry(fn, { maxAttempts = 4, baseDelayMs = 5000, label = 'op' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = baseDelayMs * attempt; // 5s, 10s, 15s
      console.warn(`[uploader] ${label} attempt ${attempt}/${maxAttempts} failed: ${err.message} — retrying in ${delay / 1000}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── Simple upload (≤ 10 MB) ───────────────────────────────────────────────────

async function simpleUpload({ serverUrl, agentToken, id, filePath, r2Key, size }) {
  const { url } = await api(serverUrl, agentToken, 'POST', '/api/upload/presign', { r2_key: r2Key });
  const stopHeartbeat = startHeartbeat(serverUrl, agentToken, id);
  try {
    await withRetry(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
      try {
        const stream = fs.createReadStream(filePath);
        const res = await fetch(url, {
          method: 'PUT',
          body: stream,
          headers: { 'Content-Length': String(size) },
          duplex: 'half',
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`R2 PUT failed: ${res.status}`);
      } finally {
        clearTimeout(timer);
      }
    }, { label: 'simple upload' });
    await api(serverUrl, agentToken, 'PATCH', `/api/upload/${id}/progress`, { progress: 100 });
  } finally {
    stopHeartbeat();
  }
}

// ── Multipart upload (> 10 MB) with resume ────────────────────────────────────

async function multipartUpload({ serverUrl, agentToken, id, filePath, r2Key, size, rKey, resume }) {
  const numParts = Math.ceil(size / PART_SIZE);
  const allParts = new Array(numParts).fill(null); // index → {PartNumber, ETag}
  let uploadId;

  if (resume?.uploadId) {
    // Resume: reuse saved R2 multipart session and skip already-completed parts
    uploadId = resume.uploadId;
    for (const p of (resume.completedParts || [])) {
      if (p?.PartNumber >= 1 && p.PartNumber <= numParts) {
        allParts[p.PartNumber - 1] = p;
      }
    }
    const done = allParts.filter(Boolean).length;
    console.log(`[uploader] Resuming multipart ${path.basename(filePath)}: ${done}/${numParts} parts already done`);
  } else {
    const r = await api(serverUrl, agentToken, 'POST', '/api/upload/multipart/create', { r2_key: r2Key });
    uploadId = r.uploadId;
    // Persist immediately so a crash after create but before any parts doesn't orphan the session
    saveResume(rKey, { r2Key, uploadId, completedParts: [] });
  }

  const stopHeartbeat = startHeartbeat(serverUrl, agentToken, id);

  try {
    for (let batchStart = 0; batchStart < numParts; batchStart += PART_CONCURRENCY) {
      const batchEnd     = Math.min(batchStart + PART_CONCURRENCY, numParts);
      const pendingParts = [];
      for (let i = batchStart; i < batchEnd; i++) {
        if (!allParts[i]) pendingParts.push(i);
      }

      if (pendingParts.length > 0) {
        await Promise.all(pendingParts.map(i => {
          const partNumber = i + 1;
          const offset     = i * PART_SIZE;
          const partSize   = Math.min(PART_SIZE, size - offset);

          return withRetry(async () => {
            const { url } = await api(serverUrl, agentToken, 'POST', '/api/upload/multipart/part-url', {
              r2_key: r2Key, uploadId, partNumber,
            });
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
            try {
              const stream = fs.createReadStream(filePath, { start: offset, end: offset + partSize - 1 });
              const res = await fetch(url, {
                method: 'PUT',
                body: stream,
                headers: { 'Content-Length': String(partSize) },
                duplex: 'half',
                signal: controller.signal,
              });
              if (!res.ok) throw new Error(`Part ${partNumber} failed: ${res.status}`);
              allParts[i] = { PartNumber: partNumber, ETag: res.headers.get('etag') };
            } finally {
              clearTimeout(timer);
            }
          }, { label: `part ${partNumber}/${numParts}` });
        }));
      }

      // Progress is based on how many parts are done out of total (including skipped ones)
      const totalDone = allParts.slice(0, batchEnd).filter(Boolean).length;
      const progress  = Math.round((totalDone / numParts) * 100);
      await api(serverUrl, agentToken, 'PATCH', `/api/upload/${id}/progress`, { progress });
      console.log(`[uploader] ${path.basename(filePath)}: ${totalDone}/${numParts} parts (${progress}%)`);

      // Save resume state after every batch so a crash here loses at most one batch
      if (rKey) {
        saveResume(rKey, { r2Key, uploadId, completedParts: allParts.filter(Boolean) });
      }
    }
  } finally {
    stopHeartbeat();
  }

  await api(serverUrl, agentToken, 'POST', '/api/upload/multipart/complete', {
    r2_key: r2Key, uploadId, parts: allParts,
  });
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function api(serverUrl, agentToken, method, urlPath, body) {
  const res = await fetch(`${serverUrl}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Agent ${agentToken}`,
    },
    body: (body && method !== 'GET') ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${method} ${urlPath} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
  return n + ' B';
}

module.exports = { uploadFile, registerFile, pruneOldResumes };
