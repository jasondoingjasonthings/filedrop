import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import type { B2Client, FileDropConfig, Manifest, Transfer, TransferQueue } from '@filedrop/core';

const MAX_RETRIES = 5;
const RETRY_BASE_MS = 2000;

/**
 * Compute MD5 hex of a file on disk.
 */
async function computeMd5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Resolve the final destination path for a downloaded file.
 *
 * autoSort=true:  {downloadFolder}/{YYYY-MM-DD}/{project}/filename
 * autoSort=false: {downloadFolder}/filename
 */
function resolveDestPath(
  filename: string,
  project: string | null,
  config: FileDropConfig
): string {
  const { downloadFolder, autoSort, sortPattern } = config.receiver;

  if (!autoSort) {
    return path.join(downloadFolder, filename);
  }

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const projectSegment = project ?? 'unsorted';

  const subDir = sortPattern
    .replace('{date}', date)
    .replace('{project}', projectSegment);

  return path.join(downloadFolder, subDir, filename);
}

/**
 * Resolve dest for a file that has a relative path (preserves folder structure).
 * The relative path is always stored with forward slashes.
 */
function resolveDestPathRelative(relativePath: string, config: FileDropConfig): string {
  const { downloadFolder } = config.receiver;
  // Convert forward slashes back to OS-native separators
  const nativePath = relativePath.split('/').join(path.sep);
  return path.join(downloadFolder, nativePath);
}

function backoffMs(attempt: number): number {
  return RETRY_BASE_MS * Math.pow(2, attempt);
}

interface DownloadWorkerEvents {
  downloaded: (transfer: Transfer, destPath: string) => void;
  failed: (transfer: Transfer) => void;
}

export declare interface DownloadWorker {
  on<K extends keyof DownloadWorkerEvents>(event: K, listener: DownloadWorkerEvents[K]): this;
  emit<K extends keyof DownloadWorkerEvents>(event: K, ...args: Parameters<DownloadWorkerEvents[K]>): boolean;
}

export class DownloadWorker extends EventEmitter {
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly b2: B2Client,
    private readonly config: FileDropConfig,
    private readonly queue: TransferQueue,
    private readonly db: Database.Database
  ) {
    super();
  }

  /**
   * Enqueue a download from a received manifest.
   * Called by the ManifestPoller when a new manifest arrives,
   * or when the user manually selects a file from the Available tab.
   */
  enqueueFromManifest(manifest: Manifest): Transfer {
    // If the manifest has a relative_path, preserve the folder structure
    // inside the download folder rather than flattening to a single dir.
    const destPath = manifest.relative_path
      ? resolveDestPathRelative(manifest.relative_path, this.config)
      : resolveDestPath(manifest.filename, manifest.project, this.config);

    const transfer = this.queue.enqueue({
      filename: manifest.filename,
      local_path: destPath,
      b2_key: manifest.b2_key,
      size_bytes: manifest.size_bytes,
      md5: manifest.md5,
      direction: 'download',
      priority: 100,
      project: manifest.project,
    });

    console.log(`[receiver] Enqueued download: ${manifest.filename}`);
    this.poll();
    return transfer;
  }

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
    if (transfer && transfer.direction === 'download') {
      void this.processTransfer(transfer).then(() => this.schedulePoll(500));
    } else {
      this.schedulePoll(3000);
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
    const { id, filename, local_path, b2_key, md5, retry_count, size_bytes } = transfer;

    // Ensure destination directory exists
    const destDir = path.dirname(local_path);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const tmpPath = `${local_path}.tmp`;

    try {
      console.log(`[receiver] Downloading: ${filename}`);

      await this.b2.downloadFile(b2_key, tmpPath);

      // Progress approximation: mark 90% after download completes
      this.queue.updateProgress(id, 90);

      // MD5 verification
      const actualMd5 = await computeMd5(tmpPath);
      if (actualMd5 !== md5) {
        fs.unlinkSync(tmpPath);
        throw new Error(
          `MD5 mismatch: expected ${md5}, got ${actualMd5}`
        );
      }

      // Atomic rename
      fs.renameSync(tmpPath, local_path);

      this.queue.complete(id);
      console.log(`[receiver] Done: ${filename} → ${local_path}`);

      // Emit event for notify package to pick up
      this.emit('downloaded', transfer, local_path);
    } catch (err) {
      // Clean up partial download
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      }

      const message = err instanceof Error ? err.message : String(err);
      const attempt = retry_count + 1;

      if (attempt >= MAX_RETRIES) {
        this.queue.fail(id, `Failed after ${MAX_RETRIES} attempts: ${message}`);
        console.error(`[receiver] Permanent failure: ${filename} — ${message}`);
        this.emit('failed', transfer);
      } else {
        const delay = backoffMs(attempt);
        console.warn(
          `[receiver] Retry ${attempt}/${MAX_RETRIES} for ${filename} in ${delay}ms — ${message}`
        );
        this.queue.fail(id, message);
        setTimeout(() => {
          this.queue.retry(id);
          this.poll();
        }, delay);
      }
    }
  }

}
