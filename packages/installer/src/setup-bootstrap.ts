/**
 * Minimal Express app that serves only the /setup wizard when no
 * filedrop.config.json exists yet. Once POST /setup saves the config,
 * the user is told to restart the service.
 */
import express from 'express';
import type Database from 'better-sqlite3';
import { makeSetupRouter } from '@filedrop/dashboard/dist/routes/setup.js';

export function createSetupOnlyApp(db: Database.Database): void {
  const app = express();
  app.use(express.json());
  app.use('/setup', makeSetupRouter(db));

  app.get('/', (_req, res) => res.redirect('/setup'));

  // After setup completes the user restarts; tell them so in the response
  app.use((_req, res) => {
    res.status(404).json({ error: 'Run setup first at /setup' });
  });

  app.listen(5050, '0.0.0.0', () => {
    console.log('[installer] Setup wizard at http://localhost:5050/setup');
  });
}
