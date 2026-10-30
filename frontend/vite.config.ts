import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // REST：走同源代理，refresh token 的 httpOnly cookie 才能正常带上
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // 协同 WebSocket。必须开 ws: true，否则握手会被当成普通 HTTP 转发
      '/collab': {
        target: 'ws://localhost:3000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: './dist',
  },
})
