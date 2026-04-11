import type Database from 'better-sqlite3';
import type { FileDropConfig, TransferQueue } from '@filedrop/core';
import { SseBus } from './sse-bus.js';
import { FolderWatcher } from './watcher.js';
import { makePeerRouter } from './file-server.js';
import { PeerDownloader } from './downloader.js';
import { SyncEngine } from './sync-engine.js';
import { PeerMonitor } from './peer-monitor.js';

export { SseBus } from './sse-bus.js';
export { FolderWatcher } from './watcher.js';
export { makePeerRouter } from './file-server.js';
export { PeerDownloader } from './downloader.js';
export { SyncEngine } from './sync-engine.js';
export { PeerMonitor } from './peer-monitor.js';

export interface PeerHandle {
  sseBus: SseBus;
  peerRouter: ReturnType<typeof makePeerRouter>;
  monitor: PeerMonitor;
  syncEngine: SyncEngine;
  downloader: PeerDownloader;
  watcher: FolderWatcher;
  stop: () => Promise<void>;
}

export function startPeer(
  config: FileDropConfig,
  db: Database.Database,
  queue: TransferQueue
): PeerHandle {
  const sseBus = new SseBus();

  const watcher = new FolderWatcher({ watchFolder: config.watchFolder });

  let watchFolderOk = true;
  watcher.on('drive_missing', () => {
    watchFolderOk = false;
    console.warn('[peer] Watch folder missing — drive may have been unplugged');
    sseBus.broadcast('drive_status', { ok: false, folder: config.watchFolder });
  });
  watcher.on('drive_restored', () => {
    watchFolderOk = true;
    console.log('[peer] Watch folder restored');
    sseBus.broadcast('drive_status', { ok: true, folder: config.watchFolder });
  });
  watcher.on('file_added', (relativePath, sizeBytes) => {
    // Notify subscribed spokes via SSE so they pick up new files immediately
    sseBus.broadcast('folder_changed', { path: relativePath, size_bytes: sizeBytes });
  });

  const peerRouter = makePeerRouter(config, db, sseBus, () => watchFolderOk);

  const downloader = new PeerDownloader(config, queue, db);

  const syncEngine = new SyncEngine(config, db, downloader);
  syncEngine.on('error', (err) => console.error('[sync]', err.message));

  const monitor = new PeerMonitor(config, sseBus);

  watcher.start();
  downloader.start();

  if (config.peers.length > 0) {
    monitor.start();
    syncEngine.start();
  }

  console.log(`[peer] Sharing: ${config.watchFolder}`);
  console.log(`[peer] Downloading to: ${config.downloadFolder}`);

  return {
    sseBus,
    peerRouter,
    monitor,
    syncEngine,
    downloader,
    watcher,
    stop: async () => {
      monitor.stop();
      syncEngine.stop();
      downloader.stop();
      await watcher.stop();
    },
  };
}
