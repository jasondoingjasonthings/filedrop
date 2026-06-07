'use strict';

const archiver   = require('archiver');
const { PassThrough } = require('stream');
const { getObject, uploadLarge, deleteObject } = require('./r2');

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

  db.prepare(`UPDATE share_links SET zip_status='building' WHERE token=?`).run(token);
  console.log(`[zip] building token=${token} files=${files.length}`);

  const zipKey = `zips/${token}.zip`;
  const pass   = new PassThrough();
  const archive = archiver('zip', { store: true });

  archive.on('error', err => pass.destroy(err));
  archive.pipe(pass);

  // R2 upload runs in parallel with archiver — lib-storage handles multipart.
  const uploadPromise = uploadLarge(zipKey, pass, 'application/zip');

  // Parallel fetch pool: download CONCURRENCY files from R2 simultaneously.
  // Each slot buffers the full file so true parallel downloads happen rather
  // than just opening N idle streams. Archiver still appends in order.
  const CONCURRENCY = 4;
  const inFlight = new Map(); // index -> Promise<Buffer|Error>

  function kickFetch(idx) {
    if (idx < files.length && !inFlight.has(idx)) {
      inFlight.set(idx, getObject(files[idx].r2_key).catch(e => e));
    }
  }

  for (let i = 0; i < Math.min(CONCURRENCY, files.length); i++) kickFetch(i);

  for (let i = 0; i < files.length; i++) {
    kickFetch(i + CONCURRENCY);

    const f = files[i];
    const bufOrErr = await inFlight.get(i);
    inFlight.delete(i);

    if (bufOrErr instanceof Error) {
      console.error(`[zip] skipping ${f.name}:`, bufOrErr.message);
      continue;
    }

    const relFolder  = folder
      ? (f.folder === folder ? '' : f.folder.slice(folder.length + 1))
      : f.folder;
    const archivePath = relFolder ? `${relFolder}/${f.name}` : f.name;

    await new Promise((resolve) => {
      archive.append(bufOrErr, { name: archivePath });
      archive.once('entry', resolve);
    });
  }

  await archive.finalize();
  await uploadPromise;

  db.prepare(`UPDATE share_links SET zip_key=?, zip_status='ready' WHERE token=?`).run(zipKey, token);
  console.log(`[zip] done token=${token} key=${zipKey}`);
}

async function deleteShareZip(zipKey) {
  try { await deleteObject(zipKey); } catch {}
}

module.exports = { queueZipBuild, resumePendingBuilds, deleteShareZip };
