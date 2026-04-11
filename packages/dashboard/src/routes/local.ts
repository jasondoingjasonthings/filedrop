import { Router } from 'express';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import type { FileDropConfig } from '@filedrop/core';

interface DirEntry {
  name: string;
  fullPath: string;
  type: 'file' | 'dir';
}

async function listDir(dirPath: string): Promise<DirEntry[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter(e => !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        fullPath: path.join(dirPath, e.name),
        type: (e.isDirectory() ? 'dir' : 'file') as 'file' | 'dir',
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    return [];
  }
}

export function makeLocalRouter(config: FileDropConfig): Router {
  const router = Router();

  /** GET /api/local/myfiles — contents of the watch folder */
  router.get('/myfiles', async (_req, res) => {
    const dir = config.watchFolder;
    if (!existsSync(dir)) { res.json({ path: dir, exists: false, entries: [] }); return; }
    res.json({ path: dir, exists: true, entries: await listDir(dir) });
  });

  /** GET /api/local/browse?path= — browse any local directory (for folder picker) */
  router.get('/browse', async (req, res) => {
    let dirPath = (req.query['path'] as string | undefined) ?? '';

    if (!dirPath) {
      dirPath = process.platform === 'win32' ? 'C:\\' : os.homedir();
    }

    dirPath = path.resolve(dirPath);

    const parent = path.dirname(dirPath) !== dirPath ? path.dirname(dirPath) : null;

    res.json({
      path: dirPath,
      parent,
      entries: await listDir(dirPath),
    });
  });

  return router;
}
