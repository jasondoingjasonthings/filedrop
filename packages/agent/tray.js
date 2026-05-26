'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { execSync } = require('child_process');
const SysTray = require('systray2').default;

const ICON_PATH = path.join(os.tmpdir(), 'filedrop-tray.ico');
const SERVER_URL = process.env.FILEDROP_SERVER || 'http://178.104.151.74:3000';

// ── Icon ──────────────────────────────────────────────────────────────────────
// Generate a simple 16x16 ICO using PowerShell + .NET on first run.

function ensureIcon() {
  if (fs.existsSync(ICON_PATH)) return ICON_PATH;
  try {
    execSync(`powershell -NoProfile -Command "
      Add-Type -AssemblyName System.Drawing;
      $b = New-Object System.Drawing.Bitmap 16,16;
      $g = [System.Drawing.Graphics]::FromImage($b);
      $g.Clear([System.Drawing.Color]::FromArgb(255,14,165,233));
      $g.FillEllipse([System.Drawing.Brushes]::White, 4, 4, 8, 8);
      $ic = [System.Drawing.Icon]::FromHandle($b.GetHicon());
      $s = New-Object System.IO.FileStream '${ICON_PATH.replace(/\\/g, '\\\\')}', Create;
      $ic.Save($s); $s.Close();
      $g.Dispose(); $b.Dispose();"`, { stdio: 'ignore' });
  } catch (e) {
    console.warn('[tray] Icon generation failed:', e.message);
  }
  return ICON_PATH;
}

// ── State ─────────────────────────────────────────────────────────────────────

let _tray       = null;
let _status     = 'idle';   // 'idle' | 'uploading' | 'error'
let _queueCount = 0;

function statusLine() {
  if (_status === 'uploading') return `Uploading — ${_queueCount} file${_queueCount !== 1 ? 's' : ''} in queue`;
  if (_status === 'error')     return 'Error — check agent log';
  return 'Idle';
}

function buildMenu() {
  return {
    title:   'FileDrop',
    tooltip: 'FileDrop Agent',
    icon:    ensureIcon(),
    items: [
      { title: `FileDrop  [${statusLine()}]`, enabled: false },
      SysTray.separator,
      { title: 'Open Dashboard', enabled: true },
      SysTray.separator,
      { title: 'Quit', enabled: true },
    ],
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

function startTray() {
  try {
    _tray = new SysTray(buildMenu());

    _tray.onClick(action => {
      const item = action.item?.title || '';
      if (item === 'Open Dashboard') {
        const { exec } = require('child_process');
        exec(`start "" "${SERVER_URL}"`);
      }
      if (item === 'Quit') {
        _tray.kill();
        process.exit(0);
      }
    });

    console.log('[tray] System tray started');
  } catch (err) {
    console.warn('[tray] Could not start system tray:', err.message);
  }
}

function setStatus(status, queueCount = 0) {
  _status     = status;
  _queueCount = queueCount;
  try { _tray?.setMenu(buildMenu()); } catch {}
}

function killTray() {
  try { _tray?.kill(); } catch {}
}

module.exports = { startTray, setStatus, killTray };
