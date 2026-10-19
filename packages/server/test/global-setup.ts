/**
 * Integration-project global setup: fail fast with a clear message when the test database is down, then
 * run the real startup migrations once (the same code path as the server) and hand the definition of the
 * default model's HNSW index they create to test/setup.ts, which restores it before every test.
 */
import pg from 'pg'
import type { TestProject } from 'vitest/node'
import { runMigrations } from '../src/db/migrate.js'
import { assertTestDatabase, redactUrl, testDatabaseUrl } from './db-url.js'
import { DEFAULT_HNSW_INDEX, listHnswIndexes } from './hnsw.js'

export default async function setup(project: TestProject): Promise<void> {
  const url = testDatabaseUrl()
  assertTestDatabase(url)
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 })
  try {
    await client.connect()
    await client.query('SELECT 1')
  } catch (err) {
    // ECONNREFUSED arrives as an AggregateError with an empty message
    const reason = (err as NodeJS.ErrnoException).code || (err as Error).message || String(err)
    throw new Error(
      `\n\nTest database not reachable at ${redactUrl(url)} (${reason}).\n` +
        'Start it with `pnpm test:db:up` (docker, pgvector, port 55432) or set DATABASE_URL to a pgvector Postgres.\n' +
        'Unit tests alone run without a database: `pnpm --filter @spoor/server test:unit`.\n',
    )
  } finally {
    await client.end().catch(() => {})
  }
  await runMigrations({ databaseUrl: url, migrateUrl: process.env.DATABASE_MIGRATE_URL ?? url })
  const snap = new pg.Client({ connectionString: url })
  await snap.connect()
  try {
    const def = (await listHnswIndexes(snap)).find((i) => i.name === DEFAULT_HNSW_INDEX)?.def ?? null
    project.provide('defaultHnswIndexDef', def)
  } finally {
    await snap.end().catch(() => {})
  }
}
