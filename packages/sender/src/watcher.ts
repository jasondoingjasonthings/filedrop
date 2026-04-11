import chokidar from 'chokidar';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

interface WatcherOptions {
  watchFolder: string;
  stabilityMs: number;
}

interface WatcherEventMap {
  stable: [filePath: string];
  error: [err: Error];
}

export declare interface FileWatcher {
  on<K extends keyof WatcherEventMap>(
    event: K,
    listener: (...args: WatcherEventMap[K]) => void
  ): this;
  emit<K extends keyof WatcherEventMap>(
    event: K,
    ...args: WatcherEventMap[K]
  ): boolean;
}

/**
 * Watches a folder for new files and emits 'stable' only once a file
 * has stopped growing for `stabilityMs` milliseconds.
 * This prevents partial uploads of in-progress copies.
 */
export class FileWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly opts: WatcherOptions) {
    super();
  }

  start(): void {
    if (this.watcher) return;

    const { watchFolder, stabilityMs } = this.opts;

    if (!fs.existsSync(watchFolder)) {
      fs.mkdirSync(watchFolder, { recursive: true });
    }

    this.watcher = chokidar.watch(watchFolder, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: false,
      // No depth limit — watch the full folder tree including subdirectories
      ignored: /(^|[/\\])\../, // ignore dotfiles
    });

    this.watcher.on('add', (filePath) => this.scheduleStabilityCheck(filePath, stabilityMs));
    this.watcher.on('change', (filePath) => this.scheduleStabilityCheck(filePath, stabilityMs));
    this.watcher.on('error', (err) => this.emit('error', err instanceof Error ? err : new Error(String(err))));
  }

  stop(): Promise<void> {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    return this.watcher ? this.watcher.close() : Promise.resolve();
  }

  private scheduleStabilityCheck(filePath: string, delayMs: number): void {
    const abs = path.resolve(filePath);

    const existing = this.pending.get(abs);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pending.delete(abs);
      if (fs.existsSync(abs)) {
        this.emit('stable', abs);
      }
    }, delayMs);

    this.pending.set(abs, timer);
  }
}
