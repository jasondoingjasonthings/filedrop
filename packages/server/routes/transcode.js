'use strict';

const express = require('express');
const { makeAuthMiddleware, requireOwner } = require('../auth');
const { queueTranscodeJob, isVideoFile } = require('../transcode');
const { presignDownload } = require('../r2');

function makeTranscodeRouter(db, jwtSecret) {
  const router  = express.Router();
  const jwtAuth = makeAuthMiddleware(jwtSecret, db);

  // Get proxy_enabled map for all top-level folders that have it on
  router.get('/proxy-settings', jwtAuth, requireOwner, (req, res) => {
    const rows = db.prepare(`SELECT path, proxy_enabled FROM folders WHERE proxy_enabled=1`).all();
    const result = {};
    for (const r of rows) result[r.path] = true;
    res.json(result);
  });

  // Toggle proxy_enabled for a folder path (upserts the folders row)
  router.patch('/proxy-settings', jwtAuth, requireOwner, (req, res) => {
    const { path: folderPath, enabled } = req.body || {};
    if (!folderPath || !folderPath.trim()) { res.status(400).json({ error: 'path required' }); return; }
    const p   = folderPath.trim();
    const val = enabled ? 1 : 0;
    db.prepare(`INSERT OR IGNORE INTO folders (path) VALUES (?)`).run(p);
    db.prepare(`UPDATE folders SET proxy_enabled=? WHERE path=?`).run(val, p);

    let queued = 0;
    if (enabled) {
      // Queue all existing available video files that don't already have a proxy or active job.
      // Exclude anything inside a /Proxy subfolder or named *_proxy.mp4 — those are already proxies.
      const existing = db.prepare(`
        SELECT f.* FROM files f
        WHERE f.status = 'available'
          AND f.proxy_key IS NULL
          AND (f.folder = ? OR f.folder LIKE ?)
          AND f.name NOT LIKE '%\_proxy.mp4' ESCAPE '\'
          AND f.folder NOT LIKE '%/Proxy'
          AND f.folder NOT LIKE '%/Proxy/%'
          AND NOT EXISTS (
            SELECT 1 FROM transcode_jobs tj
            WHERE tj.file_id = f.id AND tj.status IN ('pending','processing')
          )
      `).all(p, p + '/%');

      for (const file of existing) {
        if (isVideoFile(file.name)) {
          const jobId = queueTranscodeJob(db, file);
          if (jobId) queued++;
        }
      }
    }

    res.json({ ok: true, path: p, proxy_enabled: val, queued });
  });

  // Per-top-folder proxy progress summary for the progress pill
  router.get('/folder-progress', jwtAuth, requireOwner, (req, res) => {
    const rows = db.prepare(`
      SELECT f.folder, tj.status, COUNT(*) as n
      FROM transcode_jobs tj JOIN files f ON f.id = tj.file_id
      WHERE tj.status IN ('pending','processing','done')
      GROUP BY f.folder, tj.status
    `).all();
    const result = {};
    for (const row of rows) {
      const folder = row.folder ?? '';
      const slash  = folder.indexOf('/');
      const topKey = slash === -1 ? folder : folder.slice(0, slash);
      if (!result[topKey]) result[topKey] = { done: 0, pending: 0, processing: 0 };
      result[topKey][row.status] = (result[topKey][row.status] || 0) + row.n;
    }
    res.json(result);
  });

  // List transcode jobs (owner only), optionally filtered by folder prefix
  router.get('/jobs', jwtAuth, requireOwner, (req, res) => {
    const { folder } = req.query;
    let jobs;
    if (folder !== undefined) {
      jobs = db.prepare(`
        SELECT tj.*, f.name as file_name, f.folder as file_folder
        FROM transcode_jobs tj JOIN files f ON f.id=tj.file_id
        WHERE f.folder=? OR f.folder LIKE ?
        ORDER BY tj.created_at DESC LIMIT 200
      `).all(folder, folder + '/%');
    } else {
      jobs = db.prepare(`
        SELECT tj.*, f.name as file_name, f.folder as file_folder
        FROM transcode_jobs tj JOIN files f ON f.id=tj.file_id
        ORDER BY tj.created_at DESC LIMIT 200
      `).all();
    }
    res.json(jobs);
  });

  // Manually queue a file for transcoding (owner can force-queue any video)
  router.post('/jobs', jwtAuth, requireOwner, (req, res) => {
    const { fileId } = req.body || {};
    if (!fileId) { res.status(400).json({ error: 'fileId required' }); return; }
    const file = db.prepare(`SELECT * FROM files WHERE id=? AND status='available'`).get(fileId);
    if (!file) { res.status(404).json({ error: 'File not found or not available' }); return; }
    if (!isVideoFile(file.name)) { res.status(422).json({ error: 'Not a video file' }); return; }
    const jobId = queueTranscodeJob(db, file);
    if (!jobId) { res.status(409).json({ error: 'Already queued or processing' }); return; }
    res.json({ ok: true, jobId });
  });

  // Cancel a pending job
  router.delete('/jobs/:id', jwtAuth, requireOwner, (req, res) => {
    const result = db.prepare(
      `UPDATE transcode_jobs SET status='failed', error='cancelled', finished_at=datetime('now') WHERE id=? AND status='pending'`
    ).run(req.params.id);
    if (result.changes === 0) { res.status(404).json({ error: 'Job not found or not pending' }); return; }
    res.json({ ok: true });
  });

  // Get presigned download URL for a proxy file
  router.post('/proxy-url/:fileId', jwtAuth, async (req, res) => {
    const file = db.prepare(`SELECT proxy_key, name FROM files WHERE id=?`).get(req.params.fileId);
    if (!file || !file.proxy_key) { res.status(404).json({ error: 'No proxy available' }); return; }
    try {
      const proxyName = file.name.replace(/\.[^.]+$/, '_proxy.mp4');
      const url = await presignDownload(file.proxy_key, 3600, proxyName);
      res.json({ url });
    } catch (err) {
      res.status(500).json({ error: 'Failed to generate URL' });
    }
  });

  return router;
}

module.exports = { makeTranscodeRouter };
