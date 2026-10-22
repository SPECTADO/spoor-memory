import { readFileSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const target = 'http://localhost:3000'
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // the web build's own version, shown next to the server's in the sidebar footer (lib/version.ts)
  define: { __WEB_VERSION__: JSON.stringify(pkg.version) },
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
