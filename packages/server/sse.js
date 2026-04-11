'use strict';

const HEARTBEAT_MS = 25_000;

let _clientId = 0;

class SseBus {
  constructor() {
    this._clients = new Set();
  }

  connect(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const client = { id: ++_clientId, res, hb: null };
    this._clients.add(client);
    this._send(client, 'connected', { clientId: client.id });

    client.hb = setInterval(() => this._comment(client, 'hb'), HEARTBEAT_MS);

    return () => {
      clearInterval(client.hb);
      this._clients.delete(client);
      if (!res.writableEnded) res.end();
    };
  }

  broadcast(event, data) {
    for (const c of this._clients) this._send(c, event, data);
  }

  _send(client, event, data) {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      clearInterval(client.hb);
      this._clients.delete(client);
    }
  }

  _comment(client, text) {
    try {
      client.res.write(`: ${text}\n\n`);
    } catch {
      clearInterval(client.hb);
      this._clients.delete(client);
    }
  }

  get size() { return this._clients.size; }
}

module.exports = { SseBus };
