import { Router } from 'express';
import type Database from 'better-sqlite3';

interface PeerFileRow {
  peer_name: string;
  relative_path: string;
  size_bytes: number;
  modified_at: string | null;
  downloaded_at: string | null;
}

export function makeLibraryRouter(db: Database.Database): Router {
  const router = Router();

  /** GET /api/library — all peer file records grouped by peer */
  router.get('/', (_req, res) => {
    const rows = db.prepare<[], PeerFileRow>(
      `SELECT peer_name, relative_path, size_bytes, modified_at, downloaded_at
       FROM peer_files ORDER BY peer_name, relative_path`
    ).all();
    res.json(rows);
  });

  /** GET /api/library/:peerName — records for one peer */
  router.get('/:peerName', (req, res) => {
    const rows = db.prepare<[string], PeerFileRow>(
      `SELECT peer_name, relative_path, size_bytes, modified_at, downloaded_at
       FROM peer_files WHERE peer_name = ? ORDER BY relative_path`
    ).all(req.params['peerName'] ?? '');
    res.json(rows);
  });

  return router;
}
