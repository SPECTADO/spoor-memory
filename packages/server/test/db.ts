/** The integration tests' database handle (one small pool per test file). */
import { inject } from 'vitest'
import { createDb } from '../src/db/client.js'
import type { Db } from '../src/lib/db.js'
import { testDatabaseUrl } from './db-url.js'
import { DEFAULT_HNSW_INDEX, listHnswIndexes } from './hnsw.js'

let handle: ReturnType<typeof createDb> | undefined
let tables: string[] | undefined

function get() {
  handle ??= createDb(testDatabaseUrl(), 5)
  return handle
}

export function testDb(): Db {
  return get().db
}

export function testPool() {
  return get().pool
}

/** Every table of the public schema (the drizzle migration journal lives in schema `drizzle`). */
export async function truncateAll(): Promise<void> {
  const pool = get().pool
  tables ??= (
    await pool.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
  ).rows.map((r) => `"public"."${r.tablename}"`)
  if (tables.length) await pool.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`)
}

/**
 * Put the HNSW indexes on `chunks` back to what the migrations create: the default model's partial index of
 * 0002_triggers_and_hnsw.sql only. The re-embed job creates an index per target tag and drops the ones no
 * project uses (the default's too); TRUNCATE does not touch indexes, so without this a test that re-embeds
 * leaks schema state into every later file. Every other `chunks_hnsw_*` index is dropped; a missing default
 * is recreated from the definition test/global-setup.ts read right after the migrations (none if the
 * migrations did not create it, so migrate.integration.test.ts still sees their real output). Runs after
 * truncateAll, so a recreated index builds on an empty table.
 */
export async function resetHnswIndexes(): Promise<void> {
  const pool = get().pool
  const def = inject('defaultHnswIndexDef')
  let haveDefault = false
  for (const h of await listHnswIndexes(pool)) {
    if (h.name === DEFAULT_HNSW_INDEX) haveDefault = true
    else await pool.query(`DROP INDEX IF EXISTS "public"."${h.name}"`)
  }
  if (!haveDefault && def) await pool.query(def)
}

export async function closeTestDb(): Promise<void> {
  await handle?.pool.end()
  handle = undefined
  tables = undefined
}
