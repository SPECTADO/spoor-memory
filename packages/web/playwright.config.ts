import { resolve } from 'node:path'
import { defineConfig, devices } from '@playwright/test'
import { ADMIN, BASE_URL, E2E_DATABASE_URL, PORT, TEST_DATABASE_URL } from './e2e/support/env'

/**
 * Every spec runs against the BUILT server (packages/server/dist) serving the BUILT SPA (packages/web/dist)
 * on a random port, started by e2e/support/server.mjs on a fresh database of its own with the fake
 * embedding model. `pnpm e2e` at the repo root builds first; the test database must be up (`pnpm test:db:up`).
 * fullstack.spec.ts walks the real stack; the other specs mock `/api/v1` in the page.
 */
export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'node e2e/support/server.mjs',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      DATABASE_URL: E2E_DATABASE_URL,
      SPOOR_E2E_ADMIN_DATABASE_URL: TEST_DATABASE_URL,
      SPOOR_PORT: String(PORT),
      SPOOR_HOST: '127.0.0.1',
      SPOOR_PUBLIC_URL: BASE_URL,
      SPOOR_WEB_DIR: resolve(import.meta.dirname, 'dist'),
      SPOOR_ADMIN_EMAIL: ADMIN.email,
      SPOOR_ADMIN_PASSWORD: ADMIN.password,
      SPOOR_ADMIN_NAME: ADMIN.name,
      SPOOR_JOBS: 'on',
      SPOOR_EMBEDDING_DEFAULT: 'local',
      SPOOR_OPENAI_API_KEY: '',
      SPOOR_VOYAGE_API_KEY: '',
      SPOOR_TRUST_PROXY: '',
    },
  },
})
