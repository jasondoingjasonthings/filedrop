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

module.exports = { generateThumbnail };
