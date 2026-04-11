import type { Response } from 'express';
import type { TransferQueue } from '@filedrop/core';

const HEARTBEAT_INTERVAL_MS = 25_000;

interface SseClient {
  id: number;
  res: Response;
  heartbeat: ReturnType<typeof setInterval>;
}

let clientId = 0;

/**
 * SSEBus manages connected dashboard clients and broadcasts queue events
 * to all of them as Server-Sent Events.
 */
export class SseBus {
  private readonly clients = new Set<SseClient>();

  /** Register an incoming SSE request and return a cleanup function. */
  connect(res: Response): () => void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
    res.flushHeaders();

    const client: SseClient = { id: ++clientId, res, heartbeat: undefined! };
    this.clients.add(client);

    // Send connected event so the browser knows the stream is open
    this.send(client, 'connected', { clientId: client.id });

    // Periodic heartbeat — detects dead connections and cleans them up
    client.heartbeat = setInterval(() => {
      this.sendComment(client, 'heartbeat');
    }, HEARTBEAT_INTERVAL_MS);

    const cleanup = (): void => {
      clearInterval(client.heartbeat);
      this.clients.delete(client);
      if (!res.writableEnded) res.end();
    };

    return cleanup;
  }

  /** Broadcast an event to all connected clients. */
  broadcast(event: string, data: unknown): void {
    for (const client of this.clients) {
      this.send(client, event, data);
    }
  }

  private send(client: SseClient, event: string, data: unknown): void {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      clearInterval(client.heartbeat);
      this.clients.delete(client);
    }
  }

  /** SSE comment line — keeps the connection alive, ignored by event listeners. */
  private sendComment(client: SseClient, text: string): void {
    try {
      client.res.write(`: ${text}\n\n`);
    } catch {
      clearInterval(client.heartbeat);
      this.clients.delete(client);
    }
  }

  get connectionCount(): number {
    return this.clients.size;
  }
}

/**
 * Wire TransferQueue events into an SseBus so the dashboard gets
 * live updates without polling.
 */
export function attachQueueToSse(queue: TransferQueue, bus: SseBus): void {
  queue.on('enqueued',  (t) => bus.broadcast('transfer', t));
  queue.on('started',   (t) => bus.broadcast('transfer', t));
  queue.on('completed', (t) => bus.broadcast('transfer', t));
  queue.on('failed',    (t) => bus.broadcast('transfer', t));
  queue.on('paused',    (id) => bus.broadcast('transfer:paused',   { id }));
  queue.on('resumed',   (id) => bus.broadcast('transfer:resumed',  { id }));
  queue.on('cancelled', (id) => bus.broadcast('transfer:cancelled', { id }));
  queue.on('progress',  (id, pct) => bus.broadcast('progress', { id, progress: pct }));
}
