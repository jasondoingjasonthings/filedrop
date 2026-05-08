'use strict';

const path   = require('path');
const os     = require('os');
const fs     = require('fs');
const { spawn } = require('child_process');
const { v4: uuid } = require('uuid');
const { getObjectStream, putObjectStream } = require('./r2');

const VIDEO_EXTS = new Set(['.mxf', '.mp4', '.mov', '.m4v', '.avi', '.mkv', '.mts', '.m2ts']);

function isVideoFile(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return VIDEO_EXTS.has(name.slice(dot).toLowerCase());
}

function topFolder(folder) {
  if (!folder) return '';
  const slash = folder.indexOf('/');
  return slash === -1 ? folder : folder.slice(0, slash);
}

// Use Intl so this always reflects Sydney time regardless of server TZ setting.
function getSydneyHour() {
  return parseInt(
    new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', hour12: false }).format(new Date()),
    10
  );
}

function inOvernightWindow() {
  if (process.env.TRANSCODE_FORCE === '1') return true;
  const h = getSydneyHour();
  return h >= 21 || h < 9;
}

function nextOvernightStart() {
  if (process.env.TRANSCODE_FORCE === '1') return new Date().toISOString();
  const h = getSydneyHour();
  if (h >= 21 || h < 9) return new Date().toISOString();
  // Schedule for 9pm Sydney tonight
  const fmt = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const [day, month, year] = fmt.split('/');
  const tonightSydney = new Date(`${year}-${month}-${day}T21:00:00+10:00`);
  return tonightSydney.toISOString();
}

// Auto-queue: checks isVideoFile + folder proxy_enabled + dedup
function maybeQueueTranscode(db, file) {
  if (!isVideoFile(file.name)) return;
  const top = topFolder(file.folder ?? '');
  if (!top) return;
  const folder = db.prepare(`SELECT proxy_enabled FROM folders WHERE path=?`).get(top);
  if (!folder || !folder.proxy_enabled) return;
  queueTranscodeJob(db, file);
}

// Manual queue: dedup only, no proxy_enabled check
function queueTranscodeJob(db, file) {
  const existing = db.prepare(
    `SELECT id FROM transcode_jobs WHERE file_id=? AND status IN ('pending','processing')`
  ).get(file.id);
  if (existing) return null;
  const jobId = uuid();
  db.prepare(
    `INSERT INTO transcode_jobs (id, file_id, status, scheduled_at, created_at) VALUES (?, ?, 'pending', ?, datetime('now'))`
  ).run(jobId, file.id, nextOvernightStart());
  console.log(`[transcode] Queued job ${jobId} for ${file.name}`);
  return jobId;
}

let _running      = false;
let _runningStart = null;
const JOB_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

