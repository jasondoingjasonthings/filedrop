'use strict';

const path  = require('path');
const sharp = require('sharp');
const { getObjectStream, putObject } = require('./r2');

async function generateThumbnail(file, db, sseBus) {
  const ext = path.extname(file.name).toLowerCase();
  if (ext !== '.jpg' && ext !== '.jpeg') return;

  const thumbnailKey = `thumbnails/${file.r2_key}`;

  try {
    console.log(`[thumbnail] Generating for ${file.name}`);

    // Stream from R2 directly into sharp — avoids loading the full image into memory.
    const inputStream  = await getObjectStream(file.r2_key);
    const sharpPipeline = sharp()
      .resize(300, null, { withoutEnlargement: true })
      .jpeg({ quality: 80 });

    // Propagate source stream errors into sharp so toBuffer() rejects cleanly.
    inputStream.on('error', err => sharpPipeline.destroy(err));
    inputStream.pipe(sharpPipeline);

    const thumb = await sharpPipeline.toBuffer();
    await putObject(thumbnailKey, thumb, 'image/jpeg');

    db.prepare(`UPDATE files SET thumbnail_key=? WHERE id=?`).run(thumbnailKey, file.id);
    const updated = db.prepare(`SELECT * FROM files WHERE id=?`).get(file.id);
    if (sseBus) sseBus.broadcast('file', updated);
    console.log(`[thumbnail] ✓ ${file.name}`);
  } catch (err) {
    console.error(`[thumbnail] Failed for ${file.name}:`, err.message);
  }
}

// ── Phone-size previews (print sets) ─────────────────────────────────────────
// Print files are full resolution (often 15–25 MB), which is slow to open in the
// share page lightbox on a phone. This saves a ~2000px copy next to the original;
// the original is never modified and Download still serves it.
// One at a time, so a big set doesn't spike memory.

const _previewQueued = new Set();
let _previewChain = Promise.resolve();

function queuePreviews(db, folder) {
  const rows = db.prepare(`
    SELECT * FROM files WHERE folder=? AND status='available' AND preview_key IS NULL
  `).all(folder).filter(f => /\.jpe?g$/i.test(f.name) && !_previewQueued.has(f.id));
  for (const f of rows) {
    _previewQueued.add(f.id);
    _previewChain = _previewChain
      .then(() => generatePreview(f, db))
      .finally(() => _previewQueued.delete(f.id));
  }
  return rows.length;
}

async function generatePreview(file, db) {
  const previewKey = `previews/${file.r2_key}`;
  try {
    const inputStream = await getObjectStream(file.r2_key);
    const sharpPipeline = sharp()
      .rotate() // respect camera orientation
      .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 });
    inputStream.on('error', err => sharpPipeline.destroy(err));
    inputStream.pipe(sharpPipeline);

    const preview = await sharpPipeline.toBuffer();
    await putObject(previewKey, preview, 'image/jpeg');
    db.prepare(`UPDATE files SET preview_key=? WHERE id=?`).run(previewKey, file.id);
    console.log(`[preview] ✓ ${file.name}`);
  } catch (err) {
    console.error(`[preview] Failed for ${file.name}:`, err.message);
  }
}

module.exports = { generateThumbnail, queuePreviews };
