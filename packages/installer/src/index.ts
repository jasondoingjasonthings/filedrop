/**
 * FileDrop application entry point.
 *
 * CLI:
 *   FileDrop-Hub.exe                  — start all services
 *   FileDrop-Hub.exe --install        — register as OS service
 *   FileDrop-Hub.exe --uninstall      — remove OS service
 *   FileDrop-Hub.exe --uninstall --clean — remove service + data folders
 */

import fs from 'fs';
import { exec } from 'child_process';
import { loadConfig, getDb, TransferQueue, isConfigPresent } from '@filedrop/core';
import { startPeer } from '@filedrop/peer';
import { startDashboard, ownerExists } from '@filedrop/dashboard';
import { NotifyService } from '@filedrop/notify';
import { installService, uninstallService } from './service.js';
import { createSetupOnlyApp } from './setup-bootstrap.js';

const EXE_PATH = process.execPath;
const ARGS = process.argv.slice(2);
const hasFlag = (f: string): boolean => ARGS.includes(f);

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'win32'  ? `start "" "${url}"`
            : platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) console.warn('[app] Could not open browser:', err.message); });
}

async function runApp(): Promise<void> {
  if (!isConfigPresent()) {
    // No config — boot a minimal setup wizard only
    console.log('[app] No config found — starting setup wizard...');
    const db = getDb();
    createSetupOnlyApp(db);
    openBrowser('http://localhost:5050/setup');
    return;
  }

  const config = loadConfig();
  const db = getDb();
  const queue = new TransferQueue(db, { concurrency: config.concurrency });

  // Start peer engine (file server + watcher + downloader + sync + monitor)
  const peer = startPeer(config, db, queue);

  // Notifications
  const notify = new NotifyService(queue, config);
  notify.attach();

  // Dashboard
  const dash = await startDashboard(config, db, queue, peer);

  if (!ownerExists(db)) {
    openBrowser(`http://localhost:${config.dashboard.port}/setup`);
  }

  const shutdown = async (): Promise<void> => {
    console.log('[app] Shutting down...');
    dash.stop();
    await peer.stop();
    process.exit(0);
  };

  process.on('SIGINT',  () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGHUP',  () => { void shutdown(); });
}

async function handleInstall(): Promise<void> {
  console.log('[app] Installing OS service...');
  try {
    await installService(EXE_PATH);
    console.log('[app] Service installed. FileDrop will start automatically at login.');
  } catch (err) {
    console.error('[app] Service install failed:', err);
    process.exit(1);
  }
}

async function handleUninstall(): Promise<void> {
  const clean = hasFlag('--clean');
  try {
    await uninstallService(EXE_PATH);
  } catch (err) {
    console.error('[app] Service uninstall failed:', err);
    process.exit(1);
  }

  if (clean) {
    try {
      const config = loadConfig();
      for (const folder of [config.watchFolder, config.downloadFolder]) {
        if (fs.existsSync(folder)) {
          fs.rmSync(folder, { recursive: true, force: true });
          console.log(`[app] Removed: ${folder}`);
        }
      }
    } catch { console.warn('[app] Could not remove folders — config may not exist.'); }
  }

  console.log('[app] Uninstall complete.');
}

async function main(): Promise<void> {
  if (hasFlag('--install'))        await handleInstall();
  else if (hasFlag('--uninstall')) await handleUninstall();
  else                             await runApp();
}

main().catch((err: unknown) => {
  console.error('[app] Fatal error:', err);
  process.exit(1);
});
