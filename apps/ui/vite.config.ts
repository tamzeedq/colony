import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// The control plane (docs/phase2.md). The proxy forwards /api (HTTP + WebSocket) AS-IS so the UI
// is same-origin. It must never add the admin token: agent containers can reach host ports, so
// anything on the host that injects the token would hand it to them. The browser holds it.
const CONTROL_PLANE = process.env.COLONY_CONTROL_PLANE_URL ?? 'http://127.0.0.1:7700'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    proxy: {
      '/api': { target: CONTROL_PLANE, ws: true, changeOrigin: false },
    },
  },
  preview: {
    proxy: {
      '/api': { target: CONTROL_PLANE, ws: true, changeOrigin: false },
    },
  },
})
