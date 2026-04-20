'use strict';

const express  = require('express');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const { makeAuthMiddleware, requireOwner } = require('../auth');
const { presignDownload } = require('../r2');

function makeSharesApiRouter(db, jwtSecret) {
  const router  = express.Router();
  const jwtAuth = makeAuthMiddleware(jwtSecret);

  // ── Owner or Editor: create share link ───────────────────────────────────
  router.post('/', jwtAuth, (req, res) => {
    const { folder, label, days = 7 } = req.body || {};
    const token     = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    db.prepare(`
      INSERT INTO share_links (token, folder, label, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(token, folder ?? '', label || folder || 'Shared files', expiresAt);
    res.json({ token, expiresAt });
  });

  // ── Owner: list share links ───────────────────────────────────────────────
  router.get('/', jwtAuth, requireOwner, (req, res) => {
    const links = db.prepare(`
      SELECT * FROM share_links WHERE expires_at > datetime('now') ORDER BY created_at DESC
    `).all();
    res.json(links);
  });

  // ── Owner: revoke share link ──────────────────────────────────────────────
  router.delete('/:id', jwtAuth, requireOwner, (req, res) => {
    db.prepare(`DELETE FROM share_links WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  });

  return router;
}

function makeSharesPublicRouter(db) {
  const router = express.Router();

  // ── Public: share page ────────────────────────────────────────────────────
  router.get('/:token', (req, res) => {
    const link = db.prepare(`
      SELECT * FROM share_links WHERE token=? AND expires_at > datetime('now')
    `).get(req.params.token);

    if (!link) {
      res.status(404).send('<h2>This link has expired or does not exist.</h2>');
      return;
    }

    res.setHeader('Content-Type', 'text/html');
    res.send(fs.readFileSync(path.join(__dirname, '../html/share.html'), 'utf-8'));
  });

  // ── Public: get files for share token ────────────────────────────────────
  router.get('/:token/files', async (req, res) => {
    const link = db.prepare(`
      SELECT * FROM share_links WHERE token=? AND expires_at > datetime('now')
    `).get(req.params.token);

    if (!link) { res.status(404).json({ error: 'Link expired or not found' }); return; }

    const files = db.prepare(`
      SELECT id, name, size, folder, uploaded_at, created_at
      FROM files WHERE folder=? AND status='available'
      ORDER BY created_at DESC
    `).all(link.folder);

    res.json({ label: link.label, folder: link.folder, expiresAt: link.expires_at, files });
  });

  // ── Public: generate presigned download URL (kept for legacy) ───────────────
  router.post('/:token/download/:fileId', async (req, res) => {
    const link = db.prepare(`
      SELECT * FROM share_links WHERE token=? AND expires_at > datetime('now')
    `).get(req.params.token);
    if (!link) { res.status(404).json({ error: 'Link expired' }); return; }

    const file = db.prepare(`
      SELECT * FROM files WHERE id=? AND folder=? AND status='available'
    `).get(req.params.fileId, link.folder);
    if (!file) { res.status(404).json({ error: 'File not found' }); return; }

    const url = await presignDownload(file.r2_key, 3600, file.name);
    res.json({ url, name: file.name });
  });

  // ── Public: same-origin redirect — browser follows to R2 with Content-Disposition
  // This lets a.download work (same-origin) and avoids any save dialog.
  router.get('/:token/dl/:fileId', async (req, res) => {
    const link = db.prepare(`
      SELECT * FROM share_links WHERE token=? AND expires_at > datetime('now')
    `).get(req.params.token);
    if (!link) { res.status(404).send('Link expired'); return; }

    const file = db.prepare(`
      SELECT * FROM files WHERE id=? AND folder=? AND status='available'
    `).get(req.params.fileId, link.folder);
    if (!file) { res.status(404).send('File not found'); return; }

    try {
      const url = await presignDownload(file.r2_key, 300, file.name);
      res.redirect(302, url);
    } catch (err) {
      res.status(500).send('Failed to generate download URL');
    }
  });

  return router;
}

module.exports = { makeSharesApiRouter, makeSharesPublicRouter };
