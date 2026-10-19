/**
 * Shared settings of the Playwright run: the port of the server under test, its databases and the
 * bootstrap admin. The port is chosen once, in the runner process that loads playwright.config.ts; the
 * workers inherit `SPOOR_E2E_PORT` from it, so every process agrees on the same URL.
 */

const DEFAULT_TEST_DATABASE_URL = 'postgres://spoor:spoor@localhost:55432/spoor_test'

// a random high port per run; set SPOOR_E2E_PORT to pin it
process.env.SPOOR_E2E_PORT ??= String(20_000 + Math.floor(Math.random() * 30_000))

export const PORT = Number(process.env.SPOOR_E2E_PORT)
export const BASE_URL = `http://127.0.0.1:${PORT}`

/** The database server of `pnpm test:db:up` (or DATABASE_URL, as in CI); used to create the e2e database. */
export const TEST_DATABASE_URL = process.env.DATABASE_URL || DEFAULT_TEST_DATABASE_URL

/** `…/spoor_test` → `…/spoor_web_e2e_test`: a database of its own, dropped and created on every run. */
export const E2E_DATABASE_URL = (() => {
  const u = new URL(TEST_DATABASE_URL)
  const name = decodeURIComponent(u.pathname.slice(1)).replace(/_test$/, '')
  u.pathname = `/${name}_web_e2e_test`
  return u.toString()
})()

export const ADMIN = { email: 'admin@example.com', password: 'admin-password-e2e', name: 'Admin' }
