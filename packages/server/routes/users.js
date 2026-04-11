'use strict';

const express = require('express');
const { requireOwner, hashPassword } = require('../auth');

function makeUsersRouter(db) {
  const router = express.Router();

  router.use(requireOwner);

  router.get('/', (req, res) => {
    const users = db.prepare(`SELECT id, username, role, created_at FROM users ORDER BY id`).all();
    res.json(users);
  });

  router.post('/', async (req, res) => {
    const { username, password, role } = req.body || {};
    if (!username || !password || !['owner','editor'].includes(role)) {
      res.status(400).json({ error: 'username, password and role required' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }
    try {
      const hash = await hashPassword(password);
      const r = db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?,?,?) RETURNING id, username, role, created_at`).get(username, hash, role);
      res.status(201).json(r);
    } catch {
      res.status(409).json({ error: 'Username already exists' });
    }
  });

  router.patch('/:id/password', async (req, res) => {
    const { password } = req.body || {};
    if (!password || password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }
    const hash = await hashPassword(password);
    db.prepare(`UPDATE users SET password_hash=? WHERE id=?`).run(hash, req.params.id);
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    if (parseInt(req.params.id) === req.user.sub) {
      res.status(400).json({ error: 'Cannot delete yourself' });
      return;
    }
    db.prepare(`DELETE FROM users WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { makeUsersRouter };
