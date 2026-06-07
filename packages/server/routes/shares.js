'use strict';

const express  = require('express');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');
const { makeAuthMiddleware, requireOwner } = require('../auth');
const archiver = require('archiver');
const { presignDownload, getObjectStream } = require('../r2');
const { getCached, setCached } = require('../urlcache');
const { queueZipBuild, deleteShareZip } = require('../zipbuilder');

function makeSharesApiRouter(db, jwtSecret) {
  const router  = express.Router();
  const jwtAuth = makeAuthMiddleware(jwtSecret, db);

  // ── Owner or Editor: create share link ───────────────────────────────────
  router.post('/', jwtAuth, (req, res) => {
    const { folder, label, days = 7 } = req.body || {};
    const token     = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    const shareLabel = label || folder || 'Shared files';
    db.prepare(`
      INSERT INTO share_links (token, folder, label, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(token, folder ?? '', shareLabel, expiresAt);
    // Kick off background ZIP build so it's ready before the client arrives.
    queueZipBuild(db, token, folder ?? '', shareLabel);
    res.json({ token, expiresAt });
  });

  // ── List share links ─────────────────────────────────────────────────────
  router.get('/', jwtAuth, (req, res) => {
    const links = db.prepare(`
      SELECT * FROM share_links WHERE expires_at > datetime('now') ORDER BY created_at DESC
    `).all();
    res.json(links);
  });

  // ── Revoke share link ────────────────────────────────────────────────────
  router.delete('/:id', jwtAuth, (req, res) => {
    const link = db.prepare(`SELECT zip_key FROM share_links WHERE id=?`).get(req.params.id);
    db.prepare(`DELETE FROM share_links WHERE id=?`).run(req.params.id);
    if (link?.zip_key) deleteShareZip(link.zip_key);
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

    const prefix = link.folder;
    const rows = db.prepare(`
      SELECT id, name, size, folder, uploaded_at, created_at, r2_key, thumbnail_key
      FROM files WHERE (folder=? OR folder LIKE ?) AND status='available'
      ORDER BY folder, name
    `).all(prefix, prefix + '/%');

    // Presign thumbnail and full-size URLs for JPEG files (1-hour expiry).
    // URLs are cached in-memory for 55 minutes so repeated page loads don't
    // hit R2 for every image on every visit.
    const PRESIGN_TTL = 3600;
    const files = await Promise.all(rows.map(async f => {
      const ext = (f.name || '').split('.').pop().toLowerCase();
      const isImage = ext === 'jpg' || ext === 'jpeg';
      const out = { id: f.id, name: f.name, size: f.size, uploaded_at: f.uploaded_at, created_at: f.created_at, isImage };
      if (isImage) {
        if (f.thumbnail_key) {
          let url = getCached(f.thumbnail_key);
          if (!url) {
            try { url = await presignDownload(f.thumbnail_key, PRESIGN_TTL); setCached(f.thumbnail_key, url, PRESIGN_TTL); } catch {}
          }
          if (url) out.thumbnailUrl = url;
        }
        const dlKey = `dl:${f.r2_key}`;
        let fullUrl = getCached(dlKey);
        if (!fullUrl) {
          try { fullUrl = await presignDownload(f.r2_key, PRESIGN_TTL, f.name); setCached(dlKey, fullUrl, PRESIGN_TTL); } catch {}
        }
        if (fullUrl) out.fullUrl = fullUrl;
      }
      return out;
    }));

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

  // ── Public: ZIP status polling (used by share page while ZIP is building) ──
  router.get('/:token/zip-status', (req, res) => {
    const link = db.prepare(`
      SELECT zip_status FROM share_links WHERE token=? AND expires_at > datetime('now')
    `).get(req.params.token);
    if (!link) { res.status(404).json({ status: 'none' }); return; }
    res.json({ status: link.zip_status || 'none' });
  });

  // ── Public: download all files as a ZIP (preserves subfolder structure) ──
  router.get('/:token/zip', async (req, res) => {
    const link = db.prepare(`
      SELECT * FROM share_links WHERE token=? AND expires_at > datetime('now')
    `).get(req.params.token);
    if (!link) { res.status(404).send('Link expired'); return; }

    // Fast path: ZIP already built — redirect to presigned R2 URL (instant download).
    if (link.zip_status === 'ready' && link.zip_key) {
      try {
        const zipName = (link.label || link.folder || 'files').replace(/[^a-zA-Z0-9._\- ]/g, '_');
        const url = await presignDownload(link.zip_key, 3600, `${zipName}.zip`);
        res.redirect(302, url);
        return;
      } catch (err) {
        console.error('[zip] presign failed, falling back to stream:', err.message);
      }
    }

    const prefix = link.folder;
    const files = db.prepare(`
      SELECT id, name, r2_key, folder FROM files
      WHERE (folder=? OR folder LIKE ?) AND status='available'
      ORDER BY folder, name
    `).all(prefix, prefix + '/%');
    if (!files.length) { res.status(404).send('No files'); return; }

    const zipName = (link.label || link.folder || 'files').replace(/[^a-zA-Z0-9._\- ]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}.zip"`);

    // store:true skips zlib entirely — video/photo files are already compressed
    const archive = archiver('zip', { store: true });
    archive.pipe(res);
    archive.on('error', err => { console.error('[zip] share archive error:', err.message); res.end(); });

    console.log(`[zip] share start token=${req.params.token} files=${files.length}`);

    // Pipeline: pre-fetch the next R2 stream while archiver writes the current one,
    // so network round-trips don't stack. Never open more than one ahead to avoid
    // idle-timeout on connections that wait too long before archiver reaches them.
    let nextFetch = files.length > 0 ? getObjectStream(files[0].r2_key).catch(e => e) : null;

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const streamOrErr = await nextFetch;
      nextFetch = (i + 1 < files.length) ? getObjectStream(files[i + 1].r2_key).catch(e => e) : null;

      if (streamOrErr instanceof Error) {
        console.error(`[zip] share skipping ${f.name}:`, streamOrErr.message);
        continue;
      }
      try {
        const relFolder = prefix
          ? (f.folder === prefix ? '' : f.folder.slice(prefix.length + 1))
          : f.folder;
        const archivePath = relFolder ? `${relFolder}/${f.name}` : f.name;
        await new Promise((resolve, reject) => {
          streamOrErr.on('error', reject);
          archive.append(streamOrErr, { name: archivePath });
          archive.once('entry', resolve);
        });
      } catch (err) {
        console.error(`[zip] share skipping ${f.name}:`, err.message);
      }
    }

    console.log(`[zip] share finalizing token=${req.params.token}`);
    await archive.finalize();
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
