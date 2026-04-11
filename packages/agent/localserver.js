'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.FILEDROP_LOCAL_PORT || 3001;

function startLocalServer({ serverUrl, agentToken }) {
  const { uploadFile } = require('./uploader');

  // Active uploads: id → { name, progress, status }
  const activeUploads = new Map();
  let uploadIdCounter = 0;

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }

  function json(res, code, data) {
    cors(res);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  const server = http.createServer((req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url  = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const { pathname } = url;

    // ── GET /ping ──
    if (req.method === 'GET' && pathname === '/ping') {
      return json(res, 200, { ok: true });
    }

    // ── GET /browse ──
    if (req.method === 'GET' && pathname === '/browse') {
      const reqPath = url.searchParams.get('path') || '';
      try {
        const entries = reqPath ? listDir(reqPath) : getRoots();
        return json(res, 200, { path: reqPath, entries });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    // ── POST /upload ──
    if (req.method === 'POST' && pathname === '/upload') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { paths, folder } = JSON.parse(body);
          if (!Array.isArray(paths) || !paths.length) throw new Error('paths required');

          const queued = [];
          for (const filePath of paths) {
            const id = ++uploadIdCounter;
            const name = path.basename(filePath);
            activeUploads.set(id, { id, name, filePath, progress: 0, status: 'queued' });
            queued.push(id);

            // Run in background
            const record = activeUploads.get(id);
            record.status = 'uploading';
            uploadFile({ serverUrl, agentToken, filePath, name, folder: folder || '' })
              .then(() => { record.status = 'done'; record.progress = 100; })
              .catch(err => { record.status = 'error'; record.error = err.message; });
          }

          return json(res, 200, { queued });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      });
      return;
    }

    // ── GET /uploads ──
    if (req.method === 'GET' && pathname === '/uploads') {
      return json(res, 200, { uploads: [...activeUploads.values()] });
    }

    res.writeHead(404); res.end();
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[localserver] http://127.0.0.1:${PORT}`);
  });

  return server;
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
      return { name: item.name, path: fullPath, isDir, size };
    })
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}

module.exports = { startLocalServer };
