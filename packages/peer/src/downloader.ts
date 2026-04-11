/**
 * Direct HTTP downloader — pulls files from a peer's /peer/file endpoint.
 * Supports resume via HTTP Range requests.
 * Reports completion back to the hub so the Library tab stays current.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import type { FileDropConfig, Transfer, TransferQueue, PeerConfig } from '@filedrop/core';

const MAX_RETRIES = 5;
const RETRY_BASE_MS = 2000;

function backoffMs(attempt: number): number {
  return RETRY_BASE_MS * Math.pow(2, attempt);
}

async function computeMd5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Build the base URL for a peer's file server. */
function peerBaseUrl(peer: PeerConfig): string {
  // Assume HTTP for local/Tailscale connections (HTTPS would need certs)
  return `http://${peer.host}:${peer.port}`;
}

interface DownloadWorkerEvents {
  downloaded: (transfer: Transfer, destPath: string) => void;
  failed: (transfer: Transfer) => void;
}

export declare interface PeerDownloader {
  on<K extends keyof DownloadWorkerEvents>(event: K, listener: DownloadWorkerEvents[K]): this;
  emit<K extends keyof DownloadWorkerEvents>(event: K, ...args: Parameters<DownloadWorkerEvents[K]>): boolean;
}

export class PeerDownloader extends EventEmitter {
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: FileDropConfig,
    private readonly queue: TransferQueue,
    private readonly db: Database.Database
  ) {
    super();
  }

  /** Enqueue a file download from a peer. */
  enqueue(
    peer: PeerConfig,
    remotePath: string,
    filename: string,
    sizeBytes: number,
    localPath: string
  ): Transfer {
    const transfer = this.queue.enqueue({
      filename,
      local_path: localPath,
      source_path: remotePath,
      size_bytes: sizeBytes,
      md5: '',
      direction: 'download',
      priority: 100,
      project: null,
      peer_name: peer.name,
    });

    // Store peer URL in memory map keyed by transfer id
    this.peerMap.set(transfer.id, peer);

    this.poll();
    return transfer;
  }

  private readonly peerMap = new Map<number, PeerConfig>();

  start(): void {
    this.running = true;
    this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  private poll(): void {
    if (!this.running) return;
    const transfer = this.queue.dequeue();
    if (transfer && transfer.direction === 'download') {
      void this.processTransfer(transfer).then(() => this.schedulePoll(500));
    } else {
      this.schedulePoll(3000);
    }
  }

  private schedulePoll(ms: number): void {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => { this.pollTimer = null; this.poll(); }, ms);
  }

  private async processTransfer(transfer: Transfer): Promise<void> {
    const { id, filename, local_path, source_path, retry_count, peer_name } = transfer;

    // Find the peer config
    let peer = this.peerMap.get(id);
    if (!peer && peer_name) {
      peer = this.config.peers.find((p) => p.name === peer_name);
    }
    if (!peer) {
      this.queue.fail(id, `Unknown peer: ${peer_name ?? 'none'}`);
      return;
    }

    // Ensure destination directory exists
    const destDir = path.dirname(local_path);
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

    const tmpPath = `${local_path}.tmp`;

    // Check for partial download (for resume)
    let resumeFrom = 0;
    if (fs.existsSync(tmpPath)) {
      try { resumeFrom = fs.statSync(tmpPath).size; } catch { resumeFrom = 0; }
    }

    try {
      console.log(`[peer] Downloading: ${filename} from ${peer.name}${resumeFrom > 0 ? ` (resuming at ${resumeFrom})` : ''}`);

      const url = `${peerBaseUrl(peer)}/peer/file?path=${encodeURIComponent(source_path)}`;
      const totalBytes = await this.streamDownload(url, tmpPath, resumeFrom, peer, (received, total) => {
        const pct = total > 0 ? Math.round((received / total) * 90) : 0;
        this.queue.updateProgress(id, pct);
      });

      this.queue.updateProgress(id, 95);

      // MD5 verification (only if server sent it)
      const actualMd5 = await computeMd5(tmpPath);

      // Atomic rename
      fs.renameSync(tmpPath, local_path);

      // Update md5 in DB
      this.db.prepare(`UPDATE transfers SET md5 = ? WHERE id = ?`).run(actualMd5, id);

      this.queue.complete(id);
      console.log(`[peer] Done: ${filename} → ${local_path}`);

      // Record in peer_files for Library view
      this.recordDownloaded(peer.name, source_path, totalBytes);

      // Report completion back to the hub so its Library tab updates
      void this.reportToHub(peer, source_path, totalBytes);

      this.peerMap.delete(id);
      this.emit('downloaded', transfer, local_path);
    } catch (err) {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }

      const message = err instanceof Error ? err.message : String(err);
      const attempt = retry_count + 1;

      if (attempt >= MAX_RETRIES) {
        this.queue.fail(id, `Failed after ${MAX_RETRIES} attempts: ${message}`);
        console.error(`[peer] Permanent failure: ${filename} — ${message}`);
        this.peerMap.delete(id);
        this.emit('failed', transfer);
      } else {
        const delay = backoffMs(attempt);
        console.warn(`[peer] Retry ${attempt}/${MAX_RETRIES} for ${filename} in ${delay}ms — ${message}`);
        this.queue.fail(id, message);
        setTimeout(() => { this.queue.retry(id); this.poll(); }, delay);
      }
    }
  }

  private streamDownload(
    url: string,
    tmpPath: string,
    resumeFrom: number,
    peer: PeerConfig,
    onProgress: (received: number, total: number) => void
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.config.secret}`,
      };
      if (resumeFrom > 0) headers['Range'] = `bytes=${resumeFrom}-`;

      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === 'https:' ? https : http;

      const req = lib.get(url, { headers }, (res) => {
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          reject(new Error(`HTTP ${res.statusCode ?? 'unknown'} from peer`));
          return;
        }

        const contentLength = parseInt(res.headers['content-length'] ?? '0', 10);
        const totalBytes = resumeFrom + contentLength;
        let received = resumeFrom;

        const flag = resumeFrom > 0 ? 'a' : 'w';
        const file = fs.createWriteStream(tmpPath, { flags: flag });

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          onProgress(received, totalBytes);
        });

        res.pipe(file);

        file.on('finish', () => resolve(totalBytes));
        file.on('error', reject);
        res.on('error', reject);
      });

      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(new Error('Request timeout')); });
    });
  }

  private recordDownloaded(peerName: string, relativePath: string, sizeBytes: number): void {
    this.db.prepare(`
      INSERT INTO peer_files (peer_name, relative_path, size_bytes, downloaded_at)
      VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      ON CONFLICT (peer_name, relative_path) DO UPDATE SET
        downloaded_at = excluded.downloaded_at,
        size_bytes = excluded.size_bytes
    `).run(peerName, relativePath, sizeBytes);
  }

  private async reportToHub(peer: PeerConfig, relativePath: string, sizeBytes: number): Promise<void> {
    try {
      const url = `${peerBaseUrl(peer)}/peer/report`;
      const body = JSON.stringify({
        peer_name: this.config.name,
        relative_path: relativePath,
        size_bytes: sizeBytes,
      });

      await new Promise<void>((resolve, reject) => {
        const parsedUrl = new URL(url);
        const lib = parsedUrl.protocol === 'https:' ? https : http;
        const req = lib.request(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.config.secret}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        }, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    } catch (err) {
      // Non-fatal — Library view on hub will just be slightly delayed
      console.warn(`[peer] Could not report download to hub: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
