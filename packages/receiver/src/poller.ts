import { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import type { B2Client, Manifest } from '@filedrop/core';

interface PollerOptions {
  downloadPrefix: string;
  pollIntervalMs: number;
}

interface PollerEventMap {
  manifest: [manifest: Manifest, manifestKey: string];
  error: [err: Error];
}

export declare interface ManifestPoller {
  on<K extends keyof PollerEventMap>(
    event: K,
    listener: (...args: PollerEventMap[K]) => void
  ): this;
  emit<K extends keyof PollerEventMap>(
    event: K,
    ...args: PollerEventMap[K]
  ): boolean;
}

/**
 * Polls the B2 bucket for new manifests under the downloadPrefix.
 * Emits 'manifest' for each unseen manifest key, then marks it seen
 * in the local DB to prevent double-processing across restarts.
 */
export class ManifestPoller extends EventEmitter {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly b2: B2Client,
    private readonly db: Database.Database,
    private readonly opts: PollerOptions
  ) {
    super();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const keys = await this.b2.listManifests(this.opts.downloadPrefix);

      for (const key of keys) {
        if (!this.running) break;
        if (this.hasSeen(key)) continue;

        try {
          const manifest = await this.b2.getManifest(key);
          this.markSeen(key);
          this.emit('manifest', manifest, key);
        } catch (err) {
          this.emit(
            'error',
            new Error(
              `Failed to fetch manifest ${key}: ${err instanceof Error ? err.message : String(err)}`
            )
          );
        }
      }
    } catch (err) {
      this.emit(
        'error',
        new Error(
          `Manifest list failed: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }

    if (this.running) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.poll();
      }, this.opts.pollIntervalMs);
    }
  }

  private hasSeen(manifestKey: string): boolean {
    const row = this.db
      .prepare<[string], { n: number }>(
        `SELECT COUNT(*) AS n FROM seen_manifests WHERE manifest_key = ?`
      )
      .get(manifestKey);
    return (row?.n ?? 0) > 0;
  }

  private markSeen(manifestKey: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO seen_manifests (manifest_key) VALUES (?)`
      )
      .run(manifestKey);
  }
}
