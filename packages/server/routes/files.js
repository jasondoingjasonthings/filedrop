'use strict';

const express = require('express');
const { requireOwner } = require('../auth');
const { presignDownload, deleteObject } = require('../r2');

function makeFilesRouter(db, sseBus) {
  const router = express.Router();

  // Folder summaries — fast endpoint for initial page load
  router.get('/folders', (req, res) => {
    const rows = db.prepare(`
      SELECT
        folder,
        COUNT(*) as file_count,
        SUM(size) as total_size,
        MAX(COALESCE(uploaded_at, created_at)) as latest_at,
        SUM(CASE WHEN status='uploading'  THEN 1 ELSE 0 END) as uploading_count,
        SUM(CASE WHEN status='available'  THEN 1 ELSE 0 END) as available_count,
        SUM(CASE WHEN status='downloaded' THEN 1 ELSE 0 END) as downloaded_count
      FROM files
      WHERE status NOT IN ('deleted', 'deleting')
      GROUP BY folder
      ORDER BY MAX(COALESCE(uploaded_at, created_at)) DESC
    `).all();
    res.json(rows);
  });

  // Files in a specific folder (used when expanding a folder)
  router.get('/in', (req, res) => {
    const folder = req.query.folder ?? '';
    const list = req.user.role === 'owner'
      ? db.prepare(`SELECT * FROM files WHERE folder=? AND status NOT IN ('deleted','deleting') ORDER BY created_at DESC`).all(folder)
      : db.prepare(`SELECT * FROM files WHERE folder=? AND status NOT IN ('deleted','deleting') ORDER BY created_at DESC`).all(folder);
    res.json(list);
  });

  // List all files — kept for SSE token validation only; returns empty array to avoid heavy load
  router.get('/', (req, res) => {
    res.json([]);
  });

  // Get a single file
  router.get('/:id', (req, res) => {
    const file = db.prepare(`SELECT * FROM files WHERE id=?`).get(req.params.id);
    if (!file) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(file);
  });

  // Editor downloads a file — generate presigned URL + log download
  router.post('/:id/download', async (req, res) => {
    const file = db.prepare(`SELECT * FROM files WHERE id=?`).get(req.params.id);
    if (!file || file.status === 'deleted') {
      res.status(404).json({ error: 'File not found or deleted' });
      return;
    }

    try {
      const url = await presignDownload(file.r2_key, 3600);

      // On first download: record who downloaded it — status stays 'available' so
      // multiple editors can download and the file is never auto-deleted.
      if (!file.downloaded_at) {
        db.prepare(`
          UPDATE files
          SET downloaded_by=?, downloaded_at=datetime('now')
          WHERE id=?
        `).run(req.user.sub, file.id);

        const updated = db.prepare(`SELECT * FROM files WHERE id=?`).get(file.id);
        sseBus.broadcast('file', updated);
      }

      res.json({ url });
    } catch (err) {
      console.error('[files] presign error:', err.message);
      res.status(500).json({ error: 'Failed to generate download URL' });
    }
  });

  // Owner downloads a file — presigned URL only, no status change
  router.post('/:id/presign', requireOwner, async (req, res) => {
    const file = db.prepare(`SELECT * FROM files WHERE id=?`).get(req.params.id);
    if (!file || file.status === 'deleted') { res.status(404).json({ error: 'Not found' }); return; }
    try {
      const url = await presignDownload(file.r2_key, 3600);
      res.json({ url, name: file.name });
    } catch (err) {
      res.status(500).json({ error: 'Failed to generate download URL' });
    }
  });

  // Owner deletes a file from R2 immediately
  router.delete('/:id', requireOwner, async (req, res) => {
    const file = db.prepare(`SELECT * FROM files WHERE id=?`).get(req.params.id);
    if (!file) { res.status(404).json({ error: 'Not found' }); return; }

    try {
      if (file.status !== 'deleted') {
        await deleteObject(file.r2_key);
      }
      db.prepare(`UPDATE files SET status='deleted', deleted_at=datetime('now') WHERE id=?`).run(file.id);
      sseBus.broadcast('file', db.prepare(`SELECT * FROM files WHERE id=?`).get(file.id));
      res.json({ ok: true });
    } catch (err) {
      console.error('[files] delete error:', err.message);
      res.status(500).json({ error: 'Delete failed' });
    }
  });

  // Rename a folder — updates folder field on all files in that folder
  router.patch('/folder-rename', (req, res) => {
    const { oldFolder, newFolder } = req.body || {};
    if (newFolder === undefined || newFolder === null) { res.status(400).json({ error: 'newFolder required' }); return; }
    const oldKey = oldFolder ?? '';
    const newKey = (newFolder || '').trim();
    if (oldKey === newKey) { res.json({ ok: true, count: 0 }); return; }
    const affected = db.prepare(`SELECT id FROM files WHERE folder=? AND status NOT IN ('deleted','deleting')`).all(oldKey);
    if (!affected.length) { res.status(404).json({ error: 'No files in that folder' }); return; }
    db.prepare(`UPDATE files SET folder=? WHERE folder=? AND status NOT IN ('deleted','deleting')`).run(newKey, oldKey);
    const updated = db.prepare(`SELECT * FROM files WHERE folder=?`).all(newKey);
    for (const f of updated) sseBus.broadcast('file', f);
    res.json({ ok: true, count: affected.length });
  });

  // Rename a file — any authenticated user (editor or owner)
  router.patch('/:id/rename', (req, res) => {
    const { name } = req.body || {};
    if (!name || !name.trim()) { res.status(400).json({ error: 'name required' }); return; }
    const file = db.prepare(`SELECT * FROM files WHERE id=?`).get(req.params.id);
    if (!file) { res.status(404).json({ error: 'Not found' }); return; }
    db.prepare(`UPDATE files SET name=? WHERE id=?`).run(name.trim(), file.id);
    const updated = db.prepare(`SELECT * FROM files WHERE id=?`).get(file.id);
    sseBus.broadcast('file', updated);
    res.json({ ok: true });
  });

  // Owner cancels auto-delete
  router.post('/:id/keep', requireOwner, (req, res) => {
    const file = db.prepare(`SELECT * FROM files WHERE id=?`).get(req.params.id);
    if (!file) { res.status(404).json({ error: 'Not found' }); return; }
    db.prepare(`UPDATE files SET delete_at=NULL, status='available' WHERE id=?`).run(file.id);
    sseBus.broadcast('file', db.prepare(`SELECT * FROM files WHERE id=?`).get(file.id));
    res.json({ ok: true });
  });

  return router;
}

module.exports = { makeFilesRouter };
