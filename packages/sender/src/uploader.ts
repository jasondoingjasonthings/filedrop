import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { B2Client, TransferQueue } from '@filedrop/core';
import type { FileDropConfig, Manifest, Transfer } from '@filedrop/core';

const MAX_RETRIES = 5;
const RETRY_BASE_MS = 2000;

/**
 * Compute MD5 hex of a file on disk.
 */
export async function computeMd5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Check if a file with this MD5 + filename has already been uploaded.
 */
function isDuplicate(db: Database.Database, filename: string, md5: string): boolean {
  const row = db
    .prepare<[string, string], { n: number }>(
      `SELECT COUNT(*) AS n FROM transfers
       WHERE filename = ? AND md5 = ? AND direction = 'upload'
         AND status IN ('active', 'done', 'queued', 'pending')`
    )
    .get(filename, md5);
  return (row?.n ?? 0) > 0;
}

/**
 * Exponential backoff: 2s, 4s, 8s, 16s, 32s
 */
function backoffMs(attempt: number): number {
  return RETRY_BASE_MS * Math.pow(2, attempt);
}

export class UploadWorker {
  private readonly b2: B2Client;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: FileDropConfig,
    private readonly queue: TransferQueue,
    private readonly db: Database.Database
  ) {
    this.b2 = new B2Client(config.b2);
  }

  /**
   * Called by the watcher when a new stable file is detected.
   * Computes MD5, checks for duplicates, then enqueues the transfer.
   */
  async enqueueFile(filePath: string): Promise<Transfer | null> {
    const filename = path.basename(filePath);
    const watchFolder = this.config.sender.watchFolder;

    // Compute path relative to watchFolder (e.g. "project-x/video.mp4")
    const relativePath = path.relative(watchFolder, filePath);
    // Normalise to forward slashes for B2 key and manifest portability
    const relativePathFwd = relativePath.split(path.sep).join('/');

    const { size: size_bytes } = fs.statSync(filePath);
    const md5 = await computeMd5(filePath);

    if (isDuplicate(this.db, filename, md5)) {
      console.log(`[sender] Skipping duplicate: ${filename}`);
      return null;
    }

    // Preserve folder structure in the B2 key
    const b2Key = `${this.config.b2.uploadPrefix}${relativePathFwd}`;

    const transfer = this.queue.enqueue({
      filename,
      local_path: filePath,
      b2_key: b2Key,
      size_bytes,
      md5,
      direction: 'upload',
      priority: 100,
      project: null,
    });

    console.log(`[sender] Enqueued: ${filename} (${size_bytes} bytes)`);
    this.poll(); // kick the worker immediately
    return transfer;
  }

  /** Start the upload loop. */
  start(): void {
    this.running = true;
    this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private poll(): void {
    if (!this.running) return;

    const transfer = this.queue.dequeue();
    if (transfer) {
      // Fire and forget — poll again after this one starts
      void this.processTransfer(transfer).then(() => this.schedulePoll(500));
    } else {
      this.schedulePoll(2000);
    }
  }

  private schedulePoll(ms: number): void {
    if (!this.running) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.poll();
    }, ms);
  }

  private async processTransfer(transfer: Transfer): Promise<void> {
    const { id, filename, local_path, b2_key, md5, retry_count } = transfer;

    if (!fs.existsSync(local_path)) {
      this.queue.fail(id, `File not found: ${local_path}`);
      return;
    }

    try {
      console.log(`[sender] Uploading: ${filename}`);

      await this.b2.uploadFile(local_path, b2_key, (pct) => {
        this.queue.updateProgress(id, pct);
      });

      // Write manifest to signal receiver
      // Derive relative_path from b2_key by stripping the uploadPrefix
      const uploadPrefix = this.config.b2.uploadPrefix;
      const relPath = b2_key.startsWith(uploadPrefix)
        ? b2_key.slice(uploadPrefix.length)
        : null;
      // Null it out if it's just the flat filename (no directory component)
      const relative_path = relPath && relPath.includes('/') ? relPath : null;

      const manifest: Manifest = {
        id: crypto.randomUUID(),
        filename,
        relative_path,
        b2_key,
        size_bytes: transfer.size_bytes,
        md5,
        uploaded_at: new Date().toISOString(),
        project: transfer.project,
      };

      await this.b2.writeManifest(manifest, this.config.b2.uploadPrefix);

      this.queue.complete(id);
      console.log(`[sender] Done: ${filename}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempt = retry_count + 1;

      if (attempt >= MAX_RETRIES) {
        this.queue.fail(id, `Failed after ${MAX_RETRIES} attempts: ${message}`);
        console.error(`[sender] Permanent failure: ${filename} — ${message}`);
      } else {
        const delay = backoffMs(attempt);
        console.warn(`[sender] Retry ${attempt}/${MAX_RETRIES} for ${filename} in ${delay}ms — ${message}`);
        this.queue.fail(id, message); // marks error + increments retry_count
        setTimeout(() => {
          this.queue.retry(id);
          this.poll();
        }, delay);
      }
    }
  }
}
