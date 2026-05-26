'use strict';

require('dotenv').config();

process.on('uncaughtException', (err) => {
  console.error('[agent] FATAL uncaughtException:', err);
  killTray();
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[agent] FATAL unhandledRejection:', reason);
  killTray();
  process.exit(1);
});

const path  = require('path');
const fetch = require('node-fetch');
const { startWatcher }    = require('./watcher');
const { startPoller }     = require('./poller');
const { pruneOldResumes } = require('./uploader');
const { startTray, killTray } = require('./tray');

const SERVER_URL  = process.env.FILEDROP_SERVER || 'http://178.104.151.74:3000';
const AGENT_TOKEN = process.env.FILEDROP_AGENT_TOKEN;
const ENV_WATCH_DIR = process.env.FILEDROP_WATCH_DIR || path.join(process.env.HOME || process.env.USERPROFILE, 'FileDrop');

if (!AGENT_TOKEN) {
  console.error('[agent] ERROR: FILEDROP_AGENT_TOKEN is not set.');
  console.error('[agent] Get your token from the FileDrop dashboard → Settings → Agent Token.');
  process.exit(1);
}

pruneOldResumes();
startTray();
startPoller({ serverUrl: SERVER_URL, agentToken: AGENT_TOKEN });

// ── Watch dir management ──────────────────────────────────────────────────────
// On startup: fetch the server-stored watch dir (set via dashboard Settings).
// Falls back to .env / default if server is unreachable or no value is saved.
// Every 30s: re-check and restart the watcher if the dir has changed.

let currentWatchDir  = null;
let watcherController = null;

async function fetchWatchDir() {
  try {
    const res = await fetch(`${SERVER_URL}/api/fs/agent-config`, {
      headers: { Authorization: `Agent ${AGENT_TOKEN}` },
    });
    if (!res.ok) return null;
    const { watchDir } = await res.json();
    return watchDir || null;
  } catch {
    return null;
  }
}

function applyWatchDir(dir) {
  const crashed = watcherController?.healthy === false;
  if (dir === currentWatchDir && !crashed) return;
  if (watcherController) {
    try { watcherController.close(); } catch {}
    watcherController = null;
  }
  if (crashed) console.log(`[agent] Restarting crashed watcher for: ${dir}`);
  currentWatchDir  = dir;
  console.log(`[agent] Watching: ${currentWatchDir}`);
  watcherController = startWatcher({ serverUrl: SERVER_URL, agentToken: AGENT_TOKEN, watchDir: currentWatchDir });
}

async function syncWatchDir() {
  const serverDir = await fetchWatchDir();
  applyWatchDir(serverDir || ENV_WATCH_DIR);
}

console.log(`[agent] Server: ${SERVER_URL}`);

// Initial startup sync — start the watcher as soon as we know the dir.
// fetchWatchDir() catches its own errors, so this should never reject,
// but guard anyway so a bug here doesn't crash the agent silently.
syncWatchDir()
  .catch(err => {
    console.error('[agent] Initial watch-dir sync failed, falling back to default:', err.message);
    applyWatchDir(ENV_WATCH_DIR);
  })
  .then(() => {
    // Poll every 30s so dashboard changes take effect without an agent restart
    setInterval(syncWatchDir, 30000);
  });
