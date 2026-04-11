/**
 * Peer file server — mounts on /peer/* of the main Express app.
 *
 * Endpoints (all require Authorization: Bearer <secret>):
 *   GET  /peer/status          machine health + summary
 *   GET  /peer/browse?path=    folder tree (path relative to watchFolder, default root)
 *   GET  /peer/file?path=      stream a file (supports Range for resume)
 *   GET  /peer/events          SSE stream of folder change events
 *   POST /peer/report          spoke reports a completed download to hub
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type Database from 'better-sqlite3';
import type { FileDropConfig, FolderEntry } from '@filedrop/core';
import type { SseBus } from './sse-bus.js';

// ─── Auth middleware ──────────────────────────────────────────────────────────

function makePeerAuth(secret: string) {
  return (req: Request, res: Response, next: () => void): void => {
    const auth = req.headers['authorization'] ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== secret) {
      res.status(401).json({ error: 'Invalid peer secret' });
      return;
    }
    next();
  };
}

// ─── Folder scanning ─────────────────────────────────────────────────────────

function scanFolder(absPath: string, watchFolder: string): FolderEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: FolderEntry[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(absPath, entry.name);
    const relPath = path.relative(watchFolder, fullPath).split(path.sep).join('/');

    if (entry.isDirectory()) {
      result.push({
        type: 'folder',
        name: entry.name,
        relative_path: relPath,
        size_bytes: 0,
        modified_at: '',
        children: scanFolder(fullPath, watchFolder),
      });
    } else if (entry.isFile()) {
      let stat: fs.Stats;
      try { stat = fs.statSync(fullPath); } catch { continue; }
      result.push({
        type: 'file',
        name: entry.name,
        relative_path: relPath,
        size_bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
        children: [],
      });
    }
  }

  return result.sort((a, b) => {
    // Folders first, then alphabetical
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Validate that a requested path stays within watchFolder (prevent traversal). */
function safePath(watchFolder: string, requestedPath: string): string | null {
  const resolved = path.resolve(watchFolder, requestedPath);
  if (!resolved.startsWith(path.resolve(watchFolder))) return null;
  return resolved;
}

// ─── Drive free space ────────────────────────────────────────────────────────

interface DfRow { available: bigint }

function getDriveFreeBytes(folder: string): number | null {
  try {
    const stat = fs.statfsSync(folder) as unknown as { bavail: number; bsize: number };
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

function countFiles(folder: string): number {
  let count = 0;
  try {
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else if (e.isFile()) count++;
      }
    };
    walk(folder);
  } catch { /* ignore */ }
  return count;
}

// ─── Report body type ────────────────────────────────────────────────────────

interface ReportBody {
  peer_name: string;
  relative_path: string;
  size_bytes: number;
}

// ─── Router factory ──────────────────────────────────────────────────────────

export function makePeerRouter(
  config: FileDropConfig,
  db: Database.Database,
  sseBus: SseBus,
  getWatchFolderOk: () => boolean
): Router {
  const router = Router();
  const auth = makePeerAuth(config.secret);

  // ── Status ──────────────────────────────────────────────────────────────────

  router.get('/status', auth, (_req, res) => {
    const watchFolderOk = getWatchFolderOk();
    res.json({
      online: true,
      name: config.name,
      role: config.role,
      version: '2.0.0',
      watch_folder_ok: watchFolderOk,
      drive_free_bytes: watchFolderOk ? getDriveFreeBytes(config.watchFolder) : null,
      file_count: watchFolderOk ? countFiles(config.watchFolder) : 0,
      uptime_ms: process.uptime() * 1000,
    });
  });

  // ── Browse ──────────────────────────────────────────────────────────────────

  router.get('/browse', auth, (req, res) => {
    const requestedPath = (req.query['path'] as string | undefined) ?? '';
    const safe = safePath(config.watchFolder, requestedPath);

    if (!safe) { res.status(400).json({ error: 'Invalid path' }); return; }
    if (!fs.existsSync(safe)) { res.status(404).json({ error: 'Path not found' }); return; }

    const entries = scanFolder(safe, config.watchFolder);
    res.json({ path: requestedPath, entries });
  });

  // ── File download (with Range support for resume) ───────────────────────────

  router.get('/file', auth, (req, res) => {
    const requestedPath = (req.query['path'] as string | undefined) ?? '';
    const safe = safePath(config.watchFolder, requestedPath);

    if (!safe) { res.status(400).json({ error: 'Invalid path' }); return; }

    let stat: fs.Stats;
    try { stat = fs.statSync(safe); } catch { res.status(404).json({ error: 'File not found' }); return; }

    const total = stat.size;
    const range = req.headers['range'];

    // Send MD5 header if a companion .md5 sidecar exists (optional)
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-File-Size', String(total));
    res.setHeader('X-File-Modified', stat.mtime.toISOString());

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr ?? '0', 10);
      const end = endStr ? parseInt(endStr, 10) : total - 1;
      const chunkSize = end - start + 1;

      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(chunkSize));

      const stream = fs.createReadStream(safe, { start, end });
      stream.pipe(res);
    } else {
      res.setHeader('Content-Length', String(total));
      fs.createReadStream(safe).pipe(res);
    }
  });

  // ── SSE events (folder changes) ─────────────────────────────────────────────

  router.get('/events', auth, (req, res) => {
    const cleanup = sseBus.connect(res);
    req.on('close', cleanup);
  });

  // ── Report (spoke → hub: "I downloaded this file") ──────────────────────────

  router.post('/report', auth, (req, res) => {
    const body = req.body as Partial<ReportBody>;
    if (!body.peer_name || !body.relative_path) {
      res.status(400).json({ error: 'Missing peer_name or relative_path' });
      return;
    }

    db.prepare(`
      INSERT INTO peer_files (peer_name, relative_path, size_bytes, downloaded_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ON CONFLICT (peer_name, relative_path) DO UPDATE SET
        downloaded_at = excluded.downloaded_at,
        size_bytes = excluded.size_bytes
    `).run(body.peer_name, body.relative_path, body.size_bytes ?? 0);

    // Broadcast to dashboard SSE so Library tab updates live
    sseBus.broadcast('peer_downloaded', {
      peer_name: body.peer_name,
      relative_path: body.relative_path,
    });

    res.json({ ok: true });
  });

  return router;
}
