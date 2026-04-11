import type { Response } from 'express';

/**
 * Simple SSE bus shared between:
 * - Dashboard (browser clients)
 * - Peer events endpoint (spoke SSE connections)
 */
export class SseBus {
  private readonly clients = new Set<Response>();

  connect(res: Response): () => void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    this.clients.add(res);
    this.send(res, 'connected', { ok: true });

    return () => {
      this.clients.delete(res);
    };
  }

  broadcast(event: string, data: unknown): void {
    for (const res of this.clients) {
      this.send(res, event, data);
    }
  }

  private send(res: Response, event: string, data: unknown): void {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* client disconnected */ }
  }
}
