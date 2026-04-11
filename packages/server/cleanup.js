'use strict';

const { deleteObject } = require('./r2');

const CHECK_INTERVAL_MS = 60_000; // check every minute

function startCleanup(db, sseBus) {
  setInterval(() => runCleanup(db, sseBus), CHECK_INTERVAL_MS);
  // Run once at startup too
  runCleanup(db, sseBus);
}

async function runCleanup(db, sseBus) {
  // ── Sweep stale 'uploading' entries (no heartbeat for > 5 minutes = dead) ──
  const stale = db.prepare(`
    SELECT id FROM files
    WHERE status = 'uploading'
      AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-5 minutes'))
  `).all();
  for (const f of stale) {
    db.prepare(`UPDATE files SET status='deleted' WHERE id=?`).run(f.id);
    sseBus.broadcast('file', db.prepare(`SELECT * FROM files WHERE id=?`).get(f.id));
    console.log(`[cleanup] Cleared stale upload (no heartbeat): ${f.id}`);
  }

  const now = new Date().toISOString();
  const due = db.prepare(`
    SELECT id, r2_key FROM files
    WHERE status = 'downloaded'
      AND delete_at IS NOT NULL
      AND delete_at <= ?
  `).all(now);

  for (const file of due) {
    try {
      db.prepare(`UPDATE files SET status='deleting' WHERE id=?`).run(file.id);
      sseBus.broadcast('file', db.prepare(`SELECT * FROM files WHERE id=?`).get(file.id));

      await deleteObject(file.r2_key);

      db.prepare(`
        UPDATE files SET status='deleted', deleted_at=datetime('now') WHERE id=?
      `).run(file.id);
      sseBus.broadcast('file', db.prepare(`SELECT * FROM files WHERE id=?`).get(file.id));
    } catch (err) {
      console.error(`[cleanup] Failed to delete ${file.r2_key}:`, err.message);
    }
  }
}

module.exports = { startCleanup };
