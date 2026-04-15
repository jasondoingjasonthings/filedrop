'use strict';

const express = require('express');
const { v4: uuid } = require('uuid');
const { makeAuthMiddleware, makeAgentMiddleware, requireOwner } = require('../auth');

// In-memory command store — ephemeral, intentionally
const commands = new Map(); // id → { type, payload, result, error, done, createdAt }

// Expire commands older than 120s
setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [id, cmd] of commands) {
    if (cmd.createdAt < cutoff) commands.delete(id);
  }
}, 15000);

function makeFsRouter(db, jwtSecret) {
  const router    = express.Router();
  const jwtAuth   = makeAuthMiddleware(jwtSecret);
  const agentAuth = makeAgentMiddleware(db);

  // ── Dashboard: request browse ─────────────────────────────────────────────
  router.post('/browse', jwtAuth, requireOwner, (req, res) => {
    const { path } = req.body || {};
    const id = uuid();
    commands.set(id, { type: 'browse', payload: { path: path || '' }, done: false, createdAt: Date.now() });
    res.json({ commandId: id });
  });

  // ── Dashboard: request folder sizes (background) ─────────────────────────
  router.post('/dirsize', jwtAuth, requireOwner, (req, res) => {
    const { paths } = req.body || {};
    if (!Array.isArray(paths) || !paths.length) { res.status(400).json({ error: 'paths required' }); return; }
    const id = uuid();
    commands.set(id, { type: 'dirsize', payload: { paths }, done: false, createdAt: Date.now() });
    res.json({ commandId: id });
  });

  // ── Dashboard: request upload ─────────────────────────────────────────────
  router.post('/upload', jwtAuth, requireOwner, (req, res) => {
    const { paths, folder } = req.body || {};
    if (!Array.isArray(paths) || !paths.length) {
      res.status(400).json({ error: 'paths required' }); return;
    }
    const id = uuid();
    commands.set(id, { type: 'upload', payload: { paths, folder: folder || '' }, done: false, createdAt: Date.now() });
    res.json({ commandId: id });
  });

  // ── Dashboard: poll for result ────────────────────────────────────────────
  router.get('/result/:id', jwtAuth, requireOwner, (req, res) => {
    const cmd = commands.get(req.params.id);
    if (!cmd) { res.status(404).json({ error: 'Command not found or expired' }); return; }
    if (!cmd.done) { res.json({ done: false }); return; }
    res.json({ done: true, result: cmd.result, error: cmd.error });
  });

  // ── Agent: get pending commands ───────────────────────────────────────────
  router.get('/pending', agentAuth, (req, res) => {
    const pending = [];
    for (const [id, cmd] of commands) {
      if (!cmd.done && !cmd.claimed) {
        cmd.claimed = true;
        pending.push({ id, type: cmd.type, payload: cmd.payload });
      }
    }
    res.json({ commands: pending });
  });

  // ── Agent: submit result ──────────────────────────────────────────────────
  router.post('/result/:id', agentAuth, (req, res) => {
    const cmd = commands.get(req.params.id);
    if (!cmd) { res.status(404).json({ error: 'not found' }); return; }
    cmd.result = req.body.result;
    cmd.error  = req.body.error;
    cmd.done   = true;
    res.json({ ok: true });
  });

  return router;
}

module.exports = { makeFsRouter };
