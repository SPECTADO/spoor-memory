import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.js'

export type Db = ReturnType<typeof createDb>['db']

/** Every connection the app opens carries `application_name = 'spoor:<host>:<pid>:<instance>'` (ADR-0039). */
export const APPLICATION_NAME_PREFIX = 'spoor:'

/**
 * Random per process: two containers whose (cut) host names match and whose pid is 1 still differ, so the
 * `other_instances` check cannot mistake another process for this one.
 */
const PROCESS_INSTANCE = randomBytes(4).toString('hex')

/**
 * This process's `application_name`. A full restore refuses to run while `pg_stat_activity` shows another
 * one with the prefix (409 `other_instances`). Postgres keeps 63 bytes; the pid and the random instance part
 * are kept, the host is cut.
 */
export function appApplicationName(
  host = hostname(),
  pid = process.pid,
  instance = PROCESS_INSTANCE,
): string {
  const tail = `:${pid}:${instance}`
  const head = `${APPLICATION_NAME_PREFIX}${host}`.slice(0, 63 - tail.length)
  return `${head}${tail}`
}

/** Runtime pool (the `spoor_app` role). `casing` must match drizzle.config.ts. */
export function createDb(connectionString: string, max: number, opts: { applicationName?: string } = {}) {
  const pool = new pg.Pool({
    connectionString,
    max,
    // a connect that cannot finish (DB down or blackholed) fails after 5 s instead of hanging the caller
    connectionTimeoutMillis: 5000,
    // one connection is never reaped as idle: it keeps this process visible in pg_stat_activity, which is how
    // a full restore on another instance sees it (409 `other_instances`, ADR-0039)
    min: Math.min(1, max),
    application_name: opts.applicationName ?? appApplicationName(),
  })
  // An idle client erroring (server restart) must not crash the process; the next query reconnects.
  pool.on('error', () => {})
  const db = drizzle(pool, { schema, casing: 'snake_case' })
  return { pool, db }
}
