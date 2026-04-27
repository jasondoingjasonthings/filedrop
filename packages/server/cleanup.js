'use strict';

const { deleteObject } = require('./r2');

const CHECK_INTERVAL_MS = 60_000; // check every minute

function startCleanup(db, sseBus) {
  setInterval(() => runCleanup(db, sseBus), CHECK_INTERVAL_MS);
  // Run once at startup too
  runCleanup(db, sseBus);
}

async function runCleanup(db, sseBus) {
  // ── Sweep stale 'uploading' entries ──────────────────────────────────────────
  // Queued (progress=0): give 7 days — large batches (200GB+) can queue for days
  // Active (progress>0): 30 min no heartbeat = something went wrong
  const stale = db.prepare(`
    SELECT id, r2_key FROM files
    WHERE status = 'uploading'
      AND (
        (upload_progress > 0 AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-30 minutes')))
        OR
        (upload_progress = 0 AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-7 days')))
      )
  `).all();
  for (const f of stale) {
    try { await deleteObject(f.r2_key); } catch {}
    db.prepare(`UPDATE files SET status='deleted' WHERE id=?`).run(f.id);
    sseBus.broadcast('file', db.prepare(`SELECT * FROM files WHERE id=?`).get(f.id));
    console.log(`[cleanup] Cleared stale upload (no heartbeat): ${f.id}`);
  }

  // ── Prune deleted records — keep only the 100 most recent ───────────────────
  db.prepare(`
    DELETE FROM files WHERE status = 'deleted'
      AND id NOT IN (
        SELECT id FROM files WHERE status = 'deleted'
        ORDER BY COALESCE(deleted_at, created_at) DESC LIMIT 100
      )
  `).run();

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
