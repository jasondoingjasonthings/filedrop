'use strict';

const express = require('express');
const { hashPassword } = require('../auth');
const { ownerExists } = require('../db');
const fs = require('fs');
const path = require('path');

function makeSetupRouter(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    if (ownerExists(db)) { res.redirect('/'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.send(fs.readFileSync(path.join(__dirname, '../html/setup.html'), 'utf-8'));
  });

  router.post('/complete', express.json(), async (req, res) => {
    if (ownerExists(db)) { res.status(400).json({ error: 'Already set up' }); return; }
    const { username, password } = req.body || {};
    if (!username || !password || password.length < 8) {
      res.status(400).json({ error: 'Username and password (min 8 chars) required' });
      return;
    }
    const hash = await hashPassword(password);
    db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'owner')`).run(username, hash);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { makeSetupRouter };
