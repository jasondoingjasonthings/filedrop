'use strict';

const chokidar = require('chokidar');
const path     = require('path');
const fs       = require('fs');
const { uploadFile } = require('./uploader');
const { setStatus }  = require('./tray');

const DEBOUNCE_MS   = 2000; // wait 2s after last change before uploading
const FILE_CONCURRENCY = 4; // max files uploading simultaneously

function startWatcher({ serverUrl, agentToken, watchDir }) {
  if (!fs.existsSync(watchDir)) {
    fs.mkdirSync(watchDir, { recursive: true });
    console.log(`[watcher] Created watch directory: ${watchDir}`);
  }

  // ── Upload queue ──────────────────────────────────────────────────────────
  // Initial scan files are collected, sorted smallest→largest, then drained.
  // Files added/changed after ready go straight to the active queue.

  let initialScanDone = false;
  const initialBatch  = []; // { filePath, size } — collected during initial scan
  const pending       = new Map(); // filePath → debounce timer
  let   active        = 0;
  const queue         = []; // { filePath } waiting to start

  function enqueue(filePath) {
    queue.push(filePath);
    drain();
  }

  function drain() {
    while (active < FILE_CONCURRENCY && queue.length > 0) {
      const filePath = queue.shift();
      active++;
      updateTrayStatus();
      runUpload(filePath).finally(() => {
        active--;
        drain();
        updateTrayStatus();
      });
    }
    if (active === 0 && queue.length === 0) updateTrayStatus();
  }

  function updateTrayStatus() {
    const total = active + queue.length;
    setStatus(total > 0 ? 'uploading' : 'idle', total);
  }

  async function runUpload(filePath) {
    const rel    = path.relative(watchDir, filePath);
    const parts  = rel.split(path.sep);
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    const name   = path.basename(filePath);
    try {
      await uploadFile({ serverUrl, agentToken, filePath, name, folder });
    } catch (err) {
      console.error(`[watcher] Upload failed for ${rel}:`, err.message);
      setStatus('error');
      // Clear error state after 10s so it doesn't stick permanently
      setTimeout(() => updateTrayStatus(), 10_000);
    }
  }

  // ── Chokidar ──────────────────────────────────────────────────────────────

  const watcher = chokidar.watch(watchDir, {
    persistent: true,
    ignoreInitial: false,
    ignored: /(^|[/\\])\../,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 500,
    },
  });

  watcher.on('add', (filePath) => {
    if (!initialScanDone) {
      // Collect with size for sorting
      try {
        const size = fs.statSync(filePath).size;
        initialBatch.push({ filePath, size });
      } catch {
        initialBatch.push({ filePath, size: 0 });
      }
    } else {
      scheduleUpload(filePath);
    }
  });

  watcher.on('change', (filePath) => scheduleUpload(filePath));

  watcher.on('ready', () => {
    initialScanDone = true;
    // Sort smallest → largest so quick files appear in the dashboard first
    initialBatch.sort((a, b) => a.size - b.size);
    console.log(`[watcher] Ready. Queuing ${initialBatch.length} file(s) smallest→largest (${FILE_CONCURRENCY} at a time)`);
    for (const { filePath } of initialBatch) {
      const rel = path.relative(watchDir, filePath);
      console.log(`[watcher] add: ${rel}`);
      enqueue(filePath);
    }
    initialBatch.length = 0;
  });

  const controller = { close, healthy: true };

  watcher.on('error', (err) => {
    console.error('[watcher] Error (will restart on next sync):', err.message);
    controller.healthy = false;
  });

  function close() {
    watcher.close();
    console.log(`[watcher] Stopped watching: ${watchDir}`);
  }

  function scheduleUpload(filePath) {
    if (pending.has(filePath)) clearTimeout(pending.get(filePath));
    const timer = setTimeout(() => {
      pending.delete(filePath);
      const rel = path.relative(watchDir, filePath);
      console.log(`[watcher] change: ${rel}`);
      enqueue(filePath);
    }, DEBOUNCE_MS);
    pending.set(filePath, timer);
  }

  return controller;
}

module.exports = { startWatcher };
