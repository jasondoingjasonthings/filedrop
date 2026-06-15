'use strict';

const archiver   = require('archiver');
const { PassThrough } = require('stream');
const { getObjectStream, uploadLarge, deleteObject } = require('./r2');

// In-memory queue — rebuilt from DB on server start via resumePendingBuilds().
const _queue  = [];
let _building = false;

// Called after a share link is created. Sets zip_status='pending' synchronously
// then kicks off the background queue.
function queueZipBuild(db, token, folder, label) {
  db.prepare(`UPDATE share_links SET zip_status='pending' WHERE token=?`).run(token);
  _queue.push({ token, folder, label });
  _kick(db);
}

// On server start, re-queue any shares that were mid-build when the process last stopped.
function resumePendingBuilds(db) {
  const stuck = db.prepare(`
    SELECT token, folder, label FROM share_links
    WHERE zip_status IN ('pending','building') AND expires_at > datetime('now')
  `).all();
  for (const s of stuck) {
    db.prepare(`UPDATE share_links SET zip_status='pending' WHERE token=?`).run(s.token);
    _queue.push(s);
  }
  if (_queue.length) {
    console.log(`[zip] resuming ${_queue.length} pending build(s) from last run`);
    _kick(db);
  }
}

function _kick(db) {
  if (_building || _queue.length === 0) return;
  _building = true;
  const job = _queue.shift();
  _build(db, job)
    .catch(err => {
      console.error(`[zip] build failed token=${job.token}:`, err.message);
      db.prepare(`UPDATE share_links SET zip_status='failed' WHERE token=?`).run(job.token);
    })
    .finally(() => {
      _building = false;
      _kick(db);
    });
}

async function _build(db, { token, folder, label }) {
  const files = db.prepare(`
    SELECT id, name, r2_key, folder FROM files
    WHERE (folder=? OR folder LIKE ?) AND status='available'
    ORDER BY folder, name
  `).all(folder, folder + '/%');

  if (!files.length) {
    db.prepare(`UPDATE share_links SET zip_status='empty' WHERE token=?`).run(token);
    return;
  }

  db.prepare(`UPDATE share_links SET zip_status='building', zip_files_total=?, zip_files_done=0 WHERE token=?`).run(files.length, token);
  console.log(`[zip] building token=${token} files=${files.length}`);
  const updateProgress = db.prepare(`UPDATE share_links SET zip_files_done=? WHERE token=?`);

  const zipKey = `zips/${token}.zip`;
  const pass   = new PassThrough();
  const archive = archiver('zip', { store: true });

  archive.on('error', err => pass.destroy(err));
  archive.pipe(pass);

  // R2 upload runs in parallel with archiver — lib-storage handles multipart.
  const uploadPromise = uploadLarge(zipKey, pass, 'application/zip');

  // Sliding-window prefetch: keep PREFETCH R2 fetches in-flight while the
  // archiver writes the current entry — same approach as the owner /zip endpoint.
  // Streams (not buffers) so backpressure is respected; memory stays flat.
  const PREFETCH = 4;
  const pending = [];
  for (let i = 0; i < Math.min(PREFETCH, files.length); i++) {
    pending.push(getObjectStream(files[i].r2_key).catch(e => e));
  }

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const streamOrErr = await pending.shift();

    const nextIdx = i + PREFETCH;
    if (nextIdx < files.length) pending.push(getObjectStream(files[nextIdx].r2_key).catch(e => e));

    if (streamOrErr instanceof Error) {
      console.error(`[zip] skipping ${f.name}:`, streamOrErr.message);
      continue;
    }

    const relFolder  = folder
      ? (f.folder === folder ? '' : f.folder.slice(folder.length + 1))
      : f.folder;
    const archivePath = relFolder ? `${relFolder}/${f.name}` : f.name;

    await new Promise((resolve, reject) => {
      streamOrErr.on('error', reject);
      archive.append(streamOrErr, { name: archivePath });
      archive.once('entry', resolve);
    });

    // Update progress every 5 files to keep polling overhead low
    if ((i + 1) % 5 === 0 || i === files.length - 1) {
      updateProgress.run(i + 1, token);
    }
  }

  await archive.finalize();
  await uploadPromise;

  // Mark this token ready, then propagate the zip_key to any other pending/building
  // shares for the same folder so they don't each rebuild the same ZIP.
  db.prepare(`UPDATE share_links SET zip_key=?, zip_status='ready' WHERE token=?`).run(zipKey, token);
  const siblings = db.prepare(`
    SELECT token FROM share_links
    WHERE folder=? AND zip_status IN ('pending','building') AND token!=? AND expires_at > datetime('now')
  `).all(folder, token);
  if (siblings.length) {
    const upd = db.prepare(`UPDATE share_links SET zip_key=?, zip_status='ready' WHERE token=?`);
    for (const s of siblings) {
      upd.run(zipKey, s.token);
      const idx = _queue.findIndex(j => j.token === s.token);
      if (idx !== -1) _queue.splice(idx, 1);
    }
    console.log(`[zip] shared zip_key with ${siblings.length} sibling link(s) for same folder`);
  }
  console.log(`[zip] done token=${token} key=${zipKey}`);
}

async function deleteShareZip(zipKey) {
  try { await deleteObject(zipKey); } catch {}
}

module.exports = { queueZipBuild, resumePendingBuilds, deleteShareZip };
