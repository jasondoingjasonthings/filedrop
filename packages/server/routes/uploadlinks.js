'use strict';

const express = require('express');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');
const { v4: uuid } = require('uuid');
const { makeAuthMiddleware, requireOwner } = require('../auth');
const { presignUpload, createMultipart, presignPart, completeMultipart, abortMultipart } = require('../r2');

function makeUploadLinksRouter(db, sseBus, jwtSecret) {
  const router  = express.Router();
  const jwtAuth = makeAuthMiddleware(jwtSecret);

  // ── Owner or Editor: create upload link ──────────────────────────────────
  router.post('/', jwtAuth, (req, res) => {
    const { folder, label, days = 7 } = req.body || {};
    if (!folder) { res.status(400).json({ error: 'folder is required' }); return; }
    const token     = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    db.prepare(`
      INSERT INTO upload_links (token, folder, label, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(token, folder, label || folder, expiresAt);
    res.json({ token, expiresAt });
  });

  // ── Owner or Editor: list upload links ───────────────────────────────────
  router.get('/', jwtAuth, (req, res) => {
    const links = db.prepare(`
      SELECT * FROM upload_links WHERE expires_at > datetime('now') ORDER BY created_at DESC
    `).all();
    res.json(links);
  });

  // ── Owner or Editor: revoke upload link ──────────────────────────────────
  router.delete('/:id', jwtAuth, (req, res) => {
    db.prepare(`DELETE FROM upload_links WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  });

  // ── Public: serve upload page ─────────────────────────────────────────────
  router.get('/:token', (req, res) => {
    const link = db.prepare(`
      SELECT * FROM upload_links WHERE token=? AND expires_at > datetime('now')
    `).get(req.params.token);
    if (!link) { res.status(404).send('<h2>This upload link has expired or does not exist.</h2>'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.send(fs.readFileSync(path.join(__dirname, '../html/upload.html'), 'utf-8'));
  });

  // ── Public: get link info ─────────────────────────────────────────────────
  router.get('/:token/info', (req, res) => {
    const link = db.prepare(`
      SELECT id, folder, label, expires_at FROM upload_links WHERE token=? AND expires_at > datetime('now')
    `).get(req.params.token);
    if (!link) { res.status(404).json({ error: 'Link expired or not found' }); return; }
    res.json(link);
  });

  // ── Public: start upload ──────────────────────────────────────────────────
  router.post('/:token/start', async (req, res) => {
    const link = db.prepare(`
      SELECT * FROM upload_links WHERE token=? AND expires_at > datetime('now')
    `).get(req.params.token);
    if (!link) { res.status(404).json({ error: 'Link expired' }); return; }

    const { name, size } = req.body || {};
    if (!name) { res.status(400).json({ error: 'name required' }); return; }

    const id     = uuid();
    const dotIdx = name.lastIndexOf('.');
    const ext    = dotIdx > 0 ? name.slice(dotIdx) : '';
    const base   = (dotIdx > 0 ? name.slice(0, dotIdx) : name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
    const r2Key  = `${link.folder}/${Date.now()}-${base}${ext}`;

    db.prepare(`
      INSERT INTO files (id, name, r2_key, size, folder, status, upload_progress)
      VALUES (?, ?, ?, ?, ?, 'uploading', 0)
    `).run(id, name, r2Key, size || 0, link.folder);

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

  // ── Public: complete upload ───────────────────────────────────────────────
  router.post('/:token/complete/:id', (req, res) => {
    const link = db.prepare(`
      SELECT * FROM upload_links WHERE token=? AND expires_at > datetime('now')
    `).get(req.params.token);
    if (!link) { res.status(404).json({ error: 'Link expired' }); return; }

    const file = db.prepare(`SELECT * FROM files WHERE id=?`).get(req.params.id);
    if (!file || file.folder !== link.folder) { res.status(404).json({ error: 'File not found' }); return; }

    const { size } = req.body || {};
    db.prepare(`
      UPDATE files SET status='available', upload_progress=100, uploaded_at=datetime('now'), size=COALESCE(?,size)
      WHERE id=?
    `).run(size || null, req.params.id);
    const updated = db.prepare(`SELECT * FROM files WHERE id=?`).get(req.params.id);
    sseBus.broadcast('file', updated);
    res.json({ ok: true });
  });

  // ── Public: fail upload ───────────────────────────────────────────────────
  router.post('/:token/fail/:id', (req, res) => {
    const link = db.prepare(`
      SELECT * FROM upload_links WHERE token=? AND expires_at > datetime('now')
    `).get(req.params.token);
    if (!link) { res.status(404).json({ error: 'Link expired' }); return; }

    const file = db.prepare(`SELECT * FROM files WHERE id=?`).get(req.params.id);
    if (!file || file.folder !== link.folder) { res.status(404).json({ error: 'File not found' }); return; }

    db.prepare(`UPDATE files SET status='deleted' WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  });

  // ── Public: multipart create ──────────────────────────────────────────────
  router.post('/:token/multipart/create', async (req, res) => {
    const link = db.prepare(`SELECT * FROM upload_links WHERE token=? AND expires_at > datetime('now')`).get(req.params.token);
    if (!link) { res.status(404).json({ error: 'Link expired' }); return; }
    const { r2_key } = req.body || {};
    try { res.json({ uploadId: await createMultipart(r2_key) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Public: multipart part-url ────────────────────────────────────────────
  router.post('/:token/multipart/part-url', async (req, res) => {
    const link = db.prepare(`SELECT * FROM upload_links WHERE token=? AND expires_at > datetime('now')`).get(req.params.token);
    if (!link) { res.status(404).json({ error: 'Link expired' }); return; }
    const { r2_key, uploadId, partNumber } = req.body || {};
    try { res.json({ url: await presignPart(r2_key, uploadId, partNumber) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Public: multipart complete ────────────────────────────────────────────
  router.post('/:token/multipart/complete', async (req, res) => {
    const link = db.prepare(`SELECT * FROM upload_links WHERE token=? AND expires_at > datetime('now')`).get(req.params.token);
    if (!link) { res.status(404).json({ error: 'Link expired' }); return; }
    const { r2_key, uploadId, parts } = req.body || {};
    try { await completeMultipart(r2_key, uploadId, parts); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Public: multipart abort ───────────────────────────────────────────────
  router.post('/:token/multipart/abort', async (req, res) => {
    const link = db.prepare(`SELECT * FROM upload_links WHERE token=? AND expires_at > datetime('now')`).get(req.params.token);
    if (!link) { res.status(404).json({ error: 'Link expired' }); return; }
    const { r2_key, uploadId } = req.body || {};
    try { await abortMultipart(r2_key, uploadId); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  return router;
}

module.exports = { makeUploadLinksRouter };
