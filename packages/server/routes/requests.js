'use strict';

const express = require('express');
const { makeAuthMiddleware, requireOwner } = require('../auth');

function makeRequestsRouter(db, jwtSecret) {
  const router  = express.Router();
  const jwtAuth = makeAuthMiddleware(jwtSecret);

  // Editor: submit a request
  router.post('/', jwtAuth, (req, res) => {
    const { message } = req.body || {};
    if (!message?.trim()) { res.status(400).json({ error: 'message required' }); return; }
    db.prepare(`
      INSERT INTO file_requests (user_id, username, message)
      VALUES (?, ?, ?)
    `).run(req.user.sub, req.user.username, message.trim());
    res.json({ ok: true });
  });

  // Owner: list pending requests
  router.get('/', jwtAuth, requireOwner, (req, res) => {
    const requests = db.prepare(`
      SELECT * FROM file_requests WHERE status='pending' ORDER BY created_at DESC
    `).all();
    res.json(requests);
  });

  // Owner: mark fulfilled
  router.patch('/:id/fulfil', jwtAuth, requireOwner, (req, res) => {
    db.prepare(`UPDATE file_requests SET status='fulfilled' WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  });

  // Owner: dismiss (delete)
  router.delete('/:id', jwtAuth, requireOwner, (req, res) => {
    db.prepare(`DELETE FROM file_requests WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { makeRequestsRouter };
