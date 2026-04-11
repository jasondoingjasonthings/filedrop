import { Router } from 'express';
import http from 'http';
import https from 'https';
import type { FileDropConfig, FolderEntry } from '@filedrop/core';

function fetchBrowse(
  host: string,
  port: number,
  secret: string,
  remotePath: string
): Promise<{ path: string; entries: FolderEntry[] }> {
  return new Promise((resolve, reject) => {
    const url = `http://${host}:${port}/peer/browse?path=${encodeURIComponent(remotePath)}`;
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const req = lib.get(url, {
      headers: { 'Authorization': `Bearer ${secret}` },
    }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`)); return; }
        try { resolve(JSON.parse(data) as { path: string; entries: FolderEntry[] }); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.setTimeout(10000, () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
  });
}

export function makeBrowseRouter(config: FileDropConfig): Router {
  const router = Router();

  /** GET /api/browse/:peerName?path= */
  router.get('/:peerName', async (req, res) => {
    const peerName = req.params['peerName'] ?? '';
    const remotePath = (req.query['path'] as string | undefined) ?? '';

    const peer = config.peers.find((p) => p.name === peerName);
    if (!peer) { res.status(404).json({ error: 'Peer not found' }); return; }

    try {
      const result = await fetchBrowse(peer.host, peer.port, config.secret, remotePath);
      res.json(result);
    } catch (err) {
      res.status(502).json({
        error: `Cannot reach peer ${peerName}: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  });

  return router;
}
