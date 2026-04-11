import { Router } from 'express';
import type { PeerMonitor } from '@filedrop/peer';

export function makePeersRouter(monitor: PeerMonitor): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(monitor.getAllStatuses());
  });

  router.get('/:name', (req, res) => {
    const status = monitor.getStatus(req.params['name'] ?? '');
    if (!status) { res.status(404).json({ error: 'Peer not found' }); return; }
    res.json(status);
  });

  return router;
}
