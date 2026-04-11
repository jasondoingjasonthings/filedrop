'use strict';

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_EXPIRY = '7d';
const BCRYPT_ROUNDS = 12;

function signToken(payload, secret) {
  return jwt.sign(payload, secret, { expiresIn: JWT_EXPIRY });
}

function verifyToken(token, secret) {
  return jwt.verify(token, secret);
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function checkPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function makeAuthMiddleware(secret) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing token' });
      return;
    }
    try {
      req.user = verifyToken(header.slice(7), secret);
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
  signToken, verifyToken, hashPassword, checkPassword,
  makeAuthMiddleware, requireOwner, makeAgentMiddleware,
};
