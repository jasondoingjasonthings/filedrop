'use strict';

const express = require('express');
const { signToken, checkPassword } = require('../auth');

// In-memory rate limiter: max 10 login attempts per IP per 15 minutes.
const _loginLog = new Map();
setInterval(() => {
  const cutoff = Date.now() - 15 * 60_000;
  for (const [ip, times] of _loginLog) {
    const trimmed = times.filter(t => t > cutoff);
    if (trimmed.length === 0) _loginLog.delete(ip);
    else _loginLog.set(ip, trimmed);
  }
}, 5 * 60_000).unref();

function loginRateLimited(ip) {
  const now = Date.now();
  const times = (_loginLog.get(ip) || []).filter(t => now - t < 15 * 60_000);
  times.push(now);
  _loginLog.set(ip, times);
  return times.length > 10;
}

function makeAuthRouter(db, jwtSecret) {
  const router = express.Router();

  router.post('/login', async (req, res) => {
    if (loginRateLimited(req.ip)) {
      res.status(429).json({ error: 'Too many login attempts — try again in 15 minutes' });
      return;
    }
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
