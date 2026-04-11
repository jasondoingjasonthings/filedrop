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
      // Expand any folders recursively to get all files
      const allFiles = [];
      for (const p of paths) {
        expandPath(p, allFiles);
      }
      for (const filePath of allFiles) {
        const name = path.basename(filePath);
        uploadFile({ serverUrl, agentToken, filePath, name, folder: folder || '' })
          .catch(err => console.error(`[poller] Upload failed ${name}:`, err.message));
      }
      result = { queued: allFiles.length };
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
  } catch {}
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
