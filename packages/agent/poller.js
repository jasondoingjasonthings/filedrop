'use strict';

const fs   = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { uploadFile } = require('./uploader');

const POLL_INTERVAL  = 1500;  // ms
const UPLOAD_CONCURRENCY = 3; // files uploading at once
const RETRY_DELAY_MS = 30_000; // wait between retry passes
const MAX_PASSES     = 5;

function startPoller({ serverUrl, agentToken }) {
  console.log('[poller] Started — polling for dashboard commands');

  async function poll() {
    try {
      const res = await fetch(`${serverUrl}/api/fs/pending`, {
        headers: { Authorization: `Agent ${agentToken}` },
      });
      if (!res.ok) return;
      const { commands } = await res.json();
      for (const cmd of commands) {
        handleCommand(cmd, serverUrl, agentToken);
      }
    } catch {
      // server unreachable — keep trying
    }
  }

  setInterval(poll, POLL_INTERVAL);
  poll();
}

async function handleCommand(cmd, serverUrl, agentToken) {
  try {
    let result;

    if (cmd.type === 'browse') {
      const { path: dirPath } = cmd.payload;
      result = { entries: dirPath ? listDir(dirPath) : getRoots() };

    } else if (cmd.type === 'dirsize') {
      const { paths } = cmd.payload;
      const sizes = {};
      for (const p of paths) sizes[p] = dirSize(p);
      result = { sizes };

    } else if (cmd.type === 'upload') {
      result = await handleUpload(cmd.payload, serverUrl, agentToken);
    }

    await fetch(`${serverUrl}/api/fs/result/${cmd.id}`, {
      method:  'POST',
      headers: { Authorization: `Agent ${agentToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ result }),
    });
  } catch (err) {
    fetch(`${serverUrl}/api/fs/result/${cmd.id}`, {
      method:  'POST',
      headers: { Authorization: `Agent ${agentToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ error: err.message }),
    }).catch(() => {});
  }
}

// ── Upload flow ───────────────────────────────────────────────────────────────
// Files are registered individually just before they start uploading — not all
// at once. This keeps the dashboard accurate (only shows files actually in
// flight) and prevents hundreds of ghost 'uploading' records in the DB.

async function handleUpload({ paths, folder }, serverUrl, agentToken) {
  const allFiles = [];
  for (const p of paths) expandPath(p, allFiles);
  const total = allFiles.length;
  console.log(`[poller] Found ${total} file(s) to upload`);

  let uploaded = 0, skipped = 0, failed = 0;

  // Broadcast initial queue status so dashboard shows the queue depth immediately
  await sendQueueStatus(serverUrl, agentToken, folder || '', total, 0, 0);

  async function runBatch(items) {
    const stillFailing = [];
    for (let i = 0; i < items.length; i += UPLOAD_CONCURRENCY) {
      const batch = items.slice(i, i + UPLOAD_CONCURRENCY);

      const results = await Promise.allSettled(batch.map(filePath =>
        uploadFile({ serverUrl, agentToken, filePath, name: path.basename(filePath), folder: folder || '' })
      ));

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === 'rejected') {
          console.error(`[poller] Failed: ${path.basename(batch[j])} — ${r.reason?.message}`);
          stillFailing.push(batch[j]);
          failed++;
        } else if (r.value === 'skipped') {
          skipped++;
        } else {
          uploaded++;
        }
        await sendQueueStatus(serverUrl, agentToken, folder || '', total, uploaded + skipped, failed);
      }
    }
    return stillFailing;
  }

  let toUpload = allFiles;
  for (let pass = 1; pass <= MAX_PASSES && toUpload.length > 0; pass++) {
    if (pass > 1) {
      console.log(`[poller] Pass ${pass}: retrying ${toUpload.length} file(s) after ${RETRY_DELAY_MS / 1000}s`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
    toUpload = await runBatch(toUpload);
  }

  const done = uploaded + skipped;
  if (done < total) {
    console.warn(`[poller] WARNING: ${done}/${total} complete — ${toUpload.length} permanently failed`);
  } else {
    console.log(`[poller] ✓ All ${total} files complete (${uploaded} uploaded, ${skipped} already on server)`);
  }

  return { total, uploaded, skipped, failed: toUpload.length };
}

// Broadcast queue depth to dashboard via SSE. Fire-and-forget — network
// errors here should never interrupt the actual upload.
async function sendQueueStatus(serverUrl, agentToken, folder, total, done, failed) {
  try {
    await fetch(`${serverUrl}/api/upload/queue-status`, {
      method:  'POST',
      headers: { Authorization: `Agent ${agentToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ folder, total, done, failed }),
    });
  } catch {}
}

// ── File system helpers ───────────────────────────────────────────────────────

function expandPath(filePath, out) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      for (const item of fs.readdirSync(filePath, { withFileTypes: true })) {
        if (!item.name.startsWith('.')) expandPath(path.join(filePath, item.name), out);
      }
    } else {
      out.push(filePath);
    }
  } catch (err) {
    console.warn(`[poller] Skipping inaccessible path: ${filePath} — ${err.message}`);
  }
}

function getRoots() {
  if (process.platform === 'win32') {
    const drives = [];
    for (let i = 65; i <= 90; i++) {
      const drive = String.fromCharCode(i) + ':\\';
      try { fs.accessSync(drive); drives.push({ name: drive, path: drive, isDir: true, size: 0 }); } catch {}
    }
    return drives;
  }
  return listDir('/');
}

function listDir(dirPath) {
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(item => !item.name.startsWith('.') && !item.name.startsWith('$'))
    .map(item => {
      const fullPath = path.join(dirPath, item.name);
      const isDir    = item.isDirectory();
      let size = 0;
      try { if (!isDir) size = fs.statSync(fullPath).size; } catch {}
      return { name: item.name, path: fullPath, isDir, size, sizeReady: !isDir };
    })
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}

function dirSize(dirPath, depth = 0, state = { count: 0 }) {
  if (depth > 3 || state.count > 500) return 0;
  let total = 0;
  try {
    for (const item of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (item.name.startsWith('.') || state.count > 500) continue;
      state.count++;
      const full = path.join(dirPath, item.name);
      try {
        total += item.isDirectory() ? dirSize(full, depth + 1, state) : fs.statSync(full).size;
      } catch {}
    }
  } catch {}
  return total;
}

module.exports = { startPoller };
