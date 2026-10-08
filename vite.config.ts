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
      // 本地开发支持 .env.local 与 .env.admin.local；Vercel 必须只使用 Project Environment Variables。
      if (process.env.VERCEL) return
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
  // Vercel 的 VITE_* 值来自构建环境；不要让本地 .env 文件成为线上构建的后备来源。
  envDir: process.env.VERCEL ? false : projectRoot,
  plugins: [
    sameOriginAdminApp(),
    vue(),
    Components({ dts: 'src/components.d.ts', resolvers: [ElementPlusResolver()] }),
  ],
  server: {
    host: '0.0.0.0',
    // Vite 默认只放行 localhost。沙箱预览使用 *.e2b.app 域名；其它部署域名可用 JIWANG_DEV_ALLOWED_HOSTS（逗号分隔）追加。
    allowedHosts: ['.e2b.app', ...(process.env.JIWANG_DEV_ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean)],
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
