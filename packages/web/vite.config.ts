import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const target = 'http://localhost:3000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    // changeOrigin stays false so Host (and cookie/device-login URLs) remain the dev origin.
    proxy: {
      '/api': { target, changeOrigin: false },
      '^/p/': { target, changeOrigin: false },
      '/healthz': { target, changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
