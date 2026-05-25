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
const { rateLimit } = require('express-rate-limit');

const { getDb, ownerExists } = require('./db');
const { makeAuthMiddleware, verifyToken } = require('./auth');
const { SseBus } = require('./sse');
const { startCleanup } = require('./cleanup');
const { startBackup } = require('./backup');
const { makeAuthRouter } = require('./routes/auth');
const { makeFilesRouter } = require('./routes/files');
const { makeUploadRouter } = require('./routes/upload');
const { makeUsersRouter } = require('./routes/users');
const { makeSetupRouter } = require('./routes/setup');
const { makeFsRouter }    = require('./routes/fs');
const { makeSharesApiRouter, makeSharesPublicRouter } = require('./routes/shares');
const { makeUploadLinksRouter } = require('./routes/uploadlinks');
const { makeRequestsRouter }   = require('./routes/requests');
const { makeTranscodeRouter }  = require('./routes/transcode');
const { startTranscodeScheduler } = require('./transcode');
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
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, uptime: Math.floor(process.uptime()), clients: sseBus.size });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

// ── Rate limiting ────────────────────────────────────────────────────────────
// Auth and upload-start are the most abuse-prone endpoints; everything else
// is covered by the auth middleware (only valid JWT holders can reach it).
const uploadStartLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down' },
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

// Audit log (owner only) — paginated, newest first
app.get('/api/audit', auth, (req, res) => {
  const user = req.user;
  if (user.role !== 'owner') { res.status(403).json({ error: 'Owner only' }); return; }
  const limit  = Math.min(parseInt(req.query.limit  || '100', 10), 500);
  const offset = parseInt(req.query.offset || '0', 10);
  const rows = db.prepare(`
    SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
  const total = db.prepare(`SELECT COUNT(*) as n FROM audit_log`).get().n;
  res.json({ rows, total, limit, offset });
});

app.use('/api/auth',   makeAuthRouter(db, JWT_SECRET));
app.use('/api/files',  auth, makeFilesRouter(db, sseBus));
app.use('/api/upload/browser/start',            uploadStartLimiter);
app.use('/api/upload/browser/multipart/create', uploadStartLimiter);
app.use('/api/upload', makeUploadRouter(db, sseBus, JWT_SECRET));   // mixed: agent + JWT per route
app.use('/api/users',  auth, makeUsersRouter(db));
app.use('/api/fs',    makeFsRouter(db, JWT_SECRET));
app.use('/api/shares', makeSharesApiRouter(db, JWT_SECRET));
app.use('/share',      makeSharesPublicRouter(db));
app.use('/upload',        makeUploadLinksRouter(db, sseBus, JWT_SECRET));
app.use('/api/requests',  makeRequestsRouter(db, JWT_SECRET));
app.use('/api/transcode', makeTranscodeRouter(db, JWT_SECRET));

// Serve dashboard HTML
const HTML_DIR = path.join(__dirname, 'html');
app.get('/', (req, res) => {
  if (!ownerExists(db)) { res.redirect('/setup'); return; }
  let html;
  try {
    html = fs.readFileSync(path.join(HTML_DIR, 'dashboard.html'), 'utf-8');
  } catch (err) {
    console.error('[filedrop] Could not read dashboard.html:', err.message);
    res.status(503).send('Dashboard temporarily unavailable — check server logs');
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
});

// Start cleanup, transcode scheduler, and daily backup
startCleanup(db, sseBus);
startTranscodeScheduler(db, sseBus);
startBackup(db);

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[filedrop] http://0.0.0.0:${PORT}`);
  if (!ownerExists(db)) {
    console.log(`[filedrop] First run — visit http://localhost:${PORT}/setup`);
  }
});

// Graceful shutdown — PM2 sends SIGINT on restart/stop.
// Stop accepting new connections, drain in-flight requests, then exit.
function gracefulShutdown(signal) {
  console.log(`[filedrop] ${signal} received — draining connections`);
  server.close(() => {
    console.log('[filedrop] All connections closed, exiting');
    process.exit(0);
  });
  // Force-exit after 30 s so a stuck request never blocks a deploy
  setTimeout(() => {
    console.error('[filedrop] Shutdown timeout — forcing exit');
    process.exit(1);
  }, 30_000).unref();
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
