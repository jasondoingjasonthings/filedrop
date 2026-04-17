'use strict';

require('dotenv').config();

const path = require('path');
const { startWatcher } = require('./watcher');
const { startPoller }  = require('./poller');
const { pruneOldResumes } = require('./uploader');

const SERVER_URL  = process.env.FILEDROP_SERVER || 'http://178.104.151.74:3000';
const AGENT_TOKEN = process.env.FILEDROP_AGENT_TOKEN;
const WATCH_DIR   = process.env.FILEDROP_WATCH_DIR || path.join(process.env.HOME || process.env.USERPROFILE, 'FileDrop');

if (!AGENT_TOKEN) {
  console.error('[agent] ERROR: FILEDROP_AGENT_TOKEN is not set.');
  console.error('[agent] Get your token from the FileDrop dashboard → Settings → Agent Token.');
  process.exit(1);
}

console.log(`[agent] Server  : ${SERVER_URL}`);
console.log(`[agent] Watching: ${WATCH_DIR}`);

// Clean up stale resume files from previous sessions (R2 multipart expires at 7 days)
pruneOldResumes();

// Poll server for browse/upload commands from the dashboard
startPoller({ serverUrl: SERVER_URL, agentToken: AGENT_TOKEN });

// Auto-upload anything dropped into the watch folder
startWatcher({ serverUrl: SERVER_URL, agentToken: AGENT_TOKEN, watchDir: WATCH_DIR });
