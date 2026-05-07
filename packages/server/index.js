'use strict';

require('dotenv').config();

// Must be first — catch anything that slips past route-level error handling.
// PM2 will restart the process after exit(1).
process.on('uncaughtException', (err) => {
  console.error('[filedrop] FATAL uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[filedrop] FATAL unhandledRejection:', reason);
  process.exit(1);
});

const express = require('express');
const fs = require('fs');
const path = require('path');

const { getDb, ownerExists } = require('./db');
const { makeAuthMiddleware, verifyToken } = require('./auth');
const { SseBus } = require('./sse');
const { startCleanup } = require('./cleanup');
const { makeAuthRouter } = require('./routes/auth');
const { makeFilesRouter } = require('./routes/files');
const { makeUploadRouter } = require('./routes/upload');
const { makeUsersRouter } = require('./routes/users');
const { makeSetupRouter } = require('./routes/setup');
const { makeFsRouter }    = require('./routes/fs');
const { makeSharesApiRouter, makeSharesPublicRouter } = require('./routes/shares');
const { makeUploadLinksRouter } = require('./routes/uploadlinks');
const { makeRequestsRouter }   = require('./routes/requests');
const { presignDownload }      = require('./r2');

const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET env var is required');

const app    = express();
const db     = getDb();
const sseBus = new SseBus();

// Trust the nginx reverse proxy so req.ip reflects the real client address.
app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb' }));

// Request logger — one line per request with method, path, status, and duration
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms  = Date.now() - start;
    const lvl = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO';
    console.log(`[${lvl}] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// Setup wizard (pre-auth)
app.use('/setup', makeSetupRouter(db));

// Redirect to setup if no owner
app.use((req, res, next) => {
  if (!ownerExists(db) && !req.path.startsWith('/setup') && !req.path.startsWith('/api/setup')) {
    res.redirect('/setup');
    return;
  }
  next();
});

// Health check — used by monitoring and PM2 readiness checks
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), clients: sseBus.size });
});

// Simple in-memory rate limiter for the SSE endpoint.
// Prevents token-brute-force via rapid reconnects (each attempt hits the DB).
const _sseIpLog = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, times] of _sseIpLog) {
    const trimmed = times.filter(t => t > cutoff);
    if (trimmed.length === 0) _sseIpLog.delete(ip);
    else _sseIpLog.set(ip, trimmed);
  }
}, 120_000).unref();

function sseRateLimited(ip) {
  const now = Date.now();
  const times = (_sseIpLog.get(ip) || []).filter(t => now - t < 60_000);
  times.push(now);
  _sseIpLog.set(ip, times);
  return times.length > 30; // 30 connection attempts per minute per IP
}

// SSE — uses token query param (EventSource can't set headers)
app.get('/api/events', (req, res) => {
  if (sseRateLimited(req.ip)) { res.status(429).end(); return; }
  const token = req.query.token;
  if (!token) { res.status(401).end(); return; }
  let decoded;
  try {
    decoded = verifyToken(token, JWT_SECRET);
  } catch {
    res.status(401).end();
    return;
  }
  if (decoded?.jti) {
    const revoked = db.prepare(`SELECT 1 FROM revoked_tokens WHERE jti=?`).get(decoded.jti);
    if (revoked) { res.status(401).end(); return; }
  }
  const cleanup = sseBus.connect(res);
  req.on('close', cleanup);
});

const auth = makeAuthMiddleware(JWT_SECRET, db);

// Same-origin download redirect — accepts ?token= so iframes/anchors can trigger downloads
// without needing Authorization headers (which iframes cannot set)
app.get('/api/files/:id/dl', async (req, res) => {
  const tok = req.query.token;
  if (!tok) { res.status(401).send('Missing token'); return; }
  try { verifyToken(tok, JWT_SECRET); } catch { res.status(401).send('Invalid token'); return; }
  const file = db.prepare(`SELECT * FROM files WHERE id=? AND status='available'`).get(req.params.id);
  if (!file) { res.status(404).send('File not found'); return; }
  try {
    const url = await presignDownload(file.r2_key, 300, file.name);
    res.redirect(302, url);
  } catch (err) {
    res.status(500).send('Failed to generate download URL');
  }
});

app.use('/api/auth',   makeAuthRouter(db, JWT_SECRET));
app.use('/api/files',  auth, makeFilesRouter(db, sseBus));
app.use('/api/upload', makeUploadRouter(db, sseBus, JWT_SECRET));   // mixed: agent + JWT per route
app.use('/api/users',  auth, makeUsersRouter(db));
app.use('/api/fs',    makeFsRouter(db, JWT_SECRET));
app.use('/api/shares', makeSharesApiRouter(db, JWT_SECRET));
app.use('/share',      makeSharesPublicRouter(db));
app.use('/upload',        makeUploadLinksRouter(db, sseBus, JWT_SECRET));
app.use('/api/requests',  makeRequestsRouter(db, JWT_SECRET));

// Serve dashboard HTML
const HTML_DIR = path.join(__dirname, 'html');
app.get('/', (req, res) => {
  if (!ownerExists(db)) { res.redirect('/setup'); return; }
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store');
  res.send(fs.readFileSync(path.join(HTML_DIR, 'dashboard.html'), 'utf-8'));
});

// Start cleanup job
startCleanup(db, sseBus);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[filedrop] http://0.0.0.0:${PORT}`);
  if (!ownerExists(db)) {
    console.log(`[filedrop] First run — visit http://localhost:${PORT}/setup`);
  }
});
