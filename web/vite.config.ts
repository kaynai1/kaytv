import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'
import pkg from './package.json' with { type: 'json' }

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const singleFile = env?.VITE_SINGLE_FILE === '1'

export default defineConfig({
  base: singleFile ? './' : env?.VITE_BASE || '/',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [vue(), ...(singleFile ? [viteSingleFile()] : [])],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: env?.VITE_API_TARGET || 'http://127.0.0.1:8080',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: env?.VITE_OUT_DIR || 'dist',
    emptyOutDir: true,
    target: 'es2020',
    chunkSizeWarningLimit: 900
  }
})
