import bcrypt from 'bcryptjs'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

export const JWT_EXPIRY_SECONDS = 7 * 24 * 3600

function b64url(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let str = ''
  for (const b of bytes) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function b64urlDecode(str) {
  return Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
}

async function importKey(secret) {
  return crypto.subtle.importKey('raw', ENC.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function signJwt(payload, secret) {
  const header = b64url(ENC.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const body   = b64url(ENC.encode(JSON.stringify({ ...payload, jti: crypto.randomUUID() })))
  const key    = await importKey(secret)
  const sig    = b64url(await crypto.subtle.sign('HMAC', key, ENC.encode(`${header}.${body}`)))
  return `${header}.${body}.${sig}`
}

export async function verifyJwt(token, secret) {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid token')
  const key   = await importKey(secret)
  const valid = await crypto.subtle.verify('HMAC', key, b64urlDecode(parts[2]), ENC.encode(`${parts[0]}.${parts[1]}`))
  if (!valid) throw new Error('Invalid signature')
  const payload = JSON.parse(DEC.decode(b64urlDecode(parts[1])))
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired')
  return payload
}

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 12)
}

export async function checkPassword(plain, hash) {
  return bcrypt.compare(plain, hash)
}

// Hono middleware — verifies JWT from Authorization: Bearer header
export const authMiddleware = async (c, next) => {
  const header = c.req.header('authorization') || ''
  if (!header.startsWith('Bearer ')) return c.json({ error: 'Missing token' }, 401)
  try {
    const user = await verifyJwt(header.slice(7), c.env.JWT_SECRET)
    if (user.jti) {
      const revoked = await c.env.DB.prepare(`SELECT 1 FROM revoked_tokens WHERE jti=?`).bind(user.jti).first()
      if (revoked) return c.json({ error: 'Token revoked' }, 401)
    }
    c.set('user', user)
    await next()
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401)
  }
}

// Hono middleware — verifies Authorization: Agent <token>
export const agentMiddleware = async (c, next) => {
  const header = c.req.header('authorization') || ''
  if (!header.startsWith('Agent ')) return c.json({ error: 'Missing agent token' }, 401)
  const row = await c.env.DB.prepare(`SELECT id FROM agent_tokens WHERE token=?`).bind(header.slice(6)).first()
  if (!row) return c.json({ error: 'Invalid agent token' }, 401)
  c.set('agentId', row.id)
  await next()
}

// Hono middleware — requires owner role (must run after authMiddleware)
export const ownerMiddleware = async (c, next) => {
  if (c.get('user')?.role !== 'owner') return c.json({ error: 'Owner required' }, 403)
  await next()
}