async function runJob(db, sseBus, job) {
  const file = db.prepare(`SELECT * FROM files WHERE id=?`).get(job.file_id);
  if (!file) {
    db.prepare(`UPDATE transcode_jobs SET status='failed', error='file not found', finished_at=datetime('now') WHERE id=?`).run(job.id);
    return;
  }

  db.prepare(`UPDATE transcode_jobs SET status='processing', started_at=datetime('now') WHERE id=?`).run(job.id);
  sseBus.broadcast('transcode', { jobId: job.id, fileId: file.id, status: 'processing' });

  const fileMB = Math.round((file.size || 0) / 1e6);
  const ext    = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '';
  const inFile  = path.join(os.tmpdir(), `fdrop_in_${job.id}${ext}`);
  const outFile = path.join(os.tmpdir(), `fdrop_out_${job.id}.mp4`);

  try {
    // Download original from R2
    console.log(`[transcode] Downloading ${file.r2_key} (${fileMB} MB)`);
    const inStream = await getObjectStream(file.r2_key);
    await new Promise((resolve, reject) => {
      const w = fs.createWriteStream(inFile);
      inStream.on('error', reject);
      w.on('error', reject);
      w.on('finish', resolve);
      inStream.pipe(w);
    });
    console.log(`[transcode] Download done, running ffmpeg`);

    // Run ffmpeg: H.264, max 1920px wide, 2 threads to cap memory, audio copy
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-y', '-i', inFile,
        '-c:v', 'libx264', '-preset', 'fast',
        '-threads', '2',
        '-b:v', '8M', '-maxrate', '12M', '-bufsize', '16M',
        '-vf', "scale='min(1920,iw)':-2",
        '-c:a', 'copy',
        '-movflags', '+faststart',
        outFile,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-600)}`));
      });
      proc.on('error', err => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    });

    // Upload proxy to R2 — <job>/Proxy/<name>_proxy.mp4
    const baseName  = file.name.replace(/\.[^/.]+$/, '');
    const proxyKey  = `${topFolder(file.folder ?? '')}/Proxy/${baseName}_proxy.mp4`;
    const outSize   = fs.statSync(outFile).size;
    const outStream = fs.createReadStream(outFile);
    console.log(`[transcode] Uploading proxy ${proxyKey} (${Math.round(outSize / 1e6)} MB)`);
    await putObjectStream(proxyKey, outStream, outSize, 'video/mp4');

    // Update DB + broadcast
    db.prepare(`UPDATE transcode_jobs SET status='done', proxy_key=?, finished_at=datetime('now') WHERE id=?`).run(proxyKey, job.id);
    db.prepare(`UPDATE files SET proxy_key=? WHERE id=?`).run(proxyKey, file.id);
    const updated = db.prepare(`SELECT * FROM files WHERE id=?`).get(file.id);
    sseBus.broadcast('file', updated);
    sseBus.broadcast('transcode', { jobId: job.id, fileId: file.id, status: 'done', proxyKey });
    console.log(`[transcode] Job ${job.id} done — ${file.name}`);

  } catch (err) {
    console.error(`[transcode] Job ${job.id} failed (${file.name}):`, err.message);
    db.prepare(`UPDATE transcode_jobs SET status='failed', error=?, finished_at=datetime('now') WHERE id=?`).run(err.message.slice(0, 500), job.id);
    sseBus.broadcast('transcode', { jobId: job.id, fileId: file.id, status: 'failed' });
  } finally {
    try { fs.unlinkSync(inFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
}

function startTranscodeScheduler(db, sseBus) {
  // On startup, any job left as 'processing' means the server crashed mid-job.
  // Reset to 'pending' so it retries rather than blocking the queue forever.
  const orphaned = db.prepare(`UPDATE transcode_jobs SET status='pending', started_at=NULL WHERE status='processing'`).run();
  if (orphaned.changes > 0) console.log(`[transcode] Reset ${orphaned.changes} orphaned processing job(s) to pending`);

  const sydneyH = getSydneyHour();
  console.log(`[transcode] Scheduler started — Sydney hour: ${sydneyH}, window open: ${inOvernightWindow()}`);

  setInterval(async () => {
    // Force-reset any job that's been processing > 4 hours (hung ffmpeg)
    if (_running && _runningStart && Date.now() - _runningStart > JOB_TIMEOUT_MS) {
      console.error('[transcode] Job timeout after 4h — force-resetting');
      db.prepare(`UPDATE transcode_jobs SET status='failed', error='timeout after 4h', finished_at=datetime('now') WHERE status='processing'`).run();
      _running      = false;
      _runningStart = null;
    }
    if (_running) return;
    if (!inOvernightWindow()) return;
    const job = db.prepare(`
      SELECT * FROM transcode_jobs
      WHERE status='pending' AND scheduled_at <= datetime('now')
      ORDER BY scheduled_at ASC LIMIT 1
    `).get();
    if (!job) return;
    _running      = true;
    _runningStart = Date.now();
    try { await runJob(db, sseBus, job); }
    catch (err) { console.error('[transcode] Scheduler error:', err.message); }
    finally { _running = false; _runningStart = null; }
  }, 60_000);
}

module.exports = { maybeQueueTranscode, queueTranscodeJob, startTranscodeScheduler, isVideoFile };
