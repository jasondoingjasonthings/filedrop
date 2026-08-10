import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  signJwt, verifyJwt, hashPassword, checkPassword, JWT_EXPIRY_SECONDS,
  authMiddleware, agentMiddleware, ownerMiddleware,
} from './auth.js'
import {
  makeR2Client, presignDownload, presignUpload, headObject, deleteObject,
  createMultipart, presignPart, completeMultipart, abortMultipart, validateMultipart,
} from './r2.js'

const app = new Hono()

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
  maxAge: 86400,
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const BLOCKED_EXT = new Set(['.exe','.bat','.cmd','.com','.ps1','.vbs','.wsf','.msi','.dll','.scr','.pif'])
const isBlocked = name => BLOCKED_EXT.has(name.slice(name.lastIndexOf('.')).toLowerCase())

const ownerExists = async db => {
  const r = await db.prepare(`SELECT COUNT(*) as n FROM users WHERE role='owner'`).first()
  return (r?.n ?? 0) > 0
}

const logAudit = async (db, { action, actor, fileId, fileName, folder, detail, ip }) => {
  try {
    await db.prepare(`INSERT INTO audit_log (action,actor,file_id,file_name,folder,detail,ip) VALUES (?,?,?,?,?,?,?)`)
      .bind(action, actor||null, fileId||null, fileName||null, folder||null, detail||null, ip||null).run()
  } catch {}
}

// Touch updated_at on file mutations so SSE polling picks up changes
const touchFile = async (db, id) => {
  await db.prepare(`UPDATE files SET updated_at=datetime('now') WHERE id=?`).bind(id).run()
}

const clientIp = c => c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown'

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', async c => {
  try {
    await c.env.DB.prepare('SELECT 1').first()
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: e.message }, 503)
  }
})

// ── Setup ─────────────────────────────────────────────────────────────────────

app.get('/setup', async c => {
  if (await ownerExists(c.env.DB)) return c.redirect('/')
  return c.env.ASSETS.fetch(new Request('http://x/setup.html'))
})

app.post('/api/setup', async c => {
  if (await ownerExists(c.env.DB)) return c.json({ error: 'Already set up' }, 409)
  const { username, password } = await c.req.json().catch(() => ({}))
  if (!username || !password || password.length < 8)
    return c.json({ error: 'username and password (min 8 chars) required' }, 400)
  const hash = await hashPassword(password)
  try {
    await c.env.DB.prepare(`INSERT INTO users (username,password_hash,role) VALUES (?,?,'owner')`).bind(username, hash).run()
    return c.json({ ok: true })
  } catch {
    return c.json({ error: 'Username already exists' }, 409)
  }
})

// ── Auth ──────────────────────────────────────────────────────────────────────

const loginLog = new Map()

app.post('/api/auth/login', async c => {
  const ip = clientIp(c)
  const now = Date.now()
  const times = (loginLog.get(ip) || []).filter(t => now - t < 15 * 60_000)
  if (times.length >= 10) return c.json({ error: 'Too many login attempts — try again in 15 minutes' }, 429)
  loginLog.set(ip, [...times, now])

  const { username, password } = await c.req.json().catch(() => ({}))
  if (!username || !password) return c.json({ error: 'Username and password required' }, 400)
  const user = await c.env.DB.prepare(`SELECT * FROM users WHERE username=?`).bind(username).first()
  if (!user || !(await checkPassword(password, user.password_hash)))
    return c.json({ error: 'Invalid credentials' }, 401)

  const token = await signJwt(
    { sub: user.id, username: user.username, role: user.role, exp: Math.floor(Date.now()/1000) + JWT_EXPIRY_SECONDS },
    c.env.JWT_SECRET
  )
  return c.json({ token, role: user.role, username: user.username })
})

app.post('/api/auth/logout', async c => {
  const header = c.req.header('authorization') || ''
  if (header.startsWith('Bearer ')) {
    try {
      const decoded = await verifyJwt(header.slice(7), c.env.JWT_SECRET)
      if (decoded.jti && decoded.exp)
        await c.env.DB.prepare(`INSERT OR IGNORE INTO revoked_tokens (jti,expires_at) VALUES (?,?)`)
          .bind(decoded.jti, new Date(decoded.exp * 1000).toISOString()).run()
    } catch {}
  }
  return c.json({ ok: true })
})

// ── SSE (polling-based — 2s granularity, 25s connection then auto-reconnect) ─

app.get('/api/events', async c => {
  const token = c.req.query('token')
  if (!token) return new Response('', { status: 401 })
  try {
    const user = await verifyJwt(token, c.env.JWT_SECRET)
    if (user.jti) {
      const rev = await c.env.DB.prepare(`SELECT 1 FROM revoked_tokens WHERE jti=?`).bind(user.jti).first()
      if (rev) return new Response('', { status: 401 })
    }
  } catch {
    return new Response('', { status: 401 })
  }

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const enc = new TextEncoder()
  const send = (event, data) => { try { writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) } catch {} }
  const comment = () => { try { writer.write(enc.encode(`: hb\n\n`)) } catch {} }

  send('connected', { clientId: crypto.randomUUID() })

  const db = c.env.DB
  let since = new Date(Date.now() - 10_000).toISOString()

  const poll = async () => {
    const now = new Date().toISOString()
    try {
      const [changed, progressing] = await Promise.all([
        db.prepare(`SELECT * FROM files WHERE updated_at >= ? LIMIT 100`).bind(since).all(),
        db.prepare(`SELECT id, upload_progress FROM files WHERE status='uploading' AND last_seen_at >= ?`).bind(since).all(),
      ])
      for (const f of changed.results) send('file', f)
      for (const f of progressing.results) send('progress', { id: f.id, progress: f.upload_progress })
      const qs = await db.prepare(`SELECT value FROM settings WHERE key='queue_status'`).first()
      if (qs) { try { send('queue', JSON.parse(qs.value)) } catch {} }
    } catch {}
    since = now
  }

  ;(async () => {
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 2000))
      await poll()
      comment()
    }
    writer.close()
  })()

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

// ── Dashboard ─────────────────────────────────────────────────────────────────

app.get('/', async c => {
  if (!(await ownerExists(c.env.DB))) return c.redirect('/setup')
  const res = await c.env.ASSETS.fetch(new Request('http://x/dashboard.html'))
  return new Response(res.body, {
    headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
  })
})

// ── Audit ─────────────────────────────────────────────────────────────────────

app.get('/api/audit', authMiddleware, ownerMiddleware, async c => {
  const limit  = Math.min(parseInt(c.req.query('limit')  || '100'), 500)
  const offset = parseInt(c.req.query('offset') || '0')
  const [rows, total] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(limit, offset).all(),
    c.env.DB.prepare(`SELECT COUNT(*) as n FROM audit_log`).first(),
  ])
  return c.json({ rows: rows.results, total: total?.n ?? 0, limit, offset })
})

