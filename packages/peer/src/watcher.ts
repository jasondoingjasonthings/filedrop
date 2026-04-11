import chokidar from 'chokidar';
import { EventEmitter } from 'events';
import fs from 'fs';

interface WatcherOptions {
  watchFolder: string;
  stabilityMs?: number;
}

interface WatcherEventMap {
  /** A file has been stable (done writing) for stabilityMs */
  file_stable: [filePath: string];
  /** A new file/folder appeared (immediate, before stability check) */
  file_added: [relativePath: string, sizBytes: number];
  /** Drive/folder went missing */
  drive_missing: [];
  /** Drive/folder came back */
  drive_restored: [];
  error: [err: Error];
}

export declare interface FolderWatcher {
  on<K extends keyof WatcherEventMap>(event: K, listener: (...args: WatcherEventMap[K]) => void): this;
  emit<K extends keyof WatcherEventMap>(event: K, ...args: WatcherEventMap[K]): boolean;
}

export class FolderWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private driveCheckTimer: ReturnType<typeof setInterval> | null = null;
  private driveOk = true;
  private readonly stabilityMs: number;

  constructor(private readonly opts: WatcherOptions) {
    super();
    this.stabilityMs = opts.stabilityMs ?? 3000;
  }

  start(): void {
    if (this.watcher) return;
    this.startWatcher();
    this.startDriveCheck();
  }

  stop(): Promise<void> {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    if (this.driveCheckTimer) { clearInterval(this.driveCheckTimer); this.driveCheckTimer = null; }
    return this.watcher ? this.watcher.close() : Promise.resolve();
  }

  get folderAvailable(): boolean { return this.driveOk; }

  private startWatcher(): void {
    const { watchFolder } = this.opts;

    if (!fs.existsSync(watchFolder)) {
      try { fs.mkdirSync(watchFolder, { recursive: true }); } catch { /* ignore */ }
    }

    this.watcher = chokidar.watch(watchFolder, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: false,
      ignored: /(^|[/\\])\../,
    });

    this.watcher.on('add', (filePath) => {
      try {
        const stat = fs.statSync(filePath);
        const rel = filePath.replace(watchFolder, '').replace(/^[/\\]/, '').split(/[/\\]/).join('/');
        this.emit('file_added', rel, stat.size);
      } catch { /* file may have disappeared */ }
      this.scheduleStability(filePath);
    });

    this.watcher.on('change', (filePath) => {
      this.scheduleStability(filePath);
    });

    this.watcher.on('error', (err) => {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });
  }

  private startDriveCheck(): void {
    this.driveCheckTimer = setInterval(() => {
      const exists = fs.existsSync(this.opts.watchFolder);
      if (!exists && this.driveOk) {
        this.driveOk = false;
        this.emit('drive_missing');
      } else if (exists && !this.driveOk) {
        this.driveOk = true;
        this.emit('drive_restored');
        // Restart watcher
        void this.watcher?.close().then(() => {
          this.watcher = null;
          this.startWatcher();
        });
      }
    }, 10000);
  }

  private scheduleStability(filePath: string): void {
    const existing = this.pending.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pending.delete(filePath);
      if (fs.existsSync(filePath)) {
        this.emit('file_stable', filePath);
      }
    }, this.stabilityMs);

    this.pending.set(filePath, timer);
  }
}
