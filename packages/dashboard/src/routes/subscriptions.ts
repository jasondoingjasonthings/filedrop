import { Router } from 'express';
import { z } from 'zod';
import type { SyncEngine } from '@filedrop/peer';

const SubscribeBody = z.object({
  peer_name:   z.string().min(1),
  remote_path: z.string().min(1),
  local_path:  z.string().min(1),
});

export function makeSubscriptionsRouter(syncEngine: SyncEngine): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(syncEngine.getAll());
  });

  router.post('/', (req, res) => {
    const parsed = SubscribeBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const sub = syncEngine.subscribe(
        parsed.data.peer_name,
        parsed.data.remote_path,
        parsed.data.local_path
      );
      res.status(201).json(sub);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/:id/pause', (req, res) => {
    const id = parseInt(req.params['id'] ?? '', 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
    syncEngine.pause(id);
    res.json({ ok: true });
  });

  router.post('/:id/resume', (req, res) => {
    const id = parseInt(req.params['id'] ?? '', 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
    syncEngine.resume(id);
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    const id = parseInt(req.params['id'] ?? '', 10);
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
    syncEngine.unsubscribe(id);
    res.json({ ok: true });
  });

  return router;
}
