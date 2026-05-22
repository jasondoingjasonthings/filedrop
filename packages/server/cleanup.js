'use strict';

const { deleteObject } = require('./r2');

const CHECK_INTERVAL_MS = 60_000; // check every minute

let _running = false;

function startCleanup(db, sseBus) {
  setInterval(() => runCleanup(db, sseBus), CHECK_INTERVAL_MS);
  // Run once at startup too
  runCleanup(db, sseBus);
}

async function runCleanup(db, sseBus) {
  if (_running) { console.log('[cleanup] Already running, skipping'); return; }
  _running = true;
  try {
    await _doCleanup(db, sseBus);
  } finally {
    _running = false;
  }
}

async function _doCleanup(db, sseBus) {
  // ── Sweep stale 'uploading' entries ──────────────────────────────────────────
  // Seen (has heartbeat): 30 min of silence = abandoned
  // Never seen (last_seen_at IS NULL): give 7 days grace — agent batches queue for days
  const stale = db.prepare(`
    SELECT id, r2_key FROM files
    WHERE status = 'uploading'
      AND (
        (last_seen_at IS NOT NULL AND last_seen_at < datetime('now', '-30 minutes'))
        OR
        (last_seen_at IS NULL AND created_at < datetime('now', '-7 days'))
      )
  `).all();
  for (const f of stale) {
    try { await deleteObject(f.r2_key); } catch {}
    db.prepare(`UPDATE files SET status='deleted' WHERE id=?`).run(f.id);
    sseBus.broadcast('file', db.prepare(`SELECT * FROM files WHERE id=?`).get(f.id));
    console.log(`[cleanup] Cleared stale upload (no heartbeat): ${f.id}`);
  }

  // ── Prune expired revoked tokens ────────────────────────────────────────────
  db.prepare(`DELETE FROM revoked_tokens WHERE expires_at <= datetime('now')`).run();

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
    db.prepare(`UPDATE files SET status='deleting' WHERE id=?`).run(file.id);
    sseBus.broadcast('file', db.prepare(`SELECT * FROM files WHERE id=?`).get(file.id));
    try {
      await deleteObject(file.r2_key);
      db.prepare(`UPDATE files SET status='deleted', deleted_at=datetime('now') WHERE id=?`).run(file.id);
      sseBus.broadcast('file', db.prepare(`SELECT * FROM files WHERE id=?`).get(file.id));
    } catch (err) {
      console.error(`[cleanup] R2 delete failed for ${file.r2_key}, will retry next run:`, err.message);
      // Revert so the next cleanup cycle retries rather than leaving it stuck in 'deleting' forever
      db.prepare(`UPDATE files SET status='downloaded' WHERE id=? AND status='deleting'`).run(file.id);
      sseBus.broadcast('file', db.prepare(`SELECT * FROM files WHERE id=?`).get(file.id));
    }
  }
}

module.exports = { startCleanup };
