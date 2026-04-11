import { Router } from 'express';
import { z } from 'zod';
import fs from 'fs';
import type { FileDropConfig } from '@filedrop/core';
import { FileDropConfigSchema, saveConfig } from '@filedrop/core';
import type Database from 'better-sqlite3';

const FolderUpdateBody = z.object({
  watchFolder:    z.string().min(1).optional(),
  downloadFolder: z.string().min(1).optional(),
});

export function makeSettingsRouter(config: FileDropConfig, db: Database.Database): Router {
  const router = Router();

  /** GET /api/settings — current config (minus secret) */
  router.get('/', (_req, res) => {
    const { secret: _secret, ...safe } = config;
    res.json(safe);
  });

  /** PATCH /api/settings/folders — update watch/download folder paths */
  router.patch('/folders', (req, res) => {
    const parsed = FolderUpdateBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

    const { watchFolder, downloadFolder } = parsed.data;

    if (watchFolder) {
      if (!fs.existsSync(watchFolder)) {
        try { fs.mkdirSync(watchFolder, { recursive: true }); }
        catch { res.status(400).json({ error: `Cannot create folder: ${watchFolder}` }); return; }
      }
      (config as { watchFolder: string }).watchFolder = watchFolder;
    }

    if (downloadFolder) {
      if (!fs.existsSync(downloadFolder)) {
        try { fs.mkdirSync(downloadFolder, { recursive: true }); }
        catch { res.status(400).json({ error: `Cannot create folder: ${downloadFolder}` }); return; }
      }
      (config as { downloadFolder: string }).downloadFolder = downloadFolder;
    }

    try {
      saveConfig(config);
      res.json({ ok: true, watchFolder: config.watchFolder, downloadFolder: config.downloadFolder });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