// ── Files (same-origin download redirect — query token auth) ─────────────────

app.get('/api/files/:id/dl', async c => {
  const tok = c.req.query('token')
  if (!tok) return c.text('Missing token', 401)
  try { await verifyJwt(tok, c.env.JWT_SECRET) } catch { return c.text('Invalid token', 401) }
  const file = await c.env.DB.prepare(`SELECT * FROM files WHERE id=? AND status='available'`).bind(c.req.param('id')).first()
  if (!file) return c.text('File not found', 404)
  try {
    const r2 = makeR2Client(c.env)
    const url = await presignDownload(r2, c.env.R2_BUCKET, file.r2_key, 300, file.name)
    return c.redirect(url, 302)
  } catch { return c.text('Failed to generate download URL', 500) }
})

// ── Files (authenticated) ─────────────────────────────────────────────────────

app.get('/api/files/folders', authMiddleware, async c => {
  const [rows, empties] = await Promise.all([
    c.env.DB.prepare(`
      SELECT folder,
        COUNT(*) as file_count, SUM(size) as total_size,
        MAX(COALESCE(uploaded_at,created_at)) as latest_at,
        SUM(CASE WHEN status='uploading'        THEN 1 ELSE 0 END) as uploading_count,
        SUM(CASE WHEN status='available'        THEN 1 ELSE 0 END) as available_count,
        SUM(CASE WHEN downloaded_at IS NOT NULL THEN 1 ELSE 0 END) as downloaded_count
      FROM files WHERE status NOT IN ('deleted','deleting')
      GROUP BY folder ORDER BY MAX(COALESCE(uploaded_at,created_at)) DESC
    `).all(),
    c.env.DB.prepare(`
      SELECT path FROM folders WHERE path NOT IN
        (SELECT DISTINCT folder FROM files WHERE status NOT IN ('deleted','deleting'))
    `).all(),
  ])
  const out = [...rows.results]
  const fileSet = new Set(out.map(r => r.folder ?? ''))
  for (const f of empties.results) {
    if (!fileSet.has(f.path))
      out.push({ folder: f.path, file_count: 0, total_size: 0, uploading_count: 0, available_count: 0, downloaded_count: 0 })
  }
  return c.json(out)
})

app.post('/api/files/folders', authMiddleware, async c => {
  const { path: p } = await c.req.json().catch(() => ({}))
  if (!p?.trim()) return c.json({ error: 'path required' }, 400)
  await c.env.DB.prepare(`INSERT OR IGNORE INTO folders (path) VALUES (?)`).bind(p.trim()).run()
  return c.json({ ok: true, path: p.trim() })
})

app.post('/api/files/check-existing', authMiddleware, async c => {
  const { files: list } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(list) || !list.length) return c.json({ existing: [] })
  const existing = []
  for (const f of list) {
    if (!f?.name) continue
    const row = await c.env.DB.prepare(
      `SELECT 1 FROM files WHERE name=? AND folder=? AND status IN ('available','uploading') LIMIT 1`
    ).bind(f.name, f.folder ?? '').first()
    if (row) existing.push(`${f.name}|${f.folder ?? ''}`)
  }
  return c.json({ existing })
})

app.post('/api/files/move', authMiddleware, async c => {
  const { ids, folder } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(ids) || !ids.length) return c.json({ error: 'ids required' }, 400)
  const target = folder ?? ''
  const stmts = ids.map(id =>
    c.env.DB.prepare(`UPDATE files SET folder=?,updated_at=datetime('now') WHERE id=? AND status NOT IN ('deleted','deleting')`).bind(target, id)
  )
  await c.env.DB.batch(stmts)
  return c.json({ ok: true, count: ids.length })
})

app.post('/api/files/folder-move', authMiddleware, async c => {
  const { from, to } = await c.req.json().catch(() => ({}))
  if (from === undefined || to === undefined) return c.json({ error: 'from and to required' }, 400)
  const fromKey = from ?? '', toKey = (to || '').trim()
  if (fromKey === toKey) return c.json({ ok: true, count: 0 })
  const stmts = [
    c.env.DB.prepare(`UPDATE files SET folder=?,updated_at=datetime('now') WHERE folder=? AND status NOT IN ('deleted','deleting')`).bind(toKey, fromKey),
    c.env.DB.prepare(`UPDATE folders SET path=? WHERE path=?`).bind(toKey, fromKey),
  ]
  if (fromKey) {
    stmts.push(
      c.env.DB.prepare(`UPDATE files SET folder=?||SUBSTR(folder,?)  ,updated_at=datetime('now') WHERE folder LIKE ? AND status NOT IN ('deleted','deleting')`).bind(toKey, fromKey.length+1, fromKey+'/%'),
      c.env.DB.prepare(`UPDATE folders SET path=?||SUBSTR(path,?) WHERE path LIKE ?`).bind(toKey, fromKey.length+1, fromKey+'/%'),
    )
  }
  const results = await c.env.DB.batch(stmts)
  const count = results.reduce((s, r) => s + (r.meta?.changes || 0), 0)
  return c.json({ ok: true, count })
})

app.get('/api/files/thumbs', authMiddleware, async c => {
  const folder = c.req.query('folder') ?? ''
  const exts = ['jpg','jpeg','png','gif','webp','heic','heif']
  const ph = exts.map(() => '?').join(',')
  const rows = await c.env.DB.prepare(`
    SELECT id,name,thumbnail_key,folder FROM files
    WHERE (folder=? OR folder LIKE ?)
      AND status='available'
      AND LOWER(SUBSTR(name,INSTR(name,'.')+1)) IN (${ph})
    ORDER BY folder,name COLLATE NOCASE ASC LIMIT 60
  `).bind(folder, folder+'/%', ...exts).all()
  const r2 = makeR2Client(c.env)
  const results = await Promise.all(rows.results.map(async f => {
    let thumbnailUrl = null
    if (f.thumbnail_key) {
      try { thumbnailUrl = await presignDownload(r2, c.env.R2_BUCKET, f.thumbnail_key, 3600) } catch {}
    }
    return { id: f.id, name: f.name, folder: f.folder, thumbnailUrl }
  }))
  return c.json(results)
})

app.get('/api/files/in', authMiddleware, async c => {
  const folder = c.req.query('folder') ?? ''
  const limit  = Math.min(parseInt(c.req.query('limit')  || '200'), 1000)
  const offset = parseInt(c.req.query('offset') || '0')
  const [list, total] = await Promise.all([
    c.env.DB.prepare(`
      SELECT * FROM files WHERE folder=? AND status NOT IN ('deleted','deleting')
      ORDER BY name COLLATE NOCASE ASC LIMIT ? OFFSET ?
    `).bind(folder, limit, offset).all(),
    c.env.DB.prepare(`SELECT COUNT(*) as n FROM files WHERE folder=? AND status NOT IN ('deleted','deleting')`).bind(folder).first(),
  ])
  return c.json({ files: list.results, total: total?.n ?? 0, limit, offset })
})

