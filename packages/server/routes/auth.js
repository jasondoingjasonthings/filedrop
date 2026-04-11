'use strict';

const express = require('express');
const { signToken, checkPassword } = require('../auth');

function makeAuthRouter(db, jwtSecret) {
  const router = express.Router();

  router.post('/login', async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password required' });
      return;
    }
    const user = db.prepare(`SELECT * FROM users WHERE username=?`).get(username);
    if (!user || !(await checkPassword(password, user.password_hash))) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const token = signToken({ sub: user.id, username: user.username, role: user.role }, jwtSecret);
    res.json({ token, role: user.role, username: user.username });
  });

  return router;
}

module.exports = { makeAuthRouter };
