import type Database from 'better-sqlite3';
import type { B2Client, FileDropConfig, Manifest, TransferQueue } from '@filedrop/core';
import { ManifestPoller } from './poller.js';
import { DownloadWorker } from './downloader.js';

export { ManifestPoller } from './poller.js';
export { DownloadWorker } from './downloader.js';

export interface ReceiverHandle {
  stop: () => void;
}

/** Insert a manifest into available_files for manual-pick mode. */
function storeAvailable(db: Database.Database, manifestKey: string, manifest: Manifest): void {
  db.prepare(
    `INSERT OR IGNORE INTO available_files (manifest_key, manifest_json) VALUES (?, ?)`
  ).run(manifestKey, JSON.stringify(manifest));
  console.log(`[receiver] Available: ${manifest.filename} (manual pick mode)`);
}

export function startReceiver(
  config: FileDropConfig,
  db: Database.Database,
  queue: TransferQueue,
  b2: B2Client
): ReceiverHandle {
  const worker = new DownloadWorker(b2, config, queue, db);
  const autoDownload = config.receiver.autoDownload;

  const poller = new ManifestPoller(b2, db, {
    downloadPrefix: config.b2.downloadPrefix,
    pollIntervalMs: config.receiver.pollIntervalMs,
  });

  poller.on('manifest', (manifest, manifestKey) => {
    if (autoDownload) {
      worker.enqueueFromManifest(manifest);
    } else {
      storeAvailable(db, manifestKey, manifest);
    }
  });

  poller.on('error', (err) => {
    console.error('[receiver] Poller error:', err.message);
  });

  worker.start();
  poller.start();

  console.log(`[receiver] Polling: ${config.b2.downloadPrefix} every ${config.receiver.pollIntervalMs}ms`);
  console.log(`[receiver] Download folder: ${config.receiver.downloadFolder}`);

  return {
    stop: () => {
      poller.stop();
      worker.stop();
    },
  };
}

// Run as standalone daemon when invoked directly
if (require.main === module) {
  void (async () => {
    const { loadConfig, getDb, TransferQueue, B2Client } = await import('@filedrop/core');
    const config = loadConfig();
    const db = getDb();
    const queue = new TransferQueue(db, { concurrency: config.sender.concurrency });
    const b2 = new B2Client(config.b2);

    const handle = startReceiver(config, db, queue, b2);

    const shutdown = (): void => {
      console.log('[receiver] Shutting down...');
      handle.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })();
}
