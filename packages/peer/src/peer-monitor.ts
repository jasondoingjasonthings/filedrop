/**
 * Monitors peer online/offline status by pinging /peer/status every 30s.
 * Broadcasts status changes to the SSE bus so the dashboard header updates live.
 */

import http from 'http';
import https from 'https';
import type { FileDropConfig, PeerConfig, PeerStatus } from '@filedrop/core';
import type { SseBus } from './sse-bus.js';

const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS  = 10_000;

function peerBaseUrl(peer: PeerConfig): string {
  return `http://${peer.host}:${peer.port}`;
}

interface PeerStatusResponse {
  online: boolean;
  name: string;
  watch_folder_ok: boolean;
  drive_free_bytes: number | null;
  file_count: number;
}

function pingPeer(peer: PeerConfig, secret: string): Promise<PeerStatusResponse> {
  return new Promise((resolve, reject) => {
    const url = `${peerBaseUrl(peer)}/peer/status`;
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const req = lib.get(url, {
      headers: { 'Authorization': `Bearer ${secret}` },
    }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`)); return; }
        try { resolve(JSON.parse(data) as PeerStatusResponse); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    });

    req.setTimeout(PING_TIMEOUT_MS, () => req.destroy(new Error('Ping timeout')));
    req.on('error', reject);
  });
}

export class PeerMonitor {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private statuses = new Map<string, PeerStatus>();

  constructor(
    private readonly config: FileDropConfig,
    private readonly sseBus: SseBus
  ) {}

  start(): void {
    for (const peer of this.config.peers) {
      // Initialise as offline until first ping comes back
      this.statuses.set(peer.name, {
        name: peer.name,
        host: peer.host,
        port: peer.port,
        status: 'offline',
        watch_folder_ok: false,
        drive_free_bytes: null,
        file_count: 0,
        last_seen: null,
      });

      void this.ping(peer);

      const timer = setInterval(() => { void this.ping(peer); }, PING_INTERVAL_MS);
      this.timers.set(peer.name, timer);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  getStatus(peerName: string): PeerStatus | null {
    return this.statuses.get(peerName) ?? null;
  }

  getAllStatuses(): PeerStatus[] {
    return [...this.statuses.values()];
  }

  private async ping(peer: PeerConfig): Promise<void> {
    try {
      const resp = await pingPeer(peer, this.config.secret);
      const status: PeerStatus = {
        name: peer.name,
        host: peer.host,
        port: peer.port,
        status: resp.watch_folder_ok ? 'online' : 'drive_missing',
        watch_folder_ok: resp.watch_folder_ok,
        drive_free_bytes: resp.drive_free_bytes,
        file_count: resp.file_count,
        last_seen: new Date().toISOString(),
      };
      this.statuses.set(peer.name, status);
      this.sseBus.broadcast('peer_status', status);
    } catch {
      const prev = this.statuses.get(peer.name);
      const status: PeerStatus = {
        name: peer.name,
        host: peer.host,
        port: peer.port,
        status: 'offline',
        watch_folder_ok: false,
        drive_free_bytes: null,
        file_count: 0,
        last_seen: prev?.last_seen ?? null,
      };
      this.statuses.set(peer.name, status);
      this.sseBus.broadcast('peer_status', status);
    }
  }
}
