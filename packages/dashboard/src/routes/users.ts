import { Router } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { User } from '@filedrop/core';
import { requireOwner, hashPassword, createUser, findUserByUsername } from '../auth.js';

const CreateUserBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(8),
  role: z.enum(['owner', 'viewer']).default('viewer'),
  email: z.string().email().optional(),
});

const NotifyPrefsBody = z.object({
  notify_email: z.boolean().optional(),
  notify_desktop: z.boolean().optional(),
});

export function makeUserRouter(db: Database.Database): Router {
  const router = Router();

  router.get('/', requireOwner, (_req, res) => {
    const users = db
      .prepare<[], Omit<User, 'password_hash'>>(`
        SELECT id, username, role, email, notify_email, notify_desktop, created_at
        FROM users
        ORDER BY id ASC
      `)
      .all();
    res.json(users);
  });

  router.post('/', requireOwner, async (req, res) => {
    const parsed = CreateUserBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const { username, password, role, email } = parsed.data;

    if (findUserByUsername(db, username)) {
      res.status(409).json({ error: 'Username already exists' });
      return;
    }

    const hash = await hashPassword(password);
    const user = createUser(db, username, hash, role, email ?? null);

    const { password_hash: _, ...safe } = user;
    res.status(201).json(safe);
  });

  router.patch('/me/notify', (req, res) => {
    const userId = req.user?.sub;
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return; }

    const parsed = NotifyPrefsBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const { notify_email, notify_desktop } = parsed.data;
    const sets: string[] = [];
    const params: (number | boolean)[] = [];

    if (notify_email !== undefined) { sets.push('notify_email = ?'); params.push(notify_email); }
    if (notify_desktop !== undefined) { sets.push('notify_desktop = ?'); params.push(notify_desktop); }

    if (sets.length === 0) { res.json({ ok: true }); return; }

    params.push(userId);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    res.json({ ok: true });
  });

  return router;
}
