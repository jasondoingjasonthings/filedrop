'use strict';

// Print sets — thank-you prints with one QR on every card (wttf.com.au/prints)
// and a handwritten two-word code that opens that client's share page.
//
// A print set is a thin layer over a normal share link:
//   1. POST /api/prints            → makes the set and its folder (Prints/2026-10 Client)
//   2. the dashboard uploads the photos with the normal browser upload
//   3. POST /api/prints/:id/finish → makes the share link + code, only once every
//      photo has landed (so the ZIP is never built from a half-uploaded folder)
//   4. POST /prints/open           → public; code in, share page URL out

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { rateLimit } = require('express-rate-limit');
const { makeAuthMiddleware, requireOwner } = require('../auth');
const { logAudit } = require('../audit');
const { createShareLink } = require('./shares');
const { deleteShareZip, scheduleZipInvalidation } = require('../zipbuilder');
const { queuePreviews } = require('../thumbnail');
const { generateCode, compactCode } = require('../printwords');

// YYYY-MM in Brisbane time, for folder names like "Prints/2026-10 Riverbend Station"
const MONTH_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Brisbane', year: 'numeric', month: '2-digit' });

function cleanClientName(name) {
  return String(name || '').replace(/[\\/]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function folderInUse(db, folder) {
  return !!(
    db.prepare(`SELECT 1 FROM files WHERE (folder=? OR folder LIKE ?) AND status NOT IN ('deleted','deleting') LIMIT 1`).get(folder, folder + '/%') ||
    db.prepare(`SELECT 1 FROM folders WHERE path=?`).get(folder) ||
    db.prepare(`SELECT 1 FROM print_sets WHERE folder=?`).get(folder)
  );
}

// A repeat client in the same month gets "(2)" rather than sharing a folder
function pickFolder(db, client) {
  const base = `Prints/${MONTH_FMT.format(new Date())} ${client}`;
  let folder = base;
  for (let n = 2; folderInUse(db, folder); n++) folder = `${base} (${n})`;
  return folder;
}

// Issue a code no client has ever had (revoked and shuffled codes are never reused)
function issueCode(db, setId) {
  const code = generateCode(c => !!db.prepare(`SELECT 1 FROM print_codes WHERE code_compact=?`).get(c));
  db.prepare(`INSERT INTO print_codes (code_compact, code, set_id) VALUES (?, ?, ?)`).run(compactCode(code), code, setId);
  return code;
}

// Remove a print set's share link. The ZIP is only deleted if no other link uses it.
function removeShareLink(db, token) {
  if (!token) return;
  const link = db.prepare(`SELECT id, zip_key FROM share_links WHERE token=?`).get(token);
  if (!link) return;
  db.prepare(`DELETE FROM share_links WHERE id=?`).run(link.id);
  if (link.zip_key) {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM share_links WHERE zip_key=?`).get(link.zip_key);
    if (n === 0) deleteShareZip(link.zip_key);
  }
}

const SET_SELECT = `
  SELECT p.*,
    (SELECT COUNT(*) FROM files f WHERE f.folder=p.folder AND f.status='available') AS photos,
    (SELECT COALESCE(SUM(f.size), 0) FROM files f WHERE f.folder=p.folder AND f.status='available') AS total_size,
    (SELECT COUNT(*) FROM files f WHERE f.folder=p.folder AND f.status='uploading'
       AND f.last_seen_at >= datetime('now', '-5 minutes')) AS uploading,
    (SELECT 1 FROM share_links s WHERE s.token=p.share_token AND s.expires_at > datetime('now')) AS share_ok
  FROM print_sets p`;

function toApi(row) {
  if (!row) return null;
  // A live set whose share link was revoked from the share window can't open any more
  const status = row.status === 'live' && !row.share_ok ? 'broken' : row.status;
  return {
    id: row.id, client: row.client, folder: row.folder, note: row.note || '', status,
    code: row.status === 'uploading' ? null : row.code,
    shareToken: status === 'live' ? row.share_token : null,
    photos: row.photos, uploading: row.uploading, totalSize: row.total_size,
    createdAt: row.created_at, codeMadeAt: row.code_made_at, openedAt: row.opened_at, revokedAt: row.revoked_at,
  };
}

function getSet(db, id) {
  return db.prepare(`${SET_SELECT} WHERE p.id=?`).get(id);
}

// ── Owner API (/api/prints) ──────────────────────────────────────────────────

function makePrintsApiRouter(db, jwtSecret, sseBus) {
  const router = express.Router();
  router.use(makeAuthMiddleware(jwtSecret, db), requireOwner);

  const changed = () => sseBus.broadcast('prints-changed', {});

  router.get('/', (req, res) => {
    const rows = db.prepare(`${SET_SELECT} ORDER BY p.created_at DESC, p.id DESC`).all();
    res.json(rows.map(toApi));
  });

  // Start a set: name the client, get the folder to upload into
  router.post('/', (req, res) => {
    const client = cleanClientName(req.body?.client);
    if (!client) { res.status(400).json({ error: "Type the client's name." }); return; }
    const note   = String(req.body?.note || '').trim().slice(0, 120);
    const folder = pickFolder(db, client);
    const { lastInsertRowid } = db.prepare(`INSERT INTO print_sets (client, folder, note) VALUES (?, ?, ?)`).run(client, folder, note || null);
    db.prepare(`INSERT OR IGNORE INTO folders (path) VALUES (?)`).run(folder);
    logAudit(db, { action: 'print_set_created', actor: req.user.username, folder, detail: client, ip: req.ip });
    changed();
    res.status(201).json(toApi(getSet(db, lastInsertRowid)));
  });

  // Every photo has landed: make the share link and the code
  router.post('/:id/finish', (req, res) => {
    const set = getSet(db, req.params.id);
    if (!set) { res.status(404).json({ error: 'Print set not found' }); return; }
    if (set.status !== 'uploading') { res.status(409).json({ error: 'This print set already has a code.' }); return; }
    if (set.uploading > 0) { res.status(409).json({ error: `${set.uploading} photo${set.uploading > 1 ? 's are' : ' is'} still uploading.` }); return; }
    if (set.photos === 0) { res.status(400).json({ error: 'No photos have finished uploading yet.' }); return; }
    // A share covers subfolders too, so a code must only ever sit on a folder without them
    const sub = db.prepare(`SELECT 1 FROM files WHERE folder LIKE ? AND status NOT IN ('deleted','deleting') LIMIT 1`).get(set.folder + '/%');
    if (sub) { res.status(409).json({ error: 'This folder has subfolders, so a code would show more than this client’s photos.' }); return; }

    const { token } = createShareLink(db, { folder: set.folder, label: set.client });
    db.transaction(() => {
      const code = issueCode(db, set.id);
      db.prepare(`
        UPDATE print_sets SET status='live', code=?, code_compact=?, share_token=?, code_made_at=datetime('now')
        WHERE id=?
      `).run(code, compactCode(code), token, set.id);
    })();
    queuePreviews(db, set.folder);
    logAudit(db, { action: 'print_code_made', actor: req.user.username, folder: set.folder, detail: set.client, ip: req.ip });
    changed();
    res.json(toApi(getSet(db, set.id)));
  });

  // More photos added to a live set: rebuild its ZIP and make their phone copies
  router.post('/:id/photos-added', (req, res) => {
    const set = getSet(db, req.params.id);
    if (!set) { res.status(404).json({ error: 'Print set not found' }); return; }
    if (set.uploading > 0) { res.status(409).json({ error: `${set.uploading} photo${set.uploading > 1 ? 's are' : ' is'} still uploading.` }); return; }
    scheduleZipInvalidation(db, set.folder);
    queuePreviews(db, set.folder);
    changed();
    res.json(toApi(getSet(db, set.id)));
  });

  // New words — only while nobody has used the code yet (i.e. before it's on a posted card)
  router.post('/:id/shuffle', (req, res) => {
    const set = getSet(db, req.params.id);
    if (!set) { res.status(404).json({ error: 'Print set not found' }); return; }
    if (set.status !== 'live') { res.status(409).json({ error: 'Only a live code can be shuffled.' }); return; }
    if (set.opened_at) { res.status(409).json({ error: 'This code has already been used, so it can’t change.' }); return; }
    db.transaction(() => {
      const code = issueCode(db, set.id);
      db.prepare(`UPDATE print_sets SET code=?, code_compact=?, code_made_at=datetime('now') WHERE id=?`).run(code, compactCode(code), set.id);
    })();
    changed();
    res.json(toApi(getSet(db, set.id)));
  });

  // Stop the code (and its share link) working. The photos stay in the folder.
  router.post('/:id/revoke', (req, res) => {
    const set = getSet(db, req.params.id);
    if (!set) { res.status(404).json({ error: 'Print set not found' }); return; }
    if (set.status !== 'live') { res.status(409).json({ error: 'This code isn’t live.' }); return; }
    removeShareLink(db, set.share_token);
    db.prepare(`UPDATE print_sets SET status='revoked', share_token=NULL, revoked_at=datetime('now') WHERE id=?`).run(set.id);
    logAudit(db, { action: 'print_code_revoked', actor: req.user.username, folder: set.folder, detail: `${set.client}: ${set.code}`, ip: req.ip });
    changed();
    res.json(toApi(getSet(db, set.id)));
  });

  // Fresh code (and share link) for a revoked set, or one whose link was removed elsewhere
  router.post('/:id/new-code', (req, res) => {
    const set = getSet(db, req.params.id);
    if (!set) { res.status(404).json({ error: 'Print set not found' }); return; }
    const status = toApi(set).status;
    if (status !== 'revoked' && status !== 'broken') { res.status(409).json({ error: 'This print set already has a working code.' }); return; }
    if (set.photos === 0) { res.status(400).json({ error: 'There are no photos in this folder any more.' }); return; }
    removeShareLink(db, set.share_token);
    const { token } = createShareLink(db, { folder: set.folder, label: set.client });
    db.transaction(() => {
      const code = issueCode(db, set.id);
      db.prepare(`
        UPDATE print_sets SET status='live', code=?, code_compact=?, share_token=?, code_made_at=datetime('now'),
          opened_at=NULL, revoked_at=NULL
        WHERE id=?
      `).run(code, compactCode(code), token, set.id);
    })();
    logAudit(db, { action: 'print_code_made', actor: req.user.username, folder: set.folder, detail: `${set.client} (new code)`, ip: req.ip });
    changed();
    res.json(toApi(getSet(db, set.id)));
  });

  // Drop an unfinished set from the list. Photos already uploaded stay in the folder.
  router.delete('/:id', (req, res) => {
    const set = getSet(db, req.params.id);
    if (!set) { res.status(404).json({ error: 'Print set not found' }); return; }
    if (set.status !== 'uploading') { res.status(409).json({ error: 'Revoke the code instead — this set is live.' }); return; }
    db.prepare(`DELETE FROM print_sets WHERE id=?`).run(set.id);
    changed();
    res.json({ ok: true });
  });

  return router;
}

// ── Public (/prints) ─────────────────────────────────────────────────────────

// Wrong guesses are limited per address (10 per 15 minutes), and across everyone
// (120 an hour) so a spread-out attempt to guess codes stalls too.
const GLOBAL_FAIL_LIMIT  = 120;
const GLOBAL_FAIL_WINDOW = 60 * 60_000;
let _globalFails = [];
let _lockoutLogged = false;

function makePrintsPublicRouter(db, sseBus) {
  const router = express.Router();

  const perIpLimiter = rateLimit({
    windowMs: 15 * 60_000,
    max: 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many' },
  });

  router.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    res.send(fs.readFileSync(path.join(__dirname, '../html/prints.html'), 'utf-8'));
  });

  router.post('/open', perIpLimiter, (req, res) => {
    const now = Date.now();
    _globalFails = _globalFails.filter(t => now - t < GLOBAL_FAIL_WINDOW);
    if (_globalFails.length >= GLOBAL_FAIL_LIMIT) {
      if (!_lockoutLogged) {
        _lockoutLogged = true;
        console.warn(`[prints] ${GLOBAL_FAIL_LIMIT} wrong codes in the last hour — pausing code checks`);
        logAudit(db, { action: 'print_codes_paused', actor: 'public', detail: `${GLOBAL_FAIL_LIMIT} wrong codes in an hour`, ip: req.ip });
      }
      res.status(429).json({ error: 'too_many' });
      return;
    }
    _lockoutLogged = false;

    const compact = compactCode(req.body?.code);
    if (!compact) { res.status(400).json({ error: 'empty' }); return; }

    const set = db.prepare(`
      SELECT p.id, p.client, p.folder, p.opened_at, s.token FROM print_sets p
      JOIN share_links s ON s.token = p.share_token AND s.expires_at > datetime('now')
      WHERE p.code_compact=? AND p.status='live'
    `).get(compact);

    if (!set) {
      _globalFails.push(now);
      res.status(404).json({ error: 'no_match' });
      return;
    }

    if (!set.opened_at) {
      db.prepare(`UPDATE print_sets SET opened_at=datetime('now') WHERE id=?`).run(set.id);
      sseBus.broadcast('prints-changed', {});
    }
    logAudit(db, { action: 'print_code_opened', actor: 'print card', folder: set.folder, detail: set.client, ip: req.ip });
    res.json({ url: `/share/${set.token}` });
  });

  return router;
}

module.exports = { makePrintsApiRouter, makePrintsPublicRouter };