app.get('/api/files/', authMiddleware, async c => c.json([]))

app.patch('/api/files/folder-rename', authMiddleware, async c => {
  const { oldFolder, newFolder, recursive } = await c.req.json().catch(() => ({}))
  if (newFolder === undefined) return c.json({ error: 'newFolder required' }, 400)
  const oldKey = oldFolder ?? '', newKey = (newFolder || '').trim()
  if (oldKey === newKey) return c.json({ ok: true, count: 0 })
  const stmts = recursive ? [
    c.env.DB.prepare(`UPDATE files SET folder=?||SUBSTR(folder,LENGTH(?)+1),updated_at=datetime('now') WHERE (folder=? OR folder LIKE ?) AND status NOT IN ('deleted','deleting')`).bind(newKey, oldKey, oldKey, oldKey+'/%'),
  ] : [
    c.env.DB.prepare(`UPDATE files SET folder=?,updated_at=datetime('now') WHERE folder=? AND status NOT IN ('deleted','deleting')`).bind(newKey, oldKey),
  ]
  const results = await c.env.DB.batch(stmts)
  const count = results[0].meta?.changes || 0
  await logAudit(c.env.DB, { action: 'folder_renamed', actor: c.get('user')?.username, folder: newKey, detail: `was: ${oldKey}`, ip: clientIp(c) })
  return c.json({ ok: true, count })
})

app.get('/api/files/:id', authMiddleware, async c => {
  const file = await c.env.DB.prepare(`SELECT * FROM files WHERE id=?`).bind(c.req.param('id')).first()
  if (!file) return c.json({ error: 'Not found' }, 404)
  return c.json(file)
})

