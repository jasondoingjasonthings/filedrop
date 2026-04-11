/**
 * Cross-platform background service registration.
 *
 * Windows  → node-windows (Windows Service Control Manager)
 * macOS    → launchd plist in ~/Library/LaunchAgents/
 * Linux    → systemd user unit in ~/.config/systemd/user/
 */

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const PLATFORM = process.platform;

// ─── Windows ──────────────────────────────────────────────────────────────────

// node-windows has no official type declarations
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeWindows = PLATFORM === 'win32'
  ? (require('node-windows') as { Service: new (opts: WinServiceOptions) => WinServiceInstance })
  : null;

interface WinServiceOptions {
  name: string;
  description: string;
  script: string;
}

interface WinServiceInstance {
  on(event: 'install' | 'alreadyinstalled' | 'uninstall' | 'start' | 'stop', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  install(): void;
  uninstall(): void;
  start(): void;
}

function installWindows(exePath: string): Promise<void> {
  if (!nodeWindows) return Promise.reject(new Error('node-windows not available'));
  return new Promise((resolve, reject) => {
    const svc = new nodeWindows.Service({ name: 'FileDrop', description: 'FileDrop background file transfer service', script: exePath });
    svc.on('install', () => { svc.start(); resolve(); });
    svc.on('alreadyinstalled', () => resolve());
    svc.on('error', reject);
    svc.install();
  });
}

function uninstallWindows(exePath: string): Promise<void> {
  if (!nodeWindows) return Promise.reject(new Error('node-windows not available'));
  return new Promise((resolve, reject) => {
    const svc = new nodeWindows.Service({ name: 'FileDrop', description: 'FileDrop background file transfer service', script: exePath });
    svc.on('uninstall', () => resolve());
    svc.on('error', reject);
    svc.uninstall();
  });
}

// ─── macOS (launchd) ─────────────────────────────────────────────────────────

const PLIST_LABEL = 'com.filedrop.service';
const PLIST_PATH  = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
const LOG_DIR     = path.join(os.homedir(), 'Library', 'Logs', 'FileDrop');

function buildPlist(exePath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exePath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/filedrop.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/filedrop-error.log</string>
</dict>
</plist>`;
}

function installMac(exePath: string): Promise<void> {
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(PLIST_PATH, buildPlist(exePath), 'utf-8');
  // Make the binary executable
  fs.chmodSync(exePath, 0o755);
  try {
    // Unload first in case of previous install
    execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null || true`);
  } catch { /* ignore */ }
  execSync(`launchctl load "${PLIST_PATH}"`);
  console.log(`[installer] macOS service installed. Logs: ${LOG_DIR}`);
  return Promise.resolve();
}

function uninstallMac(_exePath: string): Promise<void> {
  if (fs.existsSync(PLIST_PATH)) {
    try { execSync(`launchctl unload "${PLIST_PATH}"`); } catch { /* ignore */ }
    fs.unlinkSync(PLIST_PATH);
  }
  console.log('[installer] macOS service removed.');
  return Promise.resolve();
}

// ─── Linux (systemd user) ────────────────────────────────────────────────────

const SYSTEMD_DIR  = path.join(os.homedir(), '.config', 'systemd', 'user');
const SERVICE_FILE = path.join(SYSTEMD_DIR, 'filedrop.service');

function buildSystemdUnit(exePath: string): string {
  return `[Unit]
Description=FileDrop background file transfer service
After=network.target

[Service]
ExecStart=${exePath}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function installLinux(exePath: string): Promise<void> {
  fs.mkdirSync(SYSTEMD_DIR, { recursive: true });
  fs.writeFileSync(SERVICE_FILE, buildSystemdUnit(exePath), 'utf-8');
  fs.chmodSync(exePath, 0o755);
  execSync('systemctl --user daemon-reload');
  execSync('systemctl --user enable --now filedrop.service');
  console.log('[installer] systemd user service installed.');
  return Promise.resolve();
}

function uninstallLinux(_exePath: string): Promise<void> {
  try { execSync('systemctl --user disable --now filedrop.service'); } catch { /* ignore */ }
  if (fs.existsSync(SERVICE_FILE)) fs.unlinkSync(SERVICE_FILE);
  try { execSync('systemctl --user daemon-reload'); } catch { /* ignore */ }
  console.log('[installer] systemd user service removed.');
  return Promise.resolve();
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function installService(exePath: string): Promise<void> {
  if (PLATFORM === 'win32')  return installWindows(exePath);
  if (PLATFORM === 'darwin') return installMac(exePath);
  return installLinux(exePath);
}

export function uninstallService(exePath: string): Promise<void> {
  if (PLATFORM === 'win32')  return uninstallWindows(exePath);
  if (PLATFORM === 'darwin') return uninstallMac(exePath);
  return uninstallLinux(exePath);
}
