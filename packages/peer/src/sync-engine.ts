/**
 * Sync engine — manages folder subscriptions.
 *
 * For each active subscription it:
 *  1. Polls the hub for new/changed files in that folder every pollIntervalMs
 *  2. Queues downloads for any files not yet on disk
 *  3. When hub emits a folder_changed SSE event, triggers an immediate re-scan
 *
 * "Live folder follow" — if Jason adds a file to Ep13 while Mitch is already
 * subscribed to Ep13, it auto-queues within pollIntervalMs (default 15s).
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import type { FileDropConfig, FolderEntry, PeerConfig, Subscription } from '@filedrop/core';
import type { PeerDownloader } from './downloader.js';

const POLL_INTERVAL_MS = 15_000;

function peerBaseUrl(peer: PeerConfig): string {
  return `http://${peer.host}:${peer.port}`;
}

interface SyncEngineEvents {
  subscription_updated: (sub: Subscription) => void;
  error: (err: Error) => void;
}

export declare interface SyncEngine {
  on<K extends keyof SyncEngineEvents>(event: K, listener: SyncEngineEvents[K]): this;
  emit<K extends keyof SyncEngineEvents>(event: K, ...args: Parameters<SyncEngineEvents[K]>): boolean;
}

interface SubscriptionRow {
  id: number;
  peer_name: string;
  remote_path: string;
  local_path: string;
  status: 'active' | 'paused';
  subscribed_at: string;
}

export class SyncEngine extends EventEmitter {
  private running = false;
  private timers = new Map<number, ReturnType<typeof setInterval>>();
  private peerSseConnections = new Map<string, ReturnType<typeof http.get>>();

  constructor(
    private readonly config: FileDropConfig,
    private readonly db: Database.Database,
    private readonly downloader: PeerDownloader
  ) {
    super();
  }

  start(): void {
    this.running = true;
    // Start polling for all active subscriptions
    const subs = this.getActiveSubscriptions();
    for (const sub of subs) this.startSubscription(sub);
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    for (const req of this.peerSseConnections.values()) req.destroy();
    this.peerSseConnections.clear();
  }

  /** Subscribe to a remote folder. Returns the new subscription. */
  subscribe(peerName: string, remotePath: string, localPath: string): Subscription {
    this.db.prepare(`
      INSERT INTO subscriptions (peer_name, remote_path, local_path)
      VALUES (?, ?, ?)
      ON CONFLICT (peer_name, remote_path) DO UPDATE SET status = 'active', local_path = excluded.local_path
    `).run(peerName, remotePath, localPath);

    const row = this.db.prepare<[string, string], SubscriptionRow>(
      `SELECT * FROM subscriptions WHERE peer_name = ? AND remote_path = ?`
    ).get(peerName, remotePath);

    if (!row) throw new Error('Failed to create subscription');
    const sub = this.rowToSub(row);
    this.startSubscription(sub);
    // Trigger immediate sync
    void this.syncSubscription(sub);
    return sub;
  }

  /** Pause a subscription — stops polling but keeps the record. */
  pause(id: number): void {
    this.db.prepare(`UPDATE subscriptions SET status = 'paused' WHERE id = ?`).run(id);
    const timer = this.timers.get(id);
    if (timer) { clearInterval(timer); this.timers.delete(id); }
  }

  /** Resume a paused subscription. */
  resume(id: number): void {
    this.db.prepare(`UPDATE subscriptions SET status = 'active' WHERE id = ?`).run(id);
    const row = this.db.prepare<[number], SubscriptionRow>(`SELECT * FROM subscriptions WHERE id = ?`).get(id);
    if (row) {
      const sub = this.rowToSub(row);
      this.startSubscription(sub);
      void this.syncSubscription(sub);
    }
  }

  /** Remove a subscription entirely. Does NOT delete already-downloaded files. */
  unsubscribe(id: number): void {
    this.db.prepare(`DELETE FROM subscriptions WHERE id = ?`).run(id);
    const timer = this.timers.get(id);
    if (timer) { clearInterval(timer); this.timers.delete(id); }
  }

  getAll(): Subscription[] {
    return this.db.prepare<[], SubscriptionRow>(`SELECT * FROM subscriptions ORDER BY subscribed_at DESC`)
      .all()
      .map(this.rowToSub);
  }

  /** Called by the dashboard when a peer SSE event announces a folder change. */
  onPeerFolderChanged(peerName: string, changedPath: string): void {
    const subs = this.getActiveSubscriptions().filter(
      (s) => s.peer_name === peerName &&
        (changedPath === s.remote_path || changedPath.startsWith(s.remote_path + '/'))
    );
    for (const sub of subs) void this.syncSubscription(sub);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private startSubscription(sub: Subscription): void {
    if (this.timers.has(sub.id)) return;
    const timer = setInterval(() => {
      void this.syncSubscription(sub);
    }, POLL_INTERVAL_MS);
    this.timers.set(sub.id, timer);
  }

  private getActiveSubscriptions(): Subscription[] {
    return this.db.prepare<[], SubscriptionRow>(
      `SELECT * FROM subscriptions WHERE status = 'active'`
    ).all().map(this.rowToSub);
  }

  private async syncSubscription(sub: Subscription): Promise<void> {
    const peer = this.config.peers.find((p) => p.name === sub.peer_name);
    if (!peer) return;

    let entries: FolderEntry[];
    try {
      entries = await this.fetchFolderListing(peer, sub.remote_path);
    } catch (err) {
      this.emit('error', new Error(
        `[sync] Failed to list ${sub.peer_name}:${sub.remote_path}: ${err instanceof Error ? err.message : String(err)}`
      ));
      return;
    }

    // Flatten entries recursively
    const files = this.flattenEntries(entries);

    for (const file of files) {
      const localPath = path.join(sub.local_path, file.relative_path.split('/').join(path.sep));

      // Skip if already downloaded and unchanged
      if (fs.existsSync(localPath)) {
        try {
          const stat = fs.statSync(localPath);
          if (stat.size === file.size_bytes) continue;
        } catch { /* file stat failed, re-download */ }
      }

      // Check if already queued or active
      const existing = this.db.prepare<[string, string], { n: number }>(
        `SELECT COUNT(*) AS n FROM transfers
         WHERE peer_name = ? AND source_path = ? AND status IN ('queued','active','pending')`
      ).get(sub.peer_name, file.relative_path);
      if ((existing?.n ?? 0) > 0) continue;

      this.downloader.enqueue(peer, file.relative_path, file.name, file.size_bytes, localPath);
    }
  }

  private flattenEntries(entries: FolderEntry[]): FolderEntry[] {
    const result: FolderEntry[] = [];
    for (const entry of entries) {
      if (entry.type === 'file') {
        result.push(entry);
      } else {
        result.push(...this.flattenEntries(entry.children));
      }
    }
    return result;
  }

  private fetchFolderListing(peer: PeerConfig, remotePath: string): Promise<FolderEntry[]> {
    return new Promise((resolve, reject) => {
      const url = `${peerBaseUrl(peer)}/peer/browse?path=${encodeURIComponent(remotePath)}`;
      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === 'https:' ? https : http;

      const req = lib.get(url, {
        headers: { 'Authorization': `Bearer ${this.config.secret}` },
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
            return;
          }
          try {
            const parsed = JSON.parse(data) as { entries: FolderEntry[] };
            resolve(parsed.entries);
          } catch (e) {
            reject(e);
          }
        });
        res.on('error', reject);
      });

      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('Timeout')));
    });
  }

  private rowToSub(row: SubscriptionRow): Subscription {
    return {
      id: row.id,
      peer_name: row.peer_name,
      remote_path: row.remote_path,
      local_path: row.local_path,
      subscribed_at: row.subscribed_at,
      status: row.status,
    };
  }
}
