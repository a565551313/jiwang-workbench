import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))
const adminRoot = resolve(projectRoot, 'admin-ui')
const env = loadEnv('admin', projectRoot, '')
const port = Number(env.JIWANG_ADMIN_PORT || '4175')
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('JIWANG_ADMIN_PORT 必须是 1024 至 65535 之间的整数。')
}
const host = '127.0.0.1'
const origin = `http://${host}:${port}`
const sessionCookie = 'jiwang_admin_session'
const sessionDurationMs = 12 * 60 * 60 * 1000
const sessionDurationSeconds = Math.floor(sessionDurationMs / 1000)
const loginWindowMs = 15 * 60 * 1000
const maxLoginFailures = 5

type LocalSession = { username: string; expiresAt: number }
type LoginAttempt = { failures: number; windowStartedAt: number; blockedUntil: number }

function safeEqual(actual: string, expected: string) {
  const actualHash = createHash('sha256').update(actual).digest()
  const expectedHash = createHash('sha256').update(expected).digest()
  return timingSafeEqual(actualHash, expectedHash) && actual.length === expected.length
}

function json(res: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > 4096) throw new Error('request too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function requestCookie(req: IncomingMessage, name: string) {
  for (const pair of (req.headers.cookie || '').split(';')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    if (pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim()
  }
  return ''
}

function protectedLocalAdmin(username: string, password: string): Plugin {
  const sessions = new Map<string, LocalSession>()
  const attempts = new Map<string, LoginAttempt>()

  function currentSession(req: IncomingMessage) {
    const token = requestCookie(req, sessionCookie)
    const session = token ? sessions.get(token) : undefined
    if (session && session.expiresAt <= Date.now()) sessions.delete(token)
    return session && session.expiresAt > Date.now() ? session : undefined
  }

  return {
    name: 'jiwang-local-admin-auth',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const requestUrl = new URL(req.url || '/', origin)
        const pathname = requestUrl.pathname
        const privateAdminModules = ['/src/pages/AdminView.vue', '/src/lib/admin.ts', '/src/styles/admin.css']
        const requiresSession = privateAdminModules.some((modulePath) => pathname.endsWith(modulePath))
        if (!pathname.startsWith('/__admin/')) {
          if (requiresSession && !currentSession(req)) return json(res, 401, { message: '请先登录本机管理端。' })
          return next()
        }

        if (req.headers.host !== `${host}:${port}`) return json(res, 403, { message: `仅允许通过 ${origin} 访问本机管理端。` })
        if ((req.method === 'POST') && req.headers.origin !== origin) {
          return json(res, 403, { message: '请求来源无效。' })
        }

        if (pathname === '/__admin/session' && req.method === 'GET') {
          const session = currentSession(req)
          return json(res, 200, { authenticated: Boolean(session), username: session?.username })
        }

        if (pathname === '/__admin/logout' && req.method === 'POST') {
          const token = requestCookie(req, sessionCookie)
          if (token) sessions.delete(token)
          return json(res, 200, { authenticated: false }, {
            'Set-Cookie': `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
          })
        }

        if (pathname !== '/__admin/login' || req.method !== 'POST') {
          return json(res, 404, { message: 'Not found' })
        }

        void (async () => {
          const remoteAddress = req.socket.remoteAddress || 'unknown'
          const now = Date.now()
          let attempt = attempts.get(remoteAddress)
          if (!attempt || now - attempt.windowStartedAt >= loginWindowMs) {
            attempt = { failures: 0, windowStartedAt: now, blockedUntil: 0 }
            attempts.set(remoteAddress, attempt)
          }
          if (attempt.blockedUntil > now) {
            return json(res, 429, { message: '尝试次数过多，请稍后再试。' }, { 'Retry-After': String(Math.ceil((attempt.blockedUntil - now) / 1000)) })
          }

          const contentType = req.headers['content-type'] || ''
          if (!contentType.includes('application/json')) return json(res, 415, { message: '请求格式无效。' })
          let payload: unknown
          try {
            payload = await readJson(req)
          } catch {
            return json(res, 400, { message: '登录请求无效。' })
          }
          const credentials = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
          const suppliedUsername = typeof credentials.username === 'string' ? credentials.username : ''
          const suppliedPassword = typeof credentials.password === 'string' ? credentials.password : ''
          const valid = safeEqual(suppliedUsername, username) && safeEqual(suppliedPassword, password)
          if (!valid) {
            attempt.failures += 1
            if (attempt.failures >= maxLoginFailures) attempt.blockedUntil = now + loginWindowMs
            return json(res, 401, { message: '账号或密码错误。' })
          }

          attempts.delete(remoteAddress)
          const token = randomBytes(32).toString('base64url')
          for (const [existingToken, session] of sessions) {
            if (session.expiresAt <= now) sessions.delete(existingToken)
          }
          while (sessions.size >= 32) sessions.delete(sessions.keys().next().value as string)
          sessions.set(token, { username, expiresAt: now + sessionDurationMs })
          return json(res, 200, { authenticated: true }, {
            'Set-Cookie': `${sessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionDurationSeconds}`,
          })
        })().catch(() => json(res, 400, { message: '登录请求无效。' }))
      })
    },
  }
}

const adminUsername = env.JIWANG_ADMIN_USERNAME?.trim() || ''
const adminPassword = env.JIWANG_ADMIN_PASSWORD || ''
if (!adminUsername || adminPassword.length < 12 || adminPassword === 'replace-with-a-random-password-at-least-12-characters-long') {
  throw new Error('本机管理端未配置账号密码。请复制 .env.admin.example 为 .env.admin.local，并设置 JIWANG_ADMIN_USERNAME 与至少 12 位的 JIWANG_ADMIN_PASSWORD。')
}

export default defineConfig({
  root: adminRoot,
  envDir: projectRoot,
  plugins: [
    protectedLocalAdmin(adminUsername, adminPassword),
    vue(),
    Components({ dts: false, resolvers: [ElementPlusResolver()] }),
  ],
  server: {
    host,
    port,
    strictPort: true,
    allowedHosts: [host],
    cors: false,
    fs: { allow: [projectRoot] },
  },
  build: {
    outDir: resolve(projectRoot, '.admin-dist'),
    emptyOutDir: true,
  },
})
