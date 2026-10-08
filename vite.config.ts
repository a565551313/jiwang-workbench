import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { handleAdminAuth } from './server/adminAuth'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

function sameOriginAdminApp(): Plugin {
  function install(middlewares: { use: (handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: (error?: unknown) => void) => void) => void }) {
    middlewares.use((req, res, next) => {
      const requestUrl = new URL(req.url || '/', 'http://localhost')
      const pathname = requestUrl.pathname
      const match = pathname.match(/^\/api\/admin\/(session|login|logout)$/)
      if (match) {
        void handleAdminAuth(req as import('node:http').IncomingMessage & { body?: unknown }, res, match[1]!).catch((error: unknown) => {
          console.error('Admin authentication endpoint failed:', error)
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify({ message: '管理服务暂时不可用。' }))
          }
        })
        return
      }
      if (pathname === '/admin' || pathname.startsWith('/admin/')) {
        req.url = `/admin-ui/index.html${requestUrl.search}`
      }
      next()
    })
  }

  return {
    name: 'jiwang-same-origin-admin-app',
    config() {
      const localEnv = { ...loadEnv('development', projectRoot, ''), ...loadEnv('admin', projectRoot, '') }
      for (const key of ['JIWANG_ADMIN_USERNAME', 'JIWANG_ADMIN_PASSWORD', 'JIWANG_ADMIN_SESSION_SECRET']) {
        if (!process.env[key] && localEnv[key]) process.env[key] = localEnv[key]
      }
    },
    configureServer(server) { install(server.middlewares) },
    configurePreviewServer(server) { install(server.middlewares) },
  }
}

export default defineConfig({
  plugins: [
    sameOriginAdminApp(),
    vue(),
    Components({ dts: 'src/components.d.ts', resolvers: [ElementPlusResolver()] }),
  ],
  server: {
    host: '0.0.0.0',
    allowedHosts: ['4173-it3xp7zqh3nv3o4it6efg-e90a42d4.us2.manus.computer'],
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: {
        main: resolve(projectRoot, 'index.html'),
        admin: resolve(projectRoot, 'admin-ui/index.html'),
      },
    },
  },
})
