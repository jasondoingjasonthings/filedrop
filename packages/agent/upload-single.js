'use strict';

// Invoked by the Windows Explorer context menu:
//   node upload-single.js "C:\path\to\file-or-folder"

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const path  = require('path');
const fs    = require('fs');
const { execSync, spawn } = require('child_process');
const { uploadFile } = require('./uploader');

const SERVER_URL  = process.env.FILEDROP_SERVER || 'http://178.104.151.74:3000';
const AGENT_TOKEN = process.env.FILEDROP_AGENT_TOKEN;

// ── Toast helper ──────────────────────────────────────────────────────────────
// Uses System.Windows.Forms.NotifyIcon (balloon tip) — works on Windows 10/11
// without any AppID registration. Fired as a detached process so it never
// blocks the upload loop.

function toast(title, message) {
  try {
    const ttl = title.replace(/'/g, "''");
    const msg = message.replace(/'/g, "''");
    const child = spawn('powershell', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      `Add-Type -AssemblyName System.Windows.Forms;` +
      `Add-Type -AssemblyName System.Drawing;` +
      `$n = New-Object System.Windows.Forms.NotifyIcon;` +
      `$n.Icon = [System.Drawing.SystemIcons]::Information;` +
      `$n.BalloonTipTitle = '${ttl}';` +
      `$n.BalloonTipText = '${msg}';` +
      `$n.Visible = $true;` +
      `$n.ShowBalloonTip(5000);` +
      `Start-Sleep -Milliseconds 4000;` +
      `$n.Dispose()`,
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch {}
}

// ── Folder picker ─────────────────────────────────────────────────────────────
// Returns the folder string entered by the user (empty string = root).

function askFolder(defaultValue = '') {
  try {
    const escaped = defaultValue.replace(/'/g, "''");
    const result = execSync(
      `powershell -NoProfile -WindowStyle Hidden -Command "` +
      `Add-Type -AssemblyName Microsoft.VisualBasic;` +
      `$r = [Microsoft.VisualBasic.Interaction]::InputBox('Upload to which folder? (leave blank for root)', 'FileDrop Upload', '${escaped}');` +
      `Write-Output $r"`,
      { encoding: 'utf8' }
    );
    return result.trim();
  } catch {
    return '';
  }
}

// ── File collector ────────────────────────────────────────────────────────────

function collectFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return [{ filePath: target, name: path.basename(target), folder: '' }];
  }
  const results = [];
  (function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.isFile()) {
        results.push({ filePath: full, name: entry.name, folder: prefix });
      }
    }
  }(target, ''));
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const target = process.argv[2];

  if (!target) {
    toast('FileDrop', 'No file or folder supplied.');
    process.exit(1);
  }
  if (!fs.existsSync(target)) {
    toast('FileDrop', `Path not found: ${target}`);
    process.exit(1);
  }
  if (!AGENT_TOKEN) {
    toast('FileDrop', 'FILEDROP_AGENT_TOKEN not set — check .env');
    process.exit(1);
  }

  const stat = fs.statSync(target);
  const defaultFolder = stat.isDirectory() ? path.basename(target) : '';

  const baseFolder = askFolder(defaultFolder);

  let files;
  try {
    files = collectFiles(target);
  } catch (err) {
    toast('FileDrop', `Could not read path: ${err.message}`);
    process.exit(1);
  }

  if (files.length === 0) {
    toast('FileDrop', 'No files found to upload.');
    process.exit(0);
  }

  toast('FileDrop', `Uploading ${files.length} file${files.length !== 1 ? 's' : ''}…`);

  let ok = 0;
  let fail = 0;
  for (const { filePath, name, folder } of files) {
    const dest = baseFolder
      ? (folder ? `${baseFolder}/${folder}` : baseFolder)
      : folder;
    try {
      await uploadFile({ serverUrl: SERVER_URL, agentToken: AGENT_TOKEN, filePath, name, folder: dest });
      ok++;
    } catch (err) {
      console.error(`[upload-single] Failed: ${filePath}:`, err.message);
      fail++;
    }
  }

  if (fail === 0) {
    toast('FileDrop', `Done — ${ok} file${ok !== 1 ? 's' : ''} uploaded.`);
  } else {
    toast('FileDrop', `Finished with errors — ${ok} uploaded, ${fail} failed.`);
  }
}

main().catch(err => {
  console.error('[upload-single] Fatal:', err.message);
  toast('FileDrop', `Upload error: ${err.message}`);
  process.exit(1);
});
