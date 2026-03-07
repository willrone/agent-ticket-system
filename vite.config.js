import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function getProxyTarget() {
  const fromTarget = (process.env.VITE_PROXY_TARGET || '').trim()
  if (fromTarget) return fromTarget
  const baseUrl = (process.env.VITE_API_BASE_URL || '').trim()
  if (baseUrl) {
    try {
      return new URL(baseUrl).origin
    } catch { /* ignore */ }
  }
  return 'http://127.0.0.1:8788'
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: getProxyTarget(),
        changeOrigin: true,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
  },
})
