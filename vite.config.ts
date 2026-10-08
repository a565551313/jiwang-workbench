import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

function hideLocalAdminFromPublicDevServer(): Plugin {
  return {
    name: 'jiwang-public-site-hide-local-admin',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url || '/', 'http://localhost').pathname
        if (pathname === '/admin' || pathname.startsWith('/admin/') || pathname === '/admin-ui' || pathname.startsWith('/admin-ui/')) {
          res.statusCode = 404
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end('Not found')
          return
        }
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [
    hideLocalAdminFromPublicDevServer(),
    vue(),
    Components({ dts: 'src/components.d.ts', resolvers: [ElementPlusResolver()] }),
  ],
  server: {
    host: '0.0.0.0',
    allowedHosts: ['4173-it3xp7zqh3nv3o4it6efg-e90a42d4.us2.manus.computer'],
    fs: {
      deny: [
        '**/.env', '**/.env.*', '**/*.crt', '**/*.pem', '**/.git/**',
        '**/admin-ui/**', '**/vite.admin.config.ts', '**/.admin-dist/**',
        '**/src/pages/AdminView.vue', '**/src/styles/admin.css', '**/src/lib/admin.ts',
      ],
    },
  },
  build: { chunkSizeWarningLimit: 600 },
})
