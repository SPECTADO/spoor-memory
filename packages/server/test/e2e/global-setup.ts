/**
 * E2E-project global setup: a fresh database of its own (`<test db>_e2e_test`, e.g. `spoor_e2e_test`) on the
 * same server as the integration tests, so the e2e run never races their per-test TRUNCATE. It is dropped and
 * created here; the server under test then runs the real startup migrations on it (clean-machine path).
 * Also fails fast when the CLI has not been built (the e2e test drives `packages/cli/dist/bin.js`).
 */
import { existsSync } from 'node:fs'
import pg from 'pg'
import type { TestProject } from 'vitest/node'
import { assertTestDatabase, redactUrl, testDatabaseUrl } from '../db-url.js'
import { CLI_BIN, e2eDatabaseUrl } from './paths.js'

export default async function setup(project: TestProject): Promise<void> {
  if (!existsSync(CLI_BIN)) {
    throw new Error(
      `\n\nThe e2e test drives the built CLI, but ${CLI_BIN} does not exist.\n` +
        'Run `pnpm build` (or `pnpm --filter @spoor/shared --filter spoor-memory build`) first.\n',
    )
  }
  const base = testDatabaseUrl()
  assertTestDatabase(base)
  const url = e2eDatabaseUrl(base)
  assertTestDatabase(url)
  const name = decodeURIComponent(new URL(url).pathname.slice(1))
  const client = new pg.Client({ connectionString: base, connectionTimeoutMillis: 3000 })
  try {
    await client.connect()
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code || (err as Error).message || String(err)
    throw new Error(
      `\n\nTest database not reachable at ${redactUrl(base)} (${reason}).\n` +
        'Start it with `pnpm test:db:up` (docker, pgvector, port 55432) or set DATABASE_URL to a pgvector Postgres.\n',
    )
  }
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await client.query(`CREATE DATABASE "${name}"`)
  } finally {
    await client.end().catch(() => {})
  }
  project.provide('e2eDatabaseUrl', url)
}

declare module 'vitest' {
  export interface ProvidedContext {
    e2eDatabaseUrl: string
  }
}