app.post('/api/files/:id/download', authMiddleware, async c => {
  const file = await c.env.DB.prepare(`SELECT * FROM files WHERE id=?`).bind(c.req.param('id')).first()
  if (!file || file.status === 'deleted') return c.json({ error: 'File not found or deleted' }, 404)
  try {
    const r2  = makeR2Client(c.env)
    const url = await presignDownload(r2, c.env.R2_BUCKET, file.r2_key, 3600, file.name)
    if (!file.downloaded_at) {
      await c.env.DB.prepare(`UPDATE files SET downloaded_by=?,downloaded_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
        .bind(c.get('user').sub, file.id).run()
    }
    await logAudit(c.env.DB, { action: 'file_downloaded', actor: c.get('user').username, fileId: file.id, fileName: file.name, folder: file.folder, ip: clientIp(c) })
    return c.json({ url, size: file.size || 0 })
  } catch { return c.json({ error: 'Failed to generate download URL' }, 500) }
})

app.post('/api/files/:id/presign', authMiddleware, ownerMiddleware, async c => {
  const file = await c.env.DB.prepare(`SELECT * FROM files WHERE id=?`).bind(c.req.param('id')).first()
  if (!file || file.status === 'deleted') return c.json({ error: 'Not found' }, 404)
  try {
    const r2  = makeR2Client(c.env)
    const url = await presignDownload(r2, c.env.R2_BUCKET, file.r2_key, 3600, file.name)
    return c.json({ url, name: file.name })
  } catch { return c.json({ error: 'Failed to generate download URL' }, 500) }
})

app.patch('/api/files/:id/rename', authMiddleware, async c => {
  const { name } = await c.req.json().catch(() => ({}))
  if (!name?.trim()) return c.json({ error: 'name required' }, 400)
  const file = await c.env.DB.prepare(`SELECT * FROM files WHERE id=?`).bind(c.req.param('id')).first()
  if (!file) return c.json({ error: 'Not found' }, 404)
  await c.env.DB.prepare(`UPDATE files SET name=?,updated_at=datetime('now') WHERE id=?`).bind(name.trim(), file.id).run()
  await logAudit(c.env.DB, { action: 'file_renamed', actor: c.get('user')?.username, fileId: file.id, fileName: name.trim(), folder: file.folder, detail: `was: ${file.name}`, ip: clientIp(c) })
  return c.json({ ok: true })
})

app.post('/api/files/:id/keep', authMiddleware, async c => {
  const file = await c.env.DB.prepare(`SELECT * FROM files WHERE id=?`).bind(c.req.param('id')).first()
  if (!file) return c.json({ error: 'Not found' }, 404)
  await c.env.DB.prepare(`UPDATE files SET delete_at=NULL,status='available',updated_at=datetime('now') WHERE id=?`).bind(file.id).run()
  return c.json({ ok: true })
})

app.delete('/api/files/:id', authMiddleware, async c => {
  const file = await c.env.DB.prepare(`SELECT * FROM files WHERE id=?`).bind(c.req.param('id')).first()
  if (!file) return c.json({ error: 'Not found' }, 404)
  try {
    if (file.status !== 'deleted') {
      const r2 = makeR2Client(c.env)
      await deleteObject(r2, c.env.R2_BUCKET, file.r2_key)
    }
    await c.env.DB.prepare(`UPDATE files SET status='deleted',deleted_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).bind(file.id).run()
    await logAudit(c.env.DB, { action: 'file_deleted', actor: c.get('user')?.username, fileId: file.id, fileName: file.name, folder: file.folder, ip: clientIp(c) })
    return c.json({ ok: true })
  } catch (e) { return c.json({ error: 'Delete failed' }, 500) }
})

// ── Upload (agent) ────────────────────────────────────────────────────────────

app.post('/api/upload/register', agentMiddleware, async c => {
  const { name, r2_key, size, folder } = await c.req.json().catch(() => ({}))
  if (!name || !r2_key) return c.json({ error: 'name and r2_key required' }, 400)
  if (isBlocked(name)) return c.json({ error: `File type not allowed: ${name}` }, 422)
  const folderKey = folder || ''

  const available = await c.env.DB.prepare(`SELECT id FROM files WHERE name=? AND folder=? AND status='available' LIMIT 1`).bind(name, folderKey).first()
  if (available) return c.json({ id: available.id, skip: true })

  const activeUpload = await c.env.DB.prepare(`SELECT id FROM files WHERE name=? AND folder=? AND status='uploading' AND last_seen_at >= datetime('now','-5 minutes') LIMIT 1`).bind(name, folderKey).first()
  if (activeUpload) return c.json({ id: activeUpload.id, skip: true })

  const stale = await c.env.DB.prepare(`SELECT id FROM files WHERE name=? AND folder=? AND status='uploading' AND (last_seen_at IS NULL OR last_seen_at < datetime('now','-5 minutes'))`).bind(name, folderKey).all()
  if (stale.results.length) {
    const delStmts = stale.results.map(s => c.env.DB.prepare(`UPDATE files SET status='deleted',updated_at=datetime('now') WHERE id=?`).bind(s.id))
    await c.env.DB.batch(delStmts)
  }

  const id = crypto.randomUUID()
  try {
    await c.env.DB.prepare(`INSERT INTO files (id,name,r2_key,size,folder,status,upload_progress,last_seen_at,updated_at) VALUES (?,?,?,?,?,'uploading',0,datetime('now'),datetime('now'))`).bind(id, name, r2_key, size||0, folderKey).run()
    return c.json({ id })
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return c.json({ error: 'r2_key conflict — retry with a new key' }, 409)
    return c.json({ error: 'Registration failed' }, 500)
  }
})

app.patch('/api/upload/:id/heartbeat', agentMiddleware, async c => {
  await c.env.DB.prepare(`UPDATE files SET last_seen_at=datetime('now') WHERE id=? AND status='uploading'`).bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

app.patch('/api/upload/:id/progress', agentMiddleware, async c => {
  const { progress } = await c.req.json().catch(() => ({}))
  await c.env.DB.prepare(`UPDATE files SET upload_progress=?,last_seen_at=datetime('now') WHERE id=?`).bind(progress, c.req.param('id')).run()
  return c.json({ ok: true })
})

app.patch('/api/upload/:id/complete', agentMiddleware, async c => {
  const { size, checksum } = await c.req.json().catch(() => ({}))
  const id = c.req.param('id')
  await c.env.DB.prepare(`
    UPDATE files SET status='available',upload_progress=100,uploaded_at=datetime('now'),updated_at=datetime('now'),
      size=COALESCE(?,size),checksum=COALESCE(?,checksum)
    WHERE id=? AND status='uploading'
  `).bind(size||null, checksum||null, id).run()
  const file = await c.env.DB.prepare(`SELECT * FROM files WHERE id=?`).bind(id).first()
  if (file?.status === 'available')
    await logAudit(c.env.DB, { action: 'file_uploaded', actor: 'agent', fileId: file.id, fileName: file.name, folder: file.folder })
  return c.json({ ok: true })
})

app.patch('/api/upload/:id/fail', agentMiddleware, async c => {
  await c.env.DB.prepare(`UPDATE files SET status='deleted',updated_at=datetime('now') WHERE id=?`).bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

app.post('/api/upload/multipart/create', agentMiddleware, async c => {
  const { r2_key } = await c.req.json().catch(() => ({}))
  if (!r2_key) return c.json({ error: 'r2_key required' }, 400)
  try { return c.json({ uploadId: await createMultipart(makeR2Client(c.env), c.env.R2_BUCKET, r2_key) }) }
  catch (e) { return c.json({ error: e.message }, 500) }
})

app.post('/api/upload/multipart/part-url', agentMiddleware, async c => {
  const { r2_key, uploadId, partNumber } = await c.req.json().catch(() => ({}))
  try { return c.json({ url: await presignPart(makeR2Client(c.env), c.env.R2_BUCKET, r2_key, uploadId, partNumber) }) }
  catch (e) { return c.json({ error: e.message }, 500) }
})

app.post('/api/upload/multipart/complete', agentMiddleware, async c => {
  const { r2_key, uploadId, parts } = await c.req.json().catch(() => ({}))
  try { await completeMultipart(makeR2Client(c.env), c.env.R2_BUCKET, r2_key, uploadId, parts); return c.json({ ok: true }) }
  catch (e) { return c.json({ error: e.message }, 500) }
})

app.post('/api/upload/multipart/abort', agentMiddleware, async c => {
  const { r2_key, uploadId } = await c.req.json().catch(() => ({}))
  try { await abortMultipart(makeR2Client(c.env), c.env.R2_BUCKET, r2_key, uploadId); return c.json({ ok: true }) }
  catch (e) { return c.json({ error: e.message }, 500) }
})

app.post('/api/upload/presign', agentMiddleware, async c => {
  const { r2_key } = await c.req.json().catch(() => ({}))
  if (!r2_key) return c.json({ error: 'r2_key required' }, 400)
  try { return c.json({ url: await presignUpload(makeR2Client(c.env), c.env.R2_BUCKET, r2_key, 3600) }) }
  catch (e) { return c.json({ error: e.message }, 500) }
})

app.get('/api/upload/:id/verify', agentMiddleware, async c => {
  const file = await c.env.DB.prepare(`SELECT r2_key,size FROM files WHERE id=?`).bind(c.req.param('id')).first()
  if (!file) return c.json({ error: 'Not found' }, 404)
  const head = await headObject(makeR2Client(c.env), c.env.R2_BUCKET, file.r2_key)
  return c.json(head ? { exists: true, size: head.ContentLength } : { exists: false })
})

app.post('/api/upload/queue-status', agentMiddleware, async c => {
  const body = await c.req.json().catch(() => ({}))
  await c.env.DB.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES ('queue_status',?)`).bind(JSON.stringify(body)).run()
  return c.json({ ok: true })
})

// Agent token management (owner only)
app.get('/api/upload/agent-token', authMiddleware, ownerMiddleware, async c => {
  let row = await c.env.DB.prepare(`SELECT token FROM agent_tokens LIMIT 1`).first()
  if (!row) {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2,'0')).join('')
    await c.env.DB.prepare(`INSERT INTO agent_tokens (token,label) VALUES (?,'default')`).bind(token).run()
    row = { token }
  }
  return c.json({ token: row.token })
})

app.delete('/api/upload/agent-token', authMiddleware, ownerMiddleware, async c => {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2,'0')).join('')
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM agent_tokens`),
    c.env.DB.prepare(`INSERT INTO agent_tokens (token,label) VALUES (?,'default')`).bind(token),
  ])
  return c.json({ token })
})

// ── Upload (browser/JWT) ──────────────────────────────────────────────────────

app.post('/api/upload/browser/start', authMiddleware, async c => {
  const { name, size, folder, r2Key: resumeKey } = await c.req.json().catch(() => ({}))
  if (!name) return c.json({ error: 'name required' }, 400)
  if (isBlocked(name)) return c.json({ error: `File type not allowed: ${name}` }, 422)
  const dotIdx = name.lastIndexOf('.')
  const ext  = dotIdx > 0 ? name.slice(dotIdx) : ''
  const base = (dotIdx > 0 ? name.slice(0, dotIdx) : name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file'
  const freshKey = () => (folder ? `${folder}/` : '') + `${Date.now()}-${base}${ext}`
  let r2Key = resumeKey || freshKey(), id = crypto.randomUUID()

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await c.env.DB.prepare(`INSERT INTO files (id,name,r2_key,size,folder,status,upload_progress,last_seen_at,updated_at) VALUES (?,?,?,?,?,'uploading',0,datetime('now'),datetime('now'))`).bind(id, name, r2Key, size||0, folder||'').run()
      break
    } catch (e) {
      if (e.message?.includes('UNIQUE') && attempt === 0 && resumeKey) { r2Key = freshKey(); id = crypto.randomUUID(); continue }
      return c.json({ error: e.message }, e.message?.includes('UNIQUE') ? 409 : 500)
    }
  }
  try {
    const url = await presignUpload(makeR2Client(c.env), c.env.R2_BUCKET, r2Key, 3600)
    return c.json({ id, url, r2Key })
  } catch (e) {
    await c.env.DB.prepare(`UPDATE files SET status='deleted' WHERE id=?`).bind(id).run()
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/upload/browser/complete/:id', authMiddleware, async c => {
  const { size, checksum } = await c.req.json().catch(() => ({}))
  const id = c.req.param('id')
  await c.env.DB.prepare(`UPDATE files SET status='available',upload_progress=100,uploaded_at=datetime('now'),updated_at=datetime('now'),size=COALESCE(?,size),checksum=COALESCE(?,checksum) WHERE id=?`).bind(size||null, checksum||null, id).run()
  const file = await c.env.DB.prepare(`SELECT * FROM files WHERE id=?`).bind(id).first()
  if (file) await logAudit(c.env.DB, { action: 'file_uploaded', actor: c.get('user')?.username, fileId: file.id, fileName: file.name, folder: file.folder, ip: clientIp(c) })
  return c.json({ ok: true })
})

app.patch('/api/upload/browser/heartbeat/:id', authMiddleware, async c => {
  await c.env.DB.prepare(`UPDATE files SET last_seen_at=datetime('now') WHERE id=? AND status='uploading'`).bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

app.post('/api/upload/browser/multipart/validate', authMiddleware, async c => {
  const { r2_key, uploadId } = await c.req.json().catch(() => ({}))
  if (!r2_key || !uploadId) return c.json({ error: 'r2_key and uploadId required' }, 400)
  try { return c.json({ valid: await validateMultipart(makeR2Client(c.env), c.env.R2_BUCKET, r2_key, uploadId) }) }
  catch (e) { return c.json({ error: e.message }, 500) }
})

app.post('/api/upload/browser/multipart/create', authMiddleware, async c => {
  const { r2_key } = await c.req.json().catch(() => ({}))
  if (!r2_key) return c.json({ error: 'r2_key required' }, 400)
  try { return c.json({ uploadId: await createMultipart(makeR2Client(c.env), c.env.R2_BUCKET, r2_key) }) }
  catch (e) { return c.json({ error: e.message }, 500) }
})

app.post('/api/upload/browser/multipart/part-url', authMiddleware, async c => {
  const { r2_key, uploadId, partNumber } = await c.req.json().catch(() => ({}))
  try { return c.json({ url: await presignPart(makeR2Client(c.env), c.env.R2_BUCKET, r2_key, uploadId, partNumber) }) }
  catch (e) { return c.json({ error: e.message }, 500) }
})

app.post('/api/upload/browser/multipart/complete', authMiddleware, async c => {
  const { r2_key, uploadId, parts } = await c.req.json().catch(() => ({}))
  try { await completeMultipart(makeR2Client(c.env), c.env.R2_BUCKET, r2_key, uploadId, parts); return c.json({ ok: true }) }
  catch (e) { return c.json({ error: e.message }, 500) }
})

app.post('/api/upload/browser/multipart/abort', authMiddleware, async c => {
  const { r2_key, uploadId } = await c.req.json().catch(() => ({}))
  try { await abortMultipart(makeR2Client(c.env), c.env.R2_BUCKET, r2_key, uploadId); return c.json({ ok: true }) }
  catch (e) { return c.json({ error: e.message }, 500) }
})

app.post('/api/upload/browser/fail/:id', authMiddleware, async c => {
  await c.env.DB.prepare(`UPDATE files SET status='deleted',updated_at=datetime('now') WHERE id=?`).bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// ── Users (owner only) ────────────────────────────────────────────────────────

app.get('/api/users', authMiddleware, ownerMiddleware, async c => {
  const users = await c.env.DB.prepare(`SELECT id,username,role,created_at FROM users ORDER BY id`).all()
  return c.json(users.results)
})

app.post('/api/users', authMiddleware, ownerMiddleware, async c => {
  const { username, password, role } = await c.req.json().catch(() => ({}))
  if (!username || !password || !['owner','editor'].includes(role))
    return c.json({ error: 'username, password and role required' }, 400)
  if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)
  try {
    const hash = await hashPassword(password)
    const r = await c.env.DB.prepare(`INSERT INTO users (username,password_hash,role) VALUES (?,?,?) RETURNING id,username,role,created_at`).bind(username, hash, role).first()
    return c.json(r, 201)
  } catch { return c.json({ error: 'Username already exists' }, 409) }
})

app.patch('/api/users/:id/password', authMiddleware, ownerMiddleware, async c => {
  const { password } = await c.req.json().catch(() => ({}))
  if (!password || password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)
  await c.env.DB.prepare(`UPDATE users SET password_hash=? WHERE id=?`).bind(await hashPassword(password), c.req.param('id')).run()
  return c.json({ ok: true })
})

app.delete('/api/users/:id', authMiddleware, ownerMiddleware, async c => {
  if (parseInt(c.req.param('id')) === c.get('user').sub)
    return c.json({ error: 'Cannot delete yourself' }, 400)
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE files SET downloaded_by=NULL WHERE downloaded_by=?`).bind(c.req.param('id')),
    c.env.DB.prepare(`DELETE FROM file_requests WHERE user_id=?`).bind(c.req.param('id')),
    c.env.DB.prepare(`DELETE FROM users WHERE id=?`).bind(c.req.param('id')),
  ])
  return c.json({ ok: true })
})

// ── Shares (API — authenticated) ──────────────────────────────────────────────

const LARGE_THRESHOLD = 15 * 1024 * 1024 * 1024

app.post('/api/shares', authMiddleware, async c => {
  const { folder, label, days = 7, cover_image_id } = await c.req.json().catch(() => ({}))
  const token     = Array.from(crypto.getRandomValues(new Uint8Array(24))).map(b => b.toString(16).padStart(2,'0')).join('')
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString()
  const shareLabel = label || folder || 'Shared files'
  const db = c.env.DB

  await db.prepare(`INSERT INTO share_links (token,folder,label,expires_at,cover_image_id) VALUES (?,?,?,?,?)`)
    .bind(token, folder ?? '', shareLabel, expiresAt, cover_image_id ?? null).run()

  const { total } = await db.prepare(`SELECT COALESCE(SUM(size),0) as total FROM files WHERE (folder=? OR folder LIKE ?) AND status='available'`).bind(folder ?? '', (folder ?? '')+'/%').first()
  const zipStatus = total >= LARGE_THRESHOLD ? 'large' : 'none'
  await db.prepare(`UPDATE share_links SET zip_status=? WHERE token=?`).bind(zipStatus, token).run()

  return c.json({ token, expiresAt })
})

app.get('/api/shares', authMiddleware, async c => {
  const links = await c.env.DB.prepare(`SELECT * FROM share_links WHERE expires_at > datetime('now') ORDER BY created_at DESC`).all()
  return c.json(links.results)
})

app.patch('/api/shares/:id/extend', authMiddleware, async c => {
  const { days = 7 } = await c.req.json().catch(() => ({}))
  const link = await c.env.DB.prepare(`SELECT * FROM share_links WHERE id=?`).bind(c.req.param('id')).first()
  if (!link) return c.json({ error: 'Not found' }, 404)
  const newExpiry = new Date(Math.max(Date.now(), new Date(link.expires_at).getTime()) + days * 86400000).toISOString()
  await c.env.DB.prepare(`UPDATE share_links SET expires_at=? WHERE id=?`).bind(newExpiry, c.req.param('id')).run()
  return c.json({ expiresAt: newExpiry })
})

app.delete('/api/shares/:id', authMiddleware, async c => {
  await c.env.DB.prepare(`DELETE FROM share_links WHERE id=?`).bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// ── Shares (public) ───────────────────────────────────────────────────────────

app.get('/share/:token', async c => {
  const link = await c.env.DB.prepare(`SELECT 1 FROM share_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.html('<h2>This link has expired or does not exist.</h2>', 404)
  return c.env.ASSETS.fetch(new Request('http://x/share.html'))
})

app.get('/share/:token/files', async c => {
  const link = await c.env.DB.prepare(`SELECT * FROM share_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.json({ error: 'Link expired or not found' }, 404)

  const rows = await c.env.DB.prepare(`
    SELECT id,name,size,folder,uploaded_at,created_at,r2_key,thumbnail_key FROM files
    WHERE (folder=? OR folder LIKE ?) AND status='available'
    ORDER BY folder COLLATE NOCASE, name COLLATE NOCASE
  `).bind(link.folder, link.folder+'/%').all()

  const r2 = makeR2Client(c.env)
  const PRESIGN_TTL = 3600
  const files = await Promise.all(rows.results.map(async f => {
    const ext = (f.name || '').split('.').pop().toLowerCase()
    const isImage = ext === 'jpg' || ext === 'jpeg'
    const out = { id: f.id, name: f.name, size: f.size, folder: f.folder, uploaded_at: f.uploaded_at, created_at: f.created_at, isImage }
    if (isImage) {
      if (f.thumbnail_key) {
        try { out.thumbnailUrl = await presignDownload(r2, c.env.R2_BUCKET, f.thumbnail_key, PRESIGN_TTL) } catch {}
      }
      try { out.fullUrl = await presignDownload(r2, c.env.R2_BUCKET, f.r2_key, PRESIGN_TTL, f.name) } catch {}
    }
    return out
  }))

  let coverUrl = null
  if (link.cover_image_id) {
    const coverFile = await c.env.DB.prepare(`SELECT r2_key FROM files WHERE id=? AND status='available'`).bind(link.cover_image_id).first()
    if (coverFile) {
      try { coverUrl = await presignDownload(r2, c.env.R2_BUCKET, coverFile.r2_key, PRESIGN_TTL) } catch {}
    }
  }

  return c.json({ label: link.label, folder: link.folder, expiresAt: link.expires_at, files, coverUrl })
})

app.post('/share/:token/download/:fileId', async c => {
  const link = await c.env.DB.prepare(`SELECT * FROM share_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.json({ error: 'Link expired' }, 404)
  const file = await c.env.DB.prepare(`SELECT * FROM files WHERE id=? AND (folder=? OR folder LIKE ?) AND status='available'`).bind(c.req.param('fileId'), link.folder, link.folder+'/%').first()
  if (!file) return c.json({ error: 'File not found' }, 404)
  try {
    const url = await presignDownload(makeR2Client(c.env), c.env.R2_BUCKET, file.r2_key, 3600, file.name)
    return c.json({ url, name: file.name })
  } catch { return c.json({ error: 'Failed to generate URL' }, 500) }
})

app.get('/share/:token/zip-status', async c => {
  const link = await c.env.DB.prepare(`SELECT zip_status,zip_files_total,zip_files_done FROM share_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.json({ status: 'none' }, 404)
  return c.json({ status: link.zip_status || 'none', files_total: link.zip_files_total || 0, files_done: link.zip_files_done || 0 })
})

app.get('/share/:token/zip', async c => {
  const link = await c.env.DB.prepare(`SELECT * FROM share_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.text('Link expired', 404)
  if (link.zip_status === 'ready' && link.zip_key) {
    try {
      const zipName = (link.label || link.folder || 'files').replace(/[^a-zA-Z0-9._\- ]/g, '_')
      const url = await presignDownload(makeR2Client(c.env), c.env.R2_BUCKET, link.zip_key, 3600, `${zipName}.zip`)
      await c.env.DB.prepare(`UPDATE share_links SET zip_downloaded_at=datetime('now') WHERE token=?`).bind(c.req.param('token')).run()
      return c.redirect(url, 302)
    } catch {}
  }
  return c.json({ error: 'ZIP not available — use individual file downloads' }, 404)
})

app.get('/share/:token/presign/:fileId', async c => {
  const link = await c.env.DB.prepare(`SELECT * FROM share_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.json({ error: 'Link expired' }, 404)
  const file = await c.env.DB.prepare(`SELECT * FROM files WHERE id=? AND (folder=? OR folder LIKE ?) AND status='available'`).bind(c.req.param('fileId'), link.folder, link.folder+'/%').first()
  if (!file) return c.json({ error: 'File not found' }, 404)
  try {
    const url = await presignDownload(makeR2Client(c.env), c.env.R2_BUCKET, file.r2_key, 7200)
    return c.json({ url })
  } catch { return c.json({ error: 'Failed to generate URL' }, 500) }
})

app.get('/share/:token/stream/:fileId', async c => {
  const link = await c.env.DB.prepare(`SELECT * FROM share_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.text('Link expired', 404)
  const file = await c.env.DB.prepare(`SELECT * FROM files WHERE id=? AND (folder=? OR folder LIKE ?) AND status='available'`).bind(c.req.param('fileId'), link.folder, link.folder+'/%').first()
  if (!file) return c.text('File not found', 404)
  // Redirect to presigned instead of proxying — avoids Worker memory pressure on large files
  try {
    const url = await presignDownload(makeR2Client(c.env), c.env.R2_BUCKET, file.r2_key, 300, file.name)
    return c.redirect(url, 302)
  } catch { return c.text('Download failed', 500) }
})

app.get('/share/:token/dl/:fileId', async c => {
  const link = await c.env.DB.prepare(`SELECT * FROM share_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.text('Link expired', 404)
  const file = await c.env.DB.prepare(`SELECT * FROM files WHERE id=? AND (folder=? OR folder LIKE ?) AND status='available'`).bind(c.req.param('fileId'), link.folder, link.folder+'/%').first()
  if (!file) return c.text('File not found', 404)
  try {
    const url = await presignDownload(makeR2Client(c.env), c.env.R2_BUCKET, file.r2_key, 300, file.name)
    return c.redirect(url, 302)
  } catch { return c.text('Failed to generate download URL', 500) }
})

// ── Upload links (public client upload) ───────────────────────────────────────

app.post('/api/upload-links', authMiddleware, async c => {
  const { folder, label, days = 7 } = await c.req.json().catch(() => ({}))
  if (!folder) return c.json({ error: 'folder is required' }, 400)
  const token     = Array.from(crypto.getRandomValues(new Uint8Array(24))).map(b => b.toString(16).padStart(2,'0')).join('')
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString()
  await c.env.DB.prepare(`INSERT INTO upload_links (token,folder,label,expires_at) VALUES (?,?,?,?)`).bind(token, folder, label||folder, expiresAt).run()
  return c.json({ token, expiresAt })
})

app.get('/api/upload-links', authMiddleware, async c => {
  const links = await c.env.DB.prepare(`SELECT * FROM upload_links WHERE expires_at > datetime('now') ORDER BY created_at DESC`).all()
  return c.json(links.results)
})

app.delete('/api/upload-links/:id', authMiddleware, async c => {
  await c.env.DB.prepare(`DELETE FROM upload_links WHERE id=?`).bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

app.get('/upload/:token', async c => {
  const link = await c.env.DB.prepare(`SELECT 1 FROM upload_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.html('<h2>This upload link has expired or does not exist.</h2>', 404)
  return c.env.ASSETS.fetch(new Request('http://x/upload.html'))
})

app.get('/upload/:token/info', async c => {
  const link = await c.env.DB.prepare(`SELECT id,folder,label,expires_at FROM upload_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.json({ error: 'Link expired or not found' }, 404)
  return c.json(link)
})

app.post('/upload/:token/start', async c => {
  const link = await c.env.DB.prepare(`SELECT * FROM upload_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.json({ error: 'Link expired' }, 404)
  const { name, size } = await c.req.json().catch(() => ({}))
  if (!name) return c.json({ error: 'name required' }, 400)
  const id     = crypto.randomUUID()
  const dotIdx = name.lastIndexOf('.')
  const ext    = dotIdx > 0 ? name.slice(dotIdx) : ''
  const base   = (dotIdx > 0 ? name.slice(0, dotIdx) : name).replace(/[^a-zA-Z0-9._-]/g, '_') || 'file'
  const r2Key  = `${link.folder}/${Date.now()}-${base}${ext}`
  await c.env.DB.prepare(`INSERT INTO files (id,name,r2_key,size,folder,status,upload_progress,updated_at) VALUES (?,?,?,?,?,'uploading',0,datetime('now'))`).bind(id, name, r2Key, size||0, link.folder).run()
  try {
    const url = await presignUpload(makeR2Client(c.env), c.env.R2_BUCKET, r2Key, 3600)
    return c.json({ id, url, r2Key })
  } catch (e) {
    await c.env.DB.prepare(`UPDATE files SET status='deleted' WHERE id=?`).bind(id).run()
    return c.json({ error: e.message }, 500)
  }
})

app.post('/upload/:token/complete/:id', async c => {
  const link = await c.env.DB.prepare(`SELECT * FROM upload_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.json({ error: 'Link expired' }, 404)
  const file = await c.env.DB.prepare(`SELECT * FROM files WHERE id=?`).bind(c.req.param('id')).first()
  if (!file || file.folder !== link.folder) return c.json({ error: 'File not found' }, 404)
  const { size, checksum } = await c.req.json().catch(() => ({}))
  await c.env.DB.prepare(`UPDATE files SET status='available',upload_progress=100,uploaded_at=datetime('now'),updated_at=datetime('now'),size=COALESCE(?,size),checksum=COALESCE(?,checksum) WHERE id=?`).bind(size||null, checksum||null, c.req.param('id')).run()
  return c.json({ ok: true })
})

app.post('/upload/:token/fail/:id', async c => {
  const link = await c.env.DB.prepare(`SELECT 1 FROM upload_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.json({ error: 'Link expired' }, 404)
  await c.env.DB.prepare(`UPDATE files SET status='deleted',updated_at=datetime('now') WHERE id=?`).bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

app.post('/upload/:token/multipart/create', async c => {
  const link = await c.env.DB.prepare(`SELECT 1 FROM upload_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.json({ error: 'Link expired' }, 404)
  const { r2_key } = await c.req.json().catch(() => ({}))
  try { return c.json({ uploadId: await createMultipart(makeR2Client(c.env), c.env.R2_BUCKET, r2_key) }) }
  catch (e) { return c.json({ error: e.message }, 500) }
})

app.post('/upload/:token/multipart/part-url', async c => {
  const link = await c.env.DB.prepare(`SELECT 1 FROM upload_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.json({ error: 'Link expired' }, 404)
  const { r2_key, uploadId, partNumber } = await c.req.json().catch(() => ({}))
  try { return c.json({ url: await presignPart(makeR2Client(c.env), c.env.R2_BUCKET, r2_key, uploadId, partNumber) }) }
  catch (e) { return c.json({ error: e.message }, 500) }
})

app.post('/upload/:token/multipart/complete', async c => {
  const link = await c.env.DB.prepare(`SELECT 1 FROM upload_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.json({ error: 'Link expired' }, 404)
  const { r2_key, uploadId, parts } = await c.req.json().catch(() => ({}))
  try { await completeMultipart(makeR2Client(c.env), c.env.R2_BUCKET, r2_key, uploadId, parts); return c.json({ ok: true }) }
  catch (e) { return c.json({ error: e.message }, 500) }
})

app.post('/upload/:token/multipart/abort', async c => {
  const link = await c.env.DB.prepare(`SELECT 1 FROM upload_links WHERE token=? AND expires_at > datetime('now')`).bind(c.req.param('token')).first()
  if (!link) return c.json({ error: 'Link expired' }, 404)
  const { r2_key, uploadId } = await c.req.json().catch(() => ({}))
  try { await abortMultipart(makeR2Client(c.env), c.env.R2_BUCKET, r2_key, uploadId); return c.json({ ok: true }) }
  catch (e) { return c.json({ error: e.message }, 500) }
})

// ── File requests ─────────────────────────────────────────────────────────────

app.post('/api/requests', authMiddleware, async c => {
  const { message } = await c.req.json().catch(() => ({}))
  if (!message?.trim()) return c.json({ error: 'message required' }, 400)
  const user = c.get('user')
  await c.env.DB.prepare(`INSERT INTO file_requests (user_id,username,message) VALUES (?,?,?)`).bind(user.sub, user.username, message.trim()).run()
  return c.json({ ok: true })
})

app.get('/api/requests', authMiddleware, ownerMiddleware, async c => {
  const rows = await c.env.DB.prepare(`SELECT * FROM file_requests WHERE status='pending' ORDER BY created_at DESC`).all()
  return c.json(rows.results)
})

app.patch('/api/requests/:id/fulfil', authMiddleware, ownerMiddleware, async c => {
  await c.env.DB.prepare(`UPDATE file_requests SET status='fulfilled' WHERE id=?`).bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

app.delete('/api/requests/:id', authMiddleware, ownerMiddleware, async c => {
  await c.env.DB.prepare(`DELETE FROM file_requests WHERE id=?`).bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// ── FS (agent ↔ dashboard RPC via D1) ────────────────────────────────────────

app.post('/api/fs/browse', authMiddleware, ownerMiddleware, async c => {
  const { path } = await c.req.json().catch(() => ({}))
  const id = crypto.randomUUID()
  await c.env.DB.prepare(`INSERT INTO fs_commands (id,type,payload) VALUES (?,?,?)`).bind(id, 'browse', JSON.stringify({ path: path||'' })).run()
  return c.json({ commandId: id })
})

app.post('/api/fs/dirsize', authMiddleware, ownerMiddleware, async c => {
  const { paths } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(paths) || !paths.length) return c.json({ error: 'paths required' }, 400)
  const id = crypto.randomUUID()
  await c.env.DB.prepare(`INSERT INTO fs_commands (id,type,payload) VALUES (?,?,?)`).bind(id, 'dirsize', JSON.stringify({ paths })).run()
  return c.json({ commandId: id })
})

app.post('/api/fs/upload', authMiddleware, ownerMiddleware, async c => {
  const { paths, folder } = await c.req.json().catch(() => ({}))
  if (!Array.isArray(paths) || !paths.length) return c.json({ error: 'paths required' }, 400)
  const id = crypto.randomUUID()
  await c.env.DB.prepare(`INSERT INTO fs_commands (id,type,payload) VALUES (?,?,?)`).bind(id, 'upload', JSON.stringify({ paths, folder: folder||'' })).run()
  return c.json({ commandId: id })
})

app.get('/api/fs/result/:id', authMiddleware, ownerMiddleware, async c => {
  const cmd = await c.env.DB.prepare(`SELECT * FROM fs_commands WHERE id=?`).bind(c.req.param('id')).first()
  if (!cmd) return c.json({ error: 'Command not found or expired' }, 404)
  if (!cmd.done) return c.json({ done: false })
  return c.json({ done: true, result: cmd.result ? JSON.parse(cmd.result) : null, error: cmd.error })
})

app.get('/api/fs/pending', agentMiddleware, async c => {
  const rows = await c.env.DB.prepare(`SELECT * FROM fs_commands WHERE done=0 AND claimed=0 LIMIT 10`).all()
  if (rows.results.length) {
    const ids = rows.results.map(r => r.id)
    await c.env.DB.batch(ids.map(id => c.env.DB.prepare(`UPDATE fs_commands SET claimed=1 WHERE id=?`).bind(id)))
  }
  return c.json({ commands: rows.results.map(r => ({ id: r.id, type: r.type, payload: JSON.parse(r.payload) })) })
})

app.post('/api/fs/result/:id', agentMiddleware, async c => {
  const body = await c.req.json().catch(() => ({}))
  await c.env.DB.prepare(`UPDATE fs_commands SET done=1,result=?,error=? WHERE id=?`).bind(JSON.stringify(body.result ?? null), body.error ?? null, c.req.param('id')).run()
  return c.json({ ok: true })
})

app.get('/api/fs/agent-config', agentMiddleware, async c => {
  const [wd, bf] = await Promise.all([
    c.env.DB.prepare(`SELECT value FROM settings WHERE key='watch_dir'`).first(),
    c.env.DB.prepare(`SELECT value FROM settings WHERE key='base_folder'`).first(),
  ])
  return c.json({ watchDir: wd?.value ?? null, baseFolder: bf?.value ?? null })
})

app.get('/api/fs/watch-dir', authMiddleware, ownerMiddleware, async c => {
  const [wd, bf] = await Promise.all([
    c.env.DB.prepare(`SELECT value FROM settings WHERE key='watch_dir'`).first(),
    c.env.DB.prepare(`SELECT value FROM settings WHERE key='base_folder'`).first(),
  ])
  return c.json({ watchDir: wd?.value ?? null, baseFolder: bf?.value ?? null })
})

app.patch('/api/fs/agent-config', authMiddleware, ownerMiddleware, async c => {
  const { watchDir } = await c.req.json().catch(() => ({}))
  if (!watchDir?.trim()) return c.json({ error: 'watchDir required' }, 400)
  const dir        = watchDir.trim()
  const baseFolder = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES ('watch_dir',?)`).bind(dir),
    c.env.DB.prepare(`INSERT OR REPLACE INTO settings (key,value) VALUES ('base_folder',?)`).bind(baseFolder),
  ])
  return c.json({ ok: true, baseFolder })
})

// ── Cron: cleanup ─────────────────────────────────────────────────────────────

async function runCleanup(env) {
  const db = env.DB
  const r2 = makeR2Client(env)

  await db.prepare(`DELETE FROM revoked_tokens WHERE expires_at < datetime('now')`).run()
  await db.prepare(`DELETE FROM fs_commands WHERE created_at < datetime('now','-5 minutes')`).run()
  await db.prepare(`UPDATE files SET status='deleted',deleted_at=datetime('now'),updated_at=datetime('now') WHERE status='uploading' AND last_seen_at < datetime('now','-30 minutes')`).run()

  const toDelete = await db.prepare(`SELECT id,r2_key FROM files WHERE delete_at IS NOT NULL AND delete_at <= datetime('now') AND status='available'`).all()
  for (const f of toDelete.results) {
    try { await deleteObject(r2, env.R2_BUCKET, f.r2_key) } catch {}
    await db.prepare(`UPDATE files SET status='deleted',deleted_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).bind(f.id).run()
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,
  async scheduled(_event, env, _ctx) {
    await runCleanup(env)
  },
}
