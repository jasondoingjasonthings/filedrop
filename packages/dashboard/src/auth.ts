import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import type { User, UserRole } from '@filedrop/core';

const BCRYPT_ROUNDS = 12;
const JWT_EXPIRY = '24h';

// ─── Token ───────────────────────────────────────────────────────────────────

export interface TokenPayload {
  sub: number;   // user id
  username: string;
  role: UserRole;
}

export function signToken(payload: TokenPayload, secret: string): string {
  return jwt.sign(payload, secret, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string, secret: string): TokenPayload {
  return jwt.verify(token, secret) as unknown as TokenPayload;
}

// ─── Password ────────────────────────────────────────────────────────────────

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function checkPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// ─── Middleware ───────────────────────────────────────────────────────────────

// Attach the decoded user to every request so routes can read it.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

export function makeAuthMiddleware(secret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
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

export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'owner') {
    res.status(403).json({ error: 'Owner role required' });
    return;
  }
  next();
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

export function findUserByUsername(db: Database.Database, username: string): User | null {
  return db.prepare<[string], User>(`SELECT * FROM users WHERE username = ?`).get(username) ?? null;
}

export function ownerExists(db: Database.Database): boolean {
  const row = db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner'`).get();
  return (row?.n ?? 0) > 0;
}

export function createUser(
  db: Database.Database,
  username: string,
  passwordHash: string,
  role: UserRole,
  email: string | null
): User {
  const row = db.prepare<[string, string, string, string | null], User>(`
    INSERT INTO users (username, password_hash, role, email)
    VALUES (?, ?, ?, ?)
    RETURNING *
  `).get(username, passwordHash, role, email);
  if (!row) throw new Error('Failed to create user');
  return row;
}
