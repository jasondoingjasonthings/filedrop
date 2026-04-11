import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { FileDropConfigSchema, saveConfig } from '@filedrop/core';
import type Database from 'better-sqlite3';
import { ownerExists, hashPassword, createUser } from '../auth.js';

const SetupBody = z.object({
  config: FileDropConfigSchema,
  owner: z.object({
    username: z.string().min(1).max(64),
    password: z.string().min(8),
    email: z.string().email().optional(),
  }),
});

export function makeSetupRouter(db: Database.Database): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    if (ownerExists(db)) { res.redirect('/'); return; }
    const builtRole = process.env['FILEDROP_BUILT_ROLE'] ?? '';
    let html = fs.readFileSync(path.join(__dirname, '../html/setup.html'), 'utf-8');
    if (builtRole) {
      html = html.replace('value=""', `value="${builtRole}"`);
    }
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });

  router.post('/', async (req, res) => {
    if (ownerExists(db)) { res.status(403).json({ error: 'Setup already complete' }); return; }

    const parsed = SetupBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const { config, owner } = parsed.data;

    try {
      saveConfig(config);
      const hash = await hashPassword(owner.password);
      createUser(db, owner.username, hash, 'owner', owner.email ?? null);
      res.json({ ok: true });
      // Relaunch the process so the full app boots with the new config
      setTimeout(() => {
        const { spawn } = require('child_process') as typeof import('child_process');
        spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore' }).unref();
        process.exit(0);
      }, 500);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
