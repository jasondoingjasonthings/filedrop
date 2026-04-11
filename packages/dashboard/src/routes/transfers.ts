import { Router } from 'express';
import { z } from 'zod';
import type { TransferQueue } from '@filedrop/core';
import { requireOwner } from '../auth.js';

const PriorityBody = z.object({ priority: z.number().int().min(0).max(999) });
const ListQuery = z.object({
  status: z.enum(['pending', 'queued', 'active', 'paused', 'done', 'error']).optional(),
  direction: z.enum(['upload', 'download']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export function makeTransferRouter(queue: TransferQueue): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const { status, direction, limit, offset } = parsed.data;
    const filters: Parameters<typeof queue.getAll>[0] = { limit, offset };
    if (status)    filters.status    = status;
    if (direction) filters.direction = direction;
    res.json(queue.getAll(filters));
  });

  router.get('/:id', (req, res) => {
    const id = Number(req.params['id']);
    const t = queue.getById(id);
    if (!t) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(t);
  });

  router.post('/:id/pause', (req, res) => {
    const id = Number(req.params['id']);
    const t = queue.getById(id);
    if (!t) { res.status(404).json({ error: 'Not found' }); return; }
    if (t.status !== 'active') { res.status(409).json({ error: 'Transfer is not active' }); return; }
    queue.pause(id);
    res.json({ ok: true });
  });

  router.post('/:id/resume', (req, res) => {
    const id = Number(req.params['id']);
    const t = queue.getById(id);
    if (!t) { res.status(404).json({ error: 'Not found' }); return; }
    if (t.status !== 'paused') { res.status(409).json({ error: 'Transfer is not paused' }); return; }
    queue.resume(id);
    res.json({ ok: true });
  });

  router.delete('/:id', requireOwner, (req, res) => {
    const id = Number(req.params['id']);
    const t = queue.getById(id);
    if (!t) { res.status(404).json({ error: 'Not found' }); return; }
    queue.cancel(id);
    res.json({ ok: true });
  });

  router.patch('/:id/priority', (req, res) => {
    const id = Number(req.params['id']);
    const parsed = PriorityBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    const t = queue.getById(id);
    if (!t) { res.status(404).json({ error: 'Not found' }); return; }
    queue.updatePriority(id, parsed.data.priority);
    res.json({ ok: true });
  });

  return router;
}
