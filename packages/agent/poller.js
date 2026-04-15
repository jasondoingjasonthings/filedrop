'use strict';

const fs   = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { uploadFile } = require('./uploader');

const POLL_INTERVAL = 1500; // ms

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
      const { paths, folder } = cmd.payload;
      const allFiles = [];
      for (const p of paths) expandPath(p, allFiles);
      console.log(`[poller] Found ${allFiles.length} file(s) to upload`);

      // Upload with limited concurrency (5 at a time)
      // Returns counts of uploaded, skipped (already on server), and failed
      async function uploadBatch(fileList) {
        const CONCURRENCY = 5;
        let uploaded = 0, skipped = 0;
        const failed = [];

        for (let i = 0; i < fileList.length; i += CONCURRENCY) {
          const batch = fileList.slice(i, i + CONCURRENCY);
          const batchResults = await Promise.allSettled(
            batch.map(filePath => {
              const name = path.basename(filePath);
              return uploadFile({ serverUrl, agentToken, filePath, name, folder: folder || '' });
            })
          );
          batch.forEach((filePath, j) => {
            const r = batchResults[j];
            if (r.status === 'rejected') {
              console.error(`[poller] Failed: ${path.basename(filePath)} — ${r.reason?.message}`);
              failed.push(filePath);
            } else if (r.value === 'skipped') {
              skipped++;
            } else {
              uploaded++;
            }
          });
        }
        return { uploaded, skipped, failed };
      }

      let { uploaded, skipped, failed } = await uploadBatch(allFiles);
      console.log(`[poller] Pass 1: ${uploaded} uploaded, ${skipped} skipped, ${failed.length} failed of ${allFiles.length}`);

      // Keep retrying failed files until none remain (up to 5 passes)
      let pass = 2;
      while (failed.length > 0 && pass <= 5) {
        console.log(`[poller] Pass ${pass}: retrying ${failed.length} failed file(s) after 15s`);
        await new Promise(r => setTimeout(r, 15_000));
        const retry = await uploadBatch(failed);
        uploaded += retry.uploaded;
        skipped  += retry.skipped;
        failed    = retry.failed;
        console.log(`[poller] Pass ${pass}: ${retry.uploaded} uploaded, ${retry.skipped} skipped, ${retry.failed.length} still failing`);
        pass++;
      }

      const done = uploaded + skipped;
      if (done < allFiles.length) {
        console.warn(`[poller] WARNING: only ${done}/${allFiles.length} files accounted for — ${failed.length} permanently failed`);
      } else {
        console.log(`[poller] ✓ All ${allFiles.length} files complete (${uploaded} uploaded, ${skipped} already on server)`);
      }

      result = { total: allFiles.length, uploaded, skipped, failed: failed.length };
    }

    await fetch(`${serverUrl}/api/fs/result/${cmd.id}`, {
      method: 'POST',
      headers: { Authorization: `Agent ${agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ result }),
    });
  } catch (err) {
    // Post error back
    fetch(`${serverUrl}/api/fs/result/${cmd.id}`, {
      method: 'POST',
      headers: { Authorization: `Agent ${agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    }).catch(() => {});
  }
}

function expandPath(filePath, out) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      const items = fs.readdirSync(filePath, { withFileTypes: true });
      for (const item of items) {
        if (!item.name.startsWith('.')) {
          expandPath(path.join(filePath, item.name), out);
        }
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
  const items = fs.readdirSync(dirPath, { withFileTypes: true });
  return items
    .filter(item => !item.name.startsWith('.') && !item.name.startsWith('$'))
    .map(item => {
      const fullPath = path.join(dirPath, item.name);
      const isDir = item.isDirectory();
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
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith('.') || state.count > 500) continue;
      state.count++;
      const full = path.join(dirPath, item.name);
      try {
        if (item.isDirectory()) total += dirSize(full, depth + 1, state);
        else total += fs.statSync(full).size;
      } catch {}
    }
  } catch {}
  return total;
}

module.exports = { startPoller };
