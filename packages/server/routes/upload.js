'use strict';

const express = require('express');
const { v4: uuid } = require('uuid');
const { requireOwner, makeAgentMiddleware, makeAuthMiddleware } = require('../auth');
const { presignUpload, createMultipart, presignPart, completeMultipart, abortMultipart } = require('../r2');

function makeUploadRouter(db, sseBus, jwtSecret) {
  const router = express.Router();
  const agentAuth = makeAgentMiddleware(db);
  const jwtAuth   = makeAuthMiddleware(jwtSecret);

  // ── Agent endpoints (use Agent token, not JWT) ────────────────────────────

  // Register a new upload (agent calls this when it starts uploading a file)
  router.post('/register', agentAuth, (req, res) => {
    const { name, r2_key, size, folder } = req.body || {};
    if (!name || !r2_key) {
      res.status(400).json({ error: 'name and r2_key required' });
      return;
    }
    const folderKey = folder || '';

    // Skip if already available
    const available = db.prepare(`
      SELECT id FROM files WHERE name=? AND folder=? AND status='available' LIMIT 1
    `).get(name, folderKey);
    if (available) {
      console.log(`[upload] Skip (available): ${name}`);
      return res.json({ id: available.id, skip: true });
    }

    // Skip if already uploading and still alive (active upload or queued within 60 min)
    const activeUpload = db.prepare(`
      SELECT id FROM files
      WHERE name=? AND folder=? AND status='uploading'
        AND last_seen_at >= datetime('now', '-60 minutes')
      LIMIT 1
    `).get(name, folderKey);
    if (activeUpload) {
      console.log(`[upload] Skip (active upload): ${name}`);
      return res.json({ id: activeUpload.id, skip: true });
    }

    // Kill any truly stale uploading entries (no heartbeat for 60+ min)
    const stale = db.prepare(`
      SELECT id FROM files
      WHERE name=? AND folder=? AND status='uploading'
        AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-60 minutes'))
    `).all(name, folderKey);
    for (const s of stale) {
      db.prepare(`UPDATE files SET status='deleted' WHERE id=?`).run(s.id);
      sseBus.broadcast('file', db.prepare(`SELECT * FROM files WHERE id=?`).get(s.id));
      console.log(`[upload] Cleared stale upload before re-register: ${s.id}`);
    }

    const id = uuid();
    db.prepare(`
      INSERT INTO files (id, name, r2_key, size, folder, status, upload_progress, last_seen_at)
      VALUES (?, ?, ?, ?, ?, 'uploading', 0, datetime('now'))
    `).run(id, name, r2_key, size || 0, folderKey);

    const file = db.prepare(`SELECT * FROM files WHERE id=?`).get(id);
    sseBus.broadcast('file', file);
    res.json({ id });
  });

  // Heartbeat — agent pings this every 30s to prove the upload is still alive
  router.patch('/:id/heartbeat', agentAuth, (req, res) => {
    db.prepare(`UPDATE files SET last_seen_at=datetime('now') WHERE id=? AND status='uploading'`).run(req.params.id);
    res.json({ ok: true });
  });

  // Update upload progress (also acts as heartbeat)
  router.patch('/:id/progress', agentAuth, (req, res) => {
    const { progress } = req.body || {};
    db.prepare(`UPDATE files SET upload_progress=?, last_seen_at=datetime('now') WHERE id=?`).run(progress, req.params.id);
    sseBus.broadcast('progress', { id: req.params.id, progress });
    res.json({ ok: true });
  });

  // Mark upload complete (only if still uploading — won't revive a cancelled file)
  router.patch('/:id/complete', agentAuth, (req, res) => {
    const { size } = req.body || {};
    db.prepare(`
      UPDATE files SET status='available', upload_progress=100, uploaded_at=datetime('now'), size=COALESCE(?,size)
      WHERE id=? AND status='uploading'
    `).run(size || null, req.params.id);
    const file = db.prepare(`SELECT * FROM files WHERE id=?`).get(req.params.id);
    if (file) sseBus.broadcast('file', file);
    res.json({ ok: true });
  });

  // Mark upload failed
  router.patch('/:id/fail', agentAuth, (req, res) => {
    db.prepare(`UPDATE files SET status='deleted' WHERE id=?`).run(req.params.id);
    sseBus.broadcast('file', db.prepare(`SELECT * FROM files WHERE id=?`).get(req.params.id));
    res.json({ ok: true });
  });

  // Multipart: create upload session
  router.post('/multipart/create', agentAuth, async (req, res) => {
    const { r2_key } = req.body || {};
    if (!r2_key) { res.status(400).json({ error: 'r2_key required' }); return; }
    try {
      const uploadId = await createMultipart(r2_key);
      res.json({ uploadId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Multipart: get presigned URL for a part
  router.post('/multipart/part-url', agentAuth, async (req, res) => {
    const { r2_key, uploadId, partNumber } = req.body || {};
    try {
      const url = await presignPart(r2_key, uploadId, partNumber);
      res.json({ url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Multipart: complete
  router.post('/multipart/complete', agentAuth, async (req, res) => {
    const { r2_key, uploadId, parts } = req.body || {};
    try {
      await completeMultipart(r2_key, uploadId, parts);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Multipart: abort
  router.post('/multipart/abort', agentAuth, async (req, res) => {
    const { r2_key, uploadId } = req.body || {};
    try {
      await abortMultipart(r2_key, uploadId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Presign a simple PUT (agent, for files ≤ 10 MB)
  router.post('/presign', agentAuth, async (req, res) => {
    const { r2_key } = req.body || {};
    if (!r2_key) { res.status(400).json({ error: 'r2_key required' }); return; }
    try {
      const url = await presignUpload(r2_key, 3600);
      res.json({ url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Browser upload endpoints (JWT — editor or owner) ─────────────────────

  // Start a browser upload: register file + return presigned PUT URL
  router.post('/browser/start', jwtAuth, async (req, res) => {
    const { name, size, folder } = req.body || {};
    if (!name) { res.status(400).json({ error: 'name required' }); return; }
    const id    = uuid();
    const ext   = name.slice(name.lastIndexOf('.'));
    const base  = name.slice(0, name.lastIndexOf('.')).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
    const r2Key = (folder ? `${folder}/` : '') + `${Date.now()}-${base}${ext}`;

    db.prepare(`
      INSERT INTO files (id, name, r2_key, size, folder, status, upload_progress)
      VALUES (?, ?, ?, ?, ?, 'uploading', 0)
    `).run(id, name, r2Key, size || 0, folder || '');

    const file = db.prepare(`SELECT * FROM files WHERE id=?`).get(id);
    sseBus.broadcast('file', file);

    try {
      const url = await presignUpload(r2Key, 3600);
      res.json({ id, url, r2Key });
    } catch (err) {
      db.prepare(`UPDATE files SET status='deleted' WHERE id=?`).run(id);
      res.status(500).json({ error: err.message });
    }
  });

  // Browser upload complete
  router.post('/browser/complete/:id', jwtAuth, (req, res) => {
    const { size } = req.body || {};
    db.prepare(`
      UPDATE files SET status='available', upload_progress=100, uploaded_at=datetime('now'), size=COALESCE(?,size)
      WHERE id=?
    `).run(size || null, req.params.id);
    const file = db.prepare(`SELECT * FROM files WHERE id=?`).get(req.params.id);
    sseBus.broadcast('file', file);
    res.json({ ok: true });
  });

  // Browser multipart: create session
  router.post('/browser/multipart/create', jwtAuth, async (req, res) => {
    const { r2_key } = req.body || {};
    if (!r2_key) { res.status(400).json({ error: 'r2_key required' }); return; }
    try { res.json({ uploadId: await createMultipart(r2_key) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Browser multipart: presign a part
  router.post('/browser/multipart/part-url', jwtAuth, async (req, res) => {
    const { r2_key, uploadId, partNumber } = req.body || {};
    try { res.json({ url: await presignPart(r2_key, uploadId, partNumber) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Browser multipart: complete
  router.post('/browser/multipart/complete', jwtAuth, async (req, res) => {
    const { r2_key, uploadId, parts } = req.body || {};
    try { await completeMultipart(r2_key, uploadId, parts); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Browser multipart: abort
  router.post('/browser/multipart/abort', jwtAuth, async (req, res) => {
    const { r2_key, uploadId } = req.body || {};
    try { await abortMultipart(r2_key, uploadId); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Browser upload failed
  router.post('/browser/fail/:id', jwtAuth, (req, res) => {
    db.prepare(`UPDATE files SET status='deleted' WHERE id=?`).run(req.params.id);
    sseBus.broadcast('file', db.prepare(`SELECT * FROM files WHERE id=?`).get(req.params.id));
    res.json({ ok: true });
  });

  // ── Owner endpoints (JWT) ─────────────────────────────────────────────────

  // Get/create agent token (owner only)
  router.get('/agent-token', jwtAuth, requireOwner, (req, res) => {
    let row = db.prepare(`SELECT token FROM agent_tokens LIMIT 1`).get();
    if (!row) {
      const token = require('crypto').randomBytes(32).toString('hex');
      db.prepare(`INSERT INTO agent_tokens (token, label) VALUES (?, 'default')`).run(token);
      row = { token };
    }
    res.json({ token: row.token });
  });

  return router;
}

module.exports = { makeUploadRouter };
