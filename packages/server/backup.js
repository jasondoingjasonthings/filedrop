'use strict';

const fs      = require('fs');
const path    = require('path');
const zlib    = require('zlib');
const os      = require('os');
const { putObject, deleteObject, BUCKET } = require('./r2');
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

// Re-use the same client config from r2.js via env vars
const _client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BACKUP_PREFIX  = '_backups/';
const KEEP_BACKUPS   = 7; // keep last 7 daily snapshots
const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function runBackup(db) {
  const ts      = new Date().toISOString().slice(0, 13).replace('T', '-'); // YYYY-MM-DD-HH
  const tmpPath = path.join(os.tmpdir(), `filedrop-backup-${ts}.sqlite`);
  const r2Key   = `${BACKUP_PREFIX}${ts}.sqlite.gz`;

  try {
    console.log('[backup] Starting SQLite snapshot...');
    await db.backup(tmpPath);

    // Gzip compress
    const raw        = fs.readFileSync(tmpPath);
    const compressed = await new Promise((resolve, reject) => {
      zlib.gzip(raw, { level: 6 }, (err, buf) => err ? reject(err) : resolve(buf));
    });

    await putObject(r2Key, compressed, 'application/gzip');
    console.log(`[backup] Uploaded ${r2Key} (${(compressed.length / 1024 / 1024).toFixed(1)} MB)`);

    await pruneOldBackups();
  } catch (err) {
    console.error('[backup] Failed:', err.message);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

async function pruneOldBackups() {
  try {
    const list = await _client.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: BACKUP_PREFIX,
    }));

    const objects = (list.Contents || [])
      .filter(o => o.Key.endsWith('.sqlite.gz'))
      .sort((a, b) => b.Key.localeCompare(a.Key)); // newest first

    const toDelete = objects.slice(KEEP_BACKUPS);
    if (!toDelete.length) return;

    await _client.send(new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: { Objects: toDelete.map(o => ({ Key: o.Key })) },
    }));
    console.log(`[backup] Pruned ${toDelete.length} old backup(s)`);
  } catch (err) {
    console.error('[backup] Prune failed:', err.message);
  }
}

function startBackup(db) {
  // Stagger first run by 1 minute so startup noise settles
  setTimeout(() => {
    runBackup(db);
    setInterval(() => runBackup(db), BACKUP_INTERVAL_MS).unref();
  }, 60_000).unref();
}

module.exports = { startBackup };
