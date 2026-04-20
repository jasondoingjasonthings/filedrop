'use strict';

require('dotenv').config();

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

app.use(express.json({ limit: '10mb' }));

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

// SSE — uses token query param (EventSource can't set headers)
app.get('/api/events', (req, res) => {
  const token = req.query.token;
  if (!token) { res.status(401).end(); return; }
  try {
    verifyToken(token, JWT_SECRET);
  } catch {
    res.status(401).end();
    return;
  }
  const cleanup = sseBus.connect(res);
  req.on('close', cleanup);
});

const auth = makeAuthMiddleware(JWT_SECRET);

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
