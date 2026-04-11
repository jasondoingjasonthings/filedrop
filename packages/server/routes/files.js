'use strict';

const express = require('express');
const { requireOwner } = require('../auth');
const { presignDownload, deleteObject } = require('../r2');

function makeFilesRouter(db, sseBus) {
  const router = express.Router();

  // List files (owner sees all, editor sees non-deleted only)
  router.get('/', (req, res) => {
    const files = req.user.role === 'owner'
      ? db.prepare(`SELECT * FROM files ORDER BY created_at DESC`).all()
      : db.prepare(`SELECT * FROM files WHERE status NOT IN ('deleted') ORDER BY created_at DESC`).all();
    res.json(files);
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

      // Log first download and schedule deletion
      if (!file.downloaded_at) {
        const deleteAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        db.prepare(`
          UPDATE files
          SET status='downloaded', downloaded_by=?, downloaded_at=datetime('now'), delete_at=?
          WHERE id=?
        `).run(req.user.sub, deleteAt, file.id);

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
