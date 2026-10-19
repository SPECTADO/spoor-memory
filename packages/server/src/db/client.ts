import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema.js'

export type Db = ReturnType<typeof createDb>['db']

/** Runtime pool (the `spoor_app` role). `casing` must match drizzle.config.ts. */
export function createDb(connectionString: string, max: number) {
  // a connect that cannot finish (DB down or blackholed) fails after 5 s instead of hanging the caller
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 5000 })
  // An idle client erroring (server restart) must not crash the process; the next query reconnects.
  pool.on('error', () => {})
  const db = drizzle(pool, { schema, casing: 'snake_case' })
  return { pool, db }
}
