'use strict';

const chokidar = require('chokidar');
const path     = require('path');
const fs       = require('fs');
const { uploadFile } = require('./uploader');

const DEBOUNCE_MS = 2000; // wait 2s after last change before uploading

function startWatcher({ serverUrl, agentToken, watchDir }) {
  // Create watch dir if it doesn't exist
  if (!fs.existsSync(watchDir)) {
    fs.mkdirSync(watchDir, { recursive: true });
    console.log(`[watcher] Created watch directory: ${watchDir}`);
  }

  const pending = new Map(); // filePath → timeout

  const watcher = chokidar.watch(watchDir, {
    persistent: true,
    ignoreInitial: false,
    ignored: /(^|[/\\])\../, // ignore dotfiles
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 500,
    },
  });

  watcher.on('add', (filePath) => scheduleUpload(filePath, 'add'));
  watcher.on('change', (filePath) => scheduleUpload(filePath, 'change'));

  watcher.on('error', (err) => {
    console.error('[watcher] Error:', err);
  });

  console.log('[watcher] Ready.');

  function scheduleUpload(filePath, event) {
    if (pending.has(filePath)) {
      clearTimeout(pending.get(filePath));
    }
    const timer = setTimeout(() => {
      pending.delete(filePath);
      handleFile(filePath, event);
    }, DEBOUNCE_MS);
    pending.set(filePath, timer);
  }

  async function handleFile(filePath, event) {
    // Derive folder from relative path (e.g. watchDir/ProjectX/file.zip → folder=ProjectX)
    const rel    = path.relative(watchDir, filePath);
    const parts  = rel.split(path.sep);
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    const name   = path.basename(filePath);

    console.log(`[watcher] ${event}: ${rel}`);

    try {
      await uploadFile({ serverUrl, agentToken, filePath, name, folder });
    } catch (err) {
      console.error(`[watcher] Upload failed for ${rel}:`, err.message);
    }
  }
}

module.exports = { startWatcher };
