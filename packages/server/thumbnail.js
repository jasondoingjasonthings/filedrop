'use strict';

const path  = require('path');
const sharp = require('sharp');
const { getObject, putObject } = require('./r2');

async function generateThumbnail(file, db, sseBus) {
  const ext = path.extname(file.name).toLowerCase();
  if (ext !== '.jpg' && ext !== '.jpeg') return;

  const thumbnailKey = `thumbnails/${file.r2_key}`;

  try {
    console.log(`[thumbnail] Generating for ${file.name}`);
    const original = await getObject(file.r2_key);
    const thumb    = await sharp(original)
      .resize(300, null, { withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

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
