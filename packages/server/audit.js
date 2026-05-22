'use strict';

function logAudit(db, { action, actor, fileId, fileName, folder, detail, ip }) {
  try {
    db.prepare(`
      INSERT INTO audit_log (action, actor, file_id, file_name, folder, detail, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(action, actor || null, fileId || null, fileName || null, folder || null, detail || null, ip || null);
  } catch (err) {
    // Audit failure must never break the main request
    console.error('[audit] Insert failed:', err.message);
  }
}

module.exports = { logAudit };
