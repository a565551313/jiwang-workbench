import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  plugins: [vue(), Components({ dts: 'src/components.d.ts', resolvers: [ElementPlusResolver()] })],
  server: { host: '0.0.0.0', allowedHosts: ['4173-it3xp7zqh3nv3o4it6efg-e90a42d4.us2.manus.computer'] },
  build: { chunkSizeWarningLimit: 600 },
})
