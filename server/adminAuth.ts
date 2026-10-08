import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

type AuthRequest = IncomingMessage & { body?: unknown }
type SessionPayload = { username: string; expiresAt: number; nonce: string }
type LoginAttempt = { failures: number; windowStartedAt: number; blockedUntil: number }

const cookieName = 'jiwang_admin_session'
const sessionSeconds = 12 * 60 * 60
const rateWindowMs = 15 * 60 * 1000
const maxFailures = 5
const attempts = new Map<string, LoginAttempt>()

function readCookie(req: IncomingMessage, name: string) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim()
  }
  return ''
}

function safeEqual(actual: string, expected: string) {
  const actualHash = createHash('sha256').update(actual).digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  return timingSafeEqual(actualHash, expectedHash) && actual.length === expected.length
}

function configuredCredentials() {
  const username = process.env.JIWANG_ADMIN_USERNAME?.trim() || ''
  const password = process.env.JIWANG_ADMIN_PASSWORD || ''
  const secret = process.env.JIWANG_ADMIN_SESSION_SECRET || ''
  if (!username || username.length > 120 || password.length < 12 || password.length > 4096 || secret.length < 32) return null
  return { username, password, secret }
}

function requestOrigin(req: IncomingMessage) {
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || ''
  const protocolHeader = req.headers['x-forwarded-proto'] || ((req.socket as import('node:tls').TLSSocket).encrypted ? 'https' : 'http')
  const host = String(hostHeader).split(',').at(-1)?.trim().toLowerCase() || ''
  const protocol = String(protocolHeader).split(',')[0]?.trim().toLowerCase() || ''
  if (!host || !['http', 'https'].includes(protocol)) return ''
  return `${protocol}://${host}`
}

function isSameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin
  return typeof origin === 'string' && origin === requestOrigin(req)
}

function clientAddress(req: IncomingMessage) {
  const realIp = req.headers['x-real-ip']
  if (typeof realIp === 'string' && realIp.length < 128) return realIp
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') return forwarded.split(',').at(-1)?.trim().slice(0, 128) || 'unknown'
  return req.socket.remoteAddress || 'unknown'
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: AuthRequest): Promise<unknown> {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return JSON.parse(req.body)
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8'))
    return req.body
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 4096) throw new Error('Request body is too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sign(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

function serializeSession(username: string, secret: string) {
  const payload = Buffer.from(JSON.stringify({
    username,
    expiresAt: Date.now() + sessionSeconds * 1000,
    nonce: randomBytes(16).toString('base64url'),
  } satisfies SessionPayload)).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

function currentSession(req: IncomingMessage, secret: string) {
  const token = readCookie(req, cookieName)
  const separator = token.lastIndexOf('.')
  if (separator < 1) return null
  const payload = token.slice(0, separator)
  const suppliedSignature = token.slice(separator + 1)
  const expectedSignature = sign(payload, secret)
  if (!safeEqual(suppliedSignature, expectedSignature)) return null
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<SessionPayload>
    if (typeof decoded.username !== 'string' || typeof decoded.expiresAt !== 'number' || decoded.expiresAt <= Date.now() || typeof decoded.nonce !== 'string') return null
    return { username: decoded.username, expiresAt: decoded.expiresAt }
  } catch {
    return null
  }
}

function cookieHeader(req: IncomingMessage, token: string, maxAge: number) {
  const secure = requestOrigin(req).startsWith('https://') ? '; Secure' : ''
  return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
}

export async function handleAdminAuth(req: AuthRequest, res: ServerResponse, action: string) {
  if (!['session', 'login', 'logout'].includes(action)) return sendJson(res, 404, { message: 'Not found' })

  if (action === 'session' && req.method === 'GET') {
    const credentials = configuredCredentials()
    if (!credentials) return sendJson(res, 503, { message: '管理员登录尚未配置，请在部署环境设置管理员账号、密码和会话密钥。' })
    const session = currentSession(req, credentials.secret)
    return sendJson(res, 200, { authenticated: Boolean(session), username: session?.username })
  }

  if ((action === 'login' || action === 'logout') && req.method !== 'POST') {
    res.setHeader('Allow', action === 'login' ? 'POST' : 'POST')
    return sendJson(res, 405, { message: 'Method not allowed' })
  }
  if ((action === 'login' || action === 'logout') && !isSameOrigin(req)) return sendJson(res, 403, { message: '请求来源无效。' })

  if (action === 'logout') {
    return sendJson(res, 200, { authenticated: false }, { 'Set-Cookie': cookieHeader(req, '', 0) })
  }

  const credentials = configuredCredentials()
  if (!credentials) return sendJson(res, 503, { message: '管理员登录尚未配置，请在部署环境设置管理员账号、密码和会话密钥。' })
  const contentType = req.headers['content-type'] || ''
  if (!contentType.includes('application/json')) return sendJson(res, 415, { message: '请求格式无效。' })
  const contentLength = Number(req.headers['content-length'] || 0)
  if (contentLength > 4096) return sendJson(res, 413, { message: '登录请求过大。' })

  const address = clientAddress(req)
  const now = Date.now()
  for (const [key, attempt] of attempts) {
    if (now - attempt.windowStartedAt >= rateWindowMs && attempt.blockedUntil <= now) attempts.delete(key)
  }
  let attempt = attempts.get(address)
  if (!attempt || now - attempt.windowStartedAt >= rateWindowMs) {
    attempt = { failures: 0, windowStartedAt: now, blockedUntil: 0 }
    attempts.set(address, attempt)
  }
  if (attempt.blockedUntil > now) {
    return sendJson(res, 429, { message: '尝试次数过多，请稍后再试。' }, { 'Retry-After': String(Math.ceil((attempt.blockedUntil - now) / 1000)) })
  }

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch {
    return sendJson(res, 400, { message: '登录请求无效。' })
  }
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const username = typeof input.username === 'string' ? input.username.trim() : ''
  const password = typeof input.password === 'string' ? input.password : ''
  const valid = safeEqual(username, credentials.username) && safeEqual(password, credentials.password)
  if (!valid) {
    attempt.failures += 1
    if (attempt.failures >= maxFailures) attempt.blockedUntil = now + rateWindowMs
    return sendJson(res, 401, { message: '账号或密码错误。' })
  }

  attempts.delete(address)
  return sendJson(res, 200, { authenticated: true }, {
    'Set-Cookie': cookieHeader(req, serializeSession(credentials.username, credentials.secret), sessionSeconds),
  })
}
