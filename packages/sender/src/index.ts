import type Database from 'better-sqlite3';
import type { FileDropConfig, TransferQueue } from '@filedrop/core';
import { FileWatcher } from './watcher.js';
import { UploadWorker } from './uploader.js';

export { FileWatcher } from './watcher.js';
export { UploadWorker, computeMd5 } from './uploader.js';

export interface SenderHandle {
  stop: () => Promise<void>;
}

export async function startSender(
  config: FileDropConfig,
  db: Database.Database,
  queue: TransferQueue
): Promise<SenderHandle> {
  const watcher = new FileWatcher({
    watchFolder: config.sender.watchFolder,
    stabilityMs: config.sender.stabilityMs,
  });

  const worker = new UploadWorker(config, queue, db);

  watcher.on('stable', (filePath) => {
    worker.enqueueFile(filePath).catch((err: unknown) => {
      console.error('[sender] Failed to enqueue file:', err);
    });
  });

  watcher.on('error', (err) => {
    console.error('[sender] Watcher error:', err);
  });

  worker.start();
  watcher.start();

  console.log(`[sender] Watching: ${config.sender.watchFolder}`);

  return {
    stop: async () => {
      worker.stop();
      await watcher.stop();
    },
  };
}

// Run as standalone daemon when invoked directly
if (require.main === module) {
  void (async () => {
    const { loadConfig, getDb, TransferQueue } = await import('@filedrop/core');
    const config = loadConfig();
    const db = getDb();
    const queue = new TransferQueue(db, { concurrency: config.sender.concurrency });

    const handle = await startSender(config, db, queue);

    const shutdown = async (): Promise<void> => {
      console.log('[sender] Shutting down...');
      await handle.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => { void shutdown(); });
    process.on('SIGTERM', () => { void shutdown(); });
  })();
}
