'use strict';

const express  = require('express');
const archiver = require('archiver');
const { requireOwner } = require('../auth');
const { presignDownload, deleteObject, getObjectStream } = require('../r2');
const { logAudit } = require('../audit');
const { queueZipBuild, deleteShareZip } = require('../zipbuilder');

// Debounced ZIP invalidation — batches rapid bulk deletes into one rebuild per folder
const _zipInvalidateTimers = new Map();
function scheduleZipInvalidation(db, folder) {
  if (_zipInvalidateTimers.has(folder)) clearTimeout(_zipInvalidateTimers.get(folder));
  _zipInvalidateTimers.set(folder, setTimeout(async () => {
    _zipInvalidateTimers.delete(folder);
    const links = db.prepare(`
      SELECT * FROM share_links
      WHERE (folder=? OR ? LIKE folder || '/%')
        AND zip_status='ready' AND zip_key IS NOT NULL
        AND expires_at > datetime('now')
    `).all(folder, folder);
    for (const link of links) {
      try { await deleteShareZip(link.zip_key); } catch {}
      db.prepare(`UPDATE share_links SET zip_key=NULL, zip_status='pending' WHERE id=?`).run(link.id);
      queueZipBuild(db, link.token, link.folder, link.label);
      console.log(`[zip] invalidated and re-queued after file delete: ${link.folder}`);
    }
  }, 3000));
}

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
        SUM(CASE WHEN status='uploading'          THEN 1 ELSE 0 END) as uploading_count,
        SUM(CASE WHEN status='available'          THEN 1 ELSE 0 END) as available_count,
        SUM(CASE WHEN downloaded_at IS NOT NULL   THEN 1 ELSE 0 END) as downloaded_count
      FROM files
      WHERE status NOT IN ('deleted', 'deleting')
      GROUP BY folder
      ORDER BY MAX(COALESCE(uploaded_at, created_at)) DESC
    `).all();

    // Merge explicitly-created empty folders
    const fileFolderSet = new Set(rows.map(r => r.folder ?? ''));
    const emptyFolders = db.prepare(
      `SELECT path FROM folders WHERE path NOT IN (SELECT DISTINCT folder FROM files WHERE status NOT IN ('deleted','deleting'))`
    ).all();
    for (const f of emptyFolders) {
      if (!fileFolderSet.has(f.path)) {
        rows.push({ folder: f.path, file_count: 0, total_size: 0, uploading_count: 0, available_count: 0, downloaded_count: 0 });
      }
    }

    res.json(rows);
  });

  // Create a named empty folder
  router.post('/folders', (req, res) => {
    const { path: folderPath } = req.body || {};
    if (!folderPath || !folderPath.trim()) { res.status(400).json({ error: 'path required' }); return; }
    const p = folderPath.trim();
    db.prepare(`INSERT OR IGNORE INTO folders (path) VALUES (?)`).run(p);
    res.json({ ok: true, path: p });
  });

  // Check which files already exist as 'available' — used by browser upload to skip duplicates
  // Body: { files: [{name, folder}] }  Response: { existing: Set<"name|folder"> as array }
  router.post('/check-existing', (req, res) => {
    const { files: list } = req.body || {};
    if (!Array.isArray(list) || !list.length) { res.json({ existing: [] }); return; }
    const stmt = db.prepare(`SELECT 1 FROM files WHERE name=? AND folder=? AND status IN ('available','uploading') LIMIT 1`);
    const existing = list
      .filter(f => f && f.name)
      .filter(f => stmt.get(f.name, f.folder ?? '') !== undefined)
      .map(f => `${f.name}|${f.folder ?? ''}`);
    res.json({ existing });
  });

  // Move files to a new folder
  router.post('/move', (req, res) => {
    const { ids, folder } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) { res.status(400).json({ error: 'ids required' }); return; }
    const target = folder ?? '';
    const stmt   = db.prepare(`UPDATE files SET folder=? WHERE id=? AND status NOT IN ('deleted','deleting')`);
    db.transaction(() => { for (const id of ids) stmt.run(target, id); })();
    const updated = ids.length <= 50
      ? db.prepare(`SELECT * FROM files WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : [];
    for (const f of updated) sseBus.broadcast('file', f);
    res.json({ ok: true, count: ids.length });
  });

  // Move entire folder (renames the prefix on all files + subfolders)
  router.post('/folder-move', (req, res) => {
    const { from, to } = req.body || {};
    if (from === undefined || to === undefined) { res.status(400).json({ error: 'from and to required' }); return; }
    const fromKey = from ?? '';
    const toKey   = to   ?? '';
    if (fromKey === toKey) { res.json({ ok: true, count: 0 }); return; }

    let count = 0;
    db.transaction(() => {
      // Exact folder
      const r1 = db.prepare(`UPDATE files SET folder=? WHERE folder=? AND status NOT IN ('deleted','deleting')`).run(toKey, fromKey);
      count += r1.changes;
      // Subfolders: replace prefix
      if (fromKey) {
        const r2 = db.prepare(
          `UPDATE files SET folder=? || SUBSTR(folder, ?) WHERE folder LIKE ? AND status NOT IN ('deleted','deleting')`
        ).run(toKey, fromKey.length + 1, fromKey + '/%');
        count += r2.changes;
        // Same for the folders table
        db.prepare(`UPDATE folders SET path=? || SUBSTR(path, ?) WHERE path LIKE ?`).run(toKey, fromKey.length + 1, fromKey + '/%');
      }
      // Move the explicit folder entry itself
      db.prepare(`UPDATE folders SET path=? WHERE path=?`).run(toKey, fromKey);
    })();

    sseBus.broadcast('folders-changed', {});
    res.json({ ok: true, count });
  });

  // Files in a specific folder (used when expanding a folder)
  router.get('/in', (req, res) => {
    const folder = req.query.folder ?? '';
    const limit  = Math.min(parseInt(req.query.limit  || '200', 10), 1000);
    const offset = parseInt(req.query.offset || '0', 10);
    const list = db.prepare(`
      SELECT f.*,
        (SELECT status FROM transcode_jobs WHERE file_id=f.id AND status IN ('pending','processing','failed') ORDER BY created_at DESC LIMIT 1) as proxy_job_status,
        (SELECT id     FROM transcode_jobs WHERE file_id=f.id AND status IN ('pending','processing','failed') ORDER BY created_at DESC LIMIT 1) as proxy_job_id
      FROM files f
      WHERE f.folder=? AND f.status NOT IN ('deleted','deleting')
      ORDER BY f.name COLLATE NOCASE ASC
      LIMIT ? OFFSET ?
    `).all(folder, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) as n FROM files WHERE folder=? AND status NOT IN ('deleted','deleting')`).get(folder).n;
    res.json({ files: list, total, limit, offset });
  });

  // Presigned thumbnail URLs for images in a folder (used by share modal cover picker)
  router.get('/thumbs', async (req, res) => {
    const folder = req.query.folder ?? '';
    const IMAGE_EXTS = ['jpg','jpeg','png','gif','webp','heic','heif'];
    const placeholders = IMAGE_EXTS.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, name, thumbnail_key, folder FROM files
      WHERE (folder=? OR folder LIKE ?)
        AND status='available'
        AND LOWER(SUBSTR(name, INSTR(name,'.')+1)) IN (${placeholders})
      ORDER BY folder, name COLLATE NOCASE ASC
      LIMIT 60
    `).all(folder, folder + '/%', ...IMAGE_EXTS);

    const results = await Promise.all(rows.map(async f => {
      let thumbnailUrl = null;
      if (f.thumbnail_key) {
        try { thumbnailUrl = await presignDownload(f.thumbnail_key, 3600); } catch {}
      }
      return { id: f.id, name: f.name, folder: f.folder, thumbnailUrl };
    }));
    res.json(results);
  });

  // List all files — kept for SSE token validation only; returns empty array to avoid heavy load
  router.get('/', (req, res) => {
    res.json([]);
  });

  // ZIP download — all files under a folder prefix, preserving subfolder structure
  // Must be registered before /:id so Express doesn't treat 'zip' as a file id.
  router.get('/zip', async (req, res) => {
    const prefix = req.query.folder ?? '';
    const rows = db.prepare(`
      SELECT id, name, r2_key, folder FROM files
      WHERE (folder=? OR folder LIKE ?) AND status='available'
      ORDER BY folder, name
    `).all(prefix, prefix + '/%');

    if (!rows.length) { res.status(404).json({ error: 'No files' }); return; }

    const zipName = (prefix || 'files').replace(/[^a-zA-Z0-9._\- ]/g, '_') || 'files';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}.zip"`);

    // store:true skips zlib entirely — video/photo files are already compressed
    const archive = archiver('zip', { store: true });
    archive.pipe(res);
    archive.on('error', err => { console.error('[zip] archive error:', err.message); res.end(); });

    console.log(`[zip] owner start folder="${prefix}" files=${rows.length}`);

    // Sliding-window prefetch: keep PREFETCH R2 fetches in flight while the
    // archiver writes the current entry. Streams must be appended in order.
    const PREFETCH = 4;
    const pending = []; // circular buffer of Promise<stream|Error>
    for (let i = 0; i < Math.min(PREFETCH, rows.length); i++) {
      pending.push(getObjectStream(rows[i].r2_key).catch(e => e));
    }

    for (let i = 0; i < rows.length; i++) {
      const f          = rows[i];
      const streamOrErr = await pending.shift();

      // Pre-fetch the next one in the window while we write this entry
      const nextIdx = i + PREFETCH;
      if (nextIdx < rows.length) pending.push(getObjectStream(rows[nextIdx].r2_key).catch(e => e));

      if (streamOrErr instanceof Error) {
        console.error(`[zip] skipping ${f.name}:`, streamOrErr.message);
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
        console.error(`[zip] skipping ${f.name}:`, err.message);
      }
    }
    await archive.finalize();
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
      const url = await presignDownload(file.r2_key, 3600, file.name);

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

      logAudit(db, { action: 'file_downloaded', actor: req.user.username, fileId: file.id, fileName: file.name, folder: file.folder, ip: req.ip });
      res.json({ url, size: file.size || 0 });
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
      const url = await presignDownload(file.r2_key, 3600, file.name);
      res.json({ url, name: file.name });
    } catch (err) {
      res.status(500).json({ error: 'Failed to generate download URL' });
    }
  });

  // Delete a file from R2
  router.delete('/:id', async (req, res) => {
    const file = db.prepare(`SELECT * FROM files WHERE id=?`).get(req.params.id);
    if (!file) { res.status(404).json({ error: 'Not found' }); return; }

    try {
      if (file.status !== 'deleted') {
        await deleteObject(file.r2_key);
      }
      db.prepare(`UPDATE files SET status='deleted', deleted_at=datetime('now') WHERE id=?`).run(file.id);
      db.prepare(`UPDATE transcode_jobs SET status='failed', error='source file deleted', finished_at=datetime('now') WHERE file_id=? AND status='pending'`).run(file.id);
      // If this was a proxy file, clear proxy_key on the original so it can be re-queued
      db.prepare(`UPDATE files SET proxy_key=NULL WHERE proxy_key=?`).run(file.r2_key);
      sseBus.broadcast('file', db.prepare(`SELECT * FROM files WHERE id=?`).get(file.id));
      logAudit(db, { action: 'file_deleted', actor: req.user?.username, fileId: file.id, fileName: file.name, folder: file.folder, ip: req.ip });
      if (file.folder !== undefined) scheduleZipInvalidation(db, file.folder ?? '');
      res.json({ ok: true });
    } catch (err) {
      console.error('[files] delete error:', err.message);
      res.status(500).json({ error: 'Delete failed' });
    }
  });

  // Rename a folder — updates folder field on all files in that folder
  router.patch('/folder-rename', (req, res) => {
    const { oldFolder, newFolder, recursive } = req.body || {};
    if (newFolder === undefined || newFolder === null) { res.status(400).json({ error: 'newFolder required' }); return; }
    const oldKey = oldFolder ?? '';
    const newKey = (newFolder || '').trim();
    if (oldKey === newKey) { res.json({ ok: true, count: 0 }); return; }

    if (recursive) {
      // Rename the top-level folder and all sub-folders that share its prefix.
      // e.g. "Jobs/Alpha" and "Jobs/Beta" both become "NewName/Alpha", "NewName/Beta".
      db.prepare(`
        UPDATE files SET folder = ? || SUBSTR(folder, LENGTH(?) + 1)
        WHERE (folder = ? OR folder LIKE ?) AND status NOT IN ('deleted','deleting')
      `).run(newKey, oldKey, oldKey, oldKey + '/%');
      const updated = db.prepare(`SELECT * FROM files WHERE folder = ? OR folder LIKE ?`).all(newKey, newKey + '/%');
      for (const f of updated) sseBus.broadcast('file', f);
    } else {
      const affected = db.prepare(`SELECT id FROM files WHERE folder=? AND status NOT IN ('deleted','deleting')`).all(oldKey);
      if (!affected.length) { res.status(404).json({ error: 'No files in that folder' }); return; }
      db.prepare(`UPDATE files SET folder=? WHERE folder=? AND status NOT IN ('deleted','deleting')`).run(newKey, oldKey);
      const updated = db.prepare(`SELECT * FROM files WHERE folder=?`).all(newKey);
      for (const f of updated) sseBus.broadcast('file', f);
    }

    sseBus.broadcast('folders-changed', {});
    logAudit(db, { action: 'folder_renamed', actor: req.user?.username, folder: newKey, detail: `was: ${oldKey}`, ip: req.ip });
    res.json({ ok: true });
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
    logAudit(db, { action: 'file_renamed', actor: req.user?.username, fileId: file.id, fileName: name.trim(), folder: file.folder, detail: `was: ${file.name}`, ip: req.ip });
    res.json({ ok: true });
  });

  // Cancel auto-delete
  router.post('/:id/keep', (req, res) => {
    const file = db.prepare(`SELECT * FROM files WHERE id=?`).get(req.params.id);
    if (!file) { res.status(404).json({ error: 'Not found' }); return; }
    db.prepare(`UPDATE files SET delete_at=NULL, status='available' WHERE id=?`).run(file.id);
    sseBus.broadcast('file', db.prepare(`SELECT * FROM files WHERE id=?`).get(file.id));
    res.json({ ok: true });
  });

  return router;
}

module.exports = { makeFilesRouter };
