'use strict';

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_EXPIRY    = '7d';
const BCRYPT_ROUNDS = 12;

function signToken(payload, secret) {
  return jwt.sign({ ...payload, jti: crypto.randomUUID() }, secret, { expiresIn: JWT_EXPIRY });
}

function verifyToken(token, secret) {
  return jwt.verify(token, secret);
}

// Insert a jti into the revoked_tokens table so it can never be used again.
function revokeToken(jti, expiresAt, db) {
  db.prepare(`INSERT OR IGNORE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)`).run(jti, expiresAt);
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function checkPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function makeAuthMiddleware(secret, db = null) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing token' });
      return;
    }
    try {
      req.user = verifyToken(header.slice(7), secret);
      if (db && req.user.jti) {
        const revoked = db.prepare(`SELECT 1 FROM revoked_tokens WHERE jti=?`).get(req.user.jti);
        if (revoked) { res.status(401).json({ error: 'Token has been revoked' }); return; }
      }
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

function requireOwner(req, res, next) {
  if (req.user?.role !== 'owner') {
    res.status(403).json({ error: 'Owner role required' });
    return;
  }
  next();
}

function makeAgentMiddleware(db) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Agent ')) {
      res.status(401).json({ error: 'Missing agent token' });
      return;
    }
    const token = header.slice(6);
    const row = db.prepare(`SELECT id FROM agent_tokens WHERE token = ?`).get(token);
    if (!row) {
      res.status(401).json({ error: 'Invalid agent token' });
      return;
    }
    req.agentId = row.id;
    next();
  };
}

module.exports = {
  signToken, verifyToken, revokeToken, hashPassword, checkPassword,
  makeAuthMiddleware, requireOwner, makeAgentMiddleware,
};
