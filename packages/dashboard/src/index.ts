import express from 'express';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { FileDropConfig, TransferQueue } from '@filedrop/core';
import { isConfigPresent } from '@filedrop/core';
import type { PeerHandle } from '@filedrop/peer';
import {
  makeAuthMiddleware, signToken, verifyToken,
  checkPassword, findUserByUsername, ownerExists,
} from './auth.js';
import { makeTransferRouter } from './routes/transfers.js';
import { makeUserRouter } from './routes/users.js';
import { makeSetupRouter } from './routes/setup.js';
import { makePeersRouter } from './routes/peers.js';
import { makeBrowseRouter } from './routes/browse.js';
import { makeSubscriptionsRouter } from './routes/subscriptions.js';
import { makeLibraryRouter } from './routes/library.js';
import { makeSettingsRouter } from './routes/settings.js';
import { makeLocalRouter } from './routes/local.js';

export * from './auth.js';

const LoginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export interface DashboardHandle {
  stop: () => void;
}

export async function startDashboard(
  config: FileDropConfig,
  db: Database.Database,
  queue: TransferQueue,
  peer: PeerHandle
): Promise<DashboardHandle> {
  const app = express();
  app.use(express.json());

  // Setup wizard (pre-config)
  app.use('/setup', makeSetupRouter(db));

  app.use((_req, res, next) => {
    if (!isConfigPresent()) { res.redirect('/setup'); return; }
    next();
  });

  const { sseBus, peerRouter, monitor, syncEngine } = peer;
  const auth = makeAuthMiddleware(config.dashboard.jwtSecret);

  // Auth
  app.post('/auth/login', async (req, res) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid body' }); return; }
    const user = findUserByUsername(db, parsed.data.username);
    if (!user || !(await checkPassword(parsed.data.password, user.password_hash))) {
      res.status(401).json({ error: 'Invalid credentials' }); return;
    }
    const token = signToken(
      { sub: user.id, username: user.username, role: user.role },
      config.dashboard.jwtSecret
    );
    res.json({ token, role: user.role });
  });

  // SSE for dashboard browser clients
  app.get('/api/events', (req, res) => {
    const token = req.query['token'];
    if (typeof token !== 'string') { res.status(401).end(); return; }
    try { verifyToken(token, config.dashboard.jwtSecret); }
    catch { res.status(401).end(); return; }
    const cleanup = sseBus.connect(res);
    req.on('close', cleanup);
  });

  // Peer-to-peer file server (no JWT — uses shared secret)
  app.use('/peer', peerRouter);

  // Wire queue events to SSE
  queue.on('enqueued',  (t)       => sseBus.broadcast('transfer', t));
  queue.on('started',   (t)       => sseBus.broadcast('transfer', t));
  queue.on('completed', (t)       => sseBus.broadcast('transfer', t));
  queue.on('failed',    (t)       => sseBus.broadcast('transfer', t));
  queue.on('paused',    (id)      => sseBus.broadcast('transfer:paused', { id }));
  queue.on('resumed',   (id)      => sseBus.broadcast('transfer:resumed', { id }));
  queue.on('cancelled', (id)      => sseBus.broadcast('transfer:cancelled', { id }));
  queue.on('progress',  (id, pct) => sseBus.broadcast('progress', { id, progress: pct }));

  // Protected API routes
  app.use('/api/transfers',    auth, makeTransferRouter(queue));
  app.use('/api/users',        auth, makeUserRouter(db));
  app.use('/api/peers',        auth, makePeersRouter(monitor));
  app.use('/api/browse',       auth, makeBrowseRouter(config));
  app.use('/api/subscriptions',auth, makeSubscriptionsRouter(syncEngine));
  app.use('/api/library',      auth, makeLibraryRouter(db));
  app.use('/api/settings',     auth, makeSettingsRouter(config, db));
  app.use('/api/local',        auth, makeLocalRouter(config));

  app.get('/api/stats', auth, (_req, res) => { res.json(queue.getStats()); });

  // Dashboard HTML
  const htmlDir = path.join(__dirname, 'html');
  app.get('/', (_req, res) => {
    if (!ownerExists(db)) { res.redirect('/setup'); return; }
    const html = fs.readFileSync(path.join(htmlDir, 'dashboard.html'), 'utf-8');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });

  const { port, host } = config.dashboard;
  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      console.log(`[dashboard] http://${host}:${port}`);
      if (!ownerExists(db)) console.log(`[dashboard] Visit http://localhost:${port}/setup`);
      resolve({ stop: () => server.close() });
    });
  });
}

if (require.main === module) {
  void (async () => {
    const { loadConfig, getDb, TransferQueue } = await import('@filedrop/core');
    const { startPeer } = await import('@filedrop/peer');
    const config = loadConfig();
    const db = getDb();
    const queue = new TransferQueue(db, { concurrency: config.concurrency });
    const peer = startPeer(config, db, queue);
    const handle = await startDashboard(config, db, queue, peer);
    const shutdown = (): void => { handle.stop(); void peer.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })();
}
