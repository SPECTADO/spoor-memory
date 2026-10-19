/**
 * Database access shared by every module: the drizzle handle types, transactions, the purge bypass and
 * Postgres error helpers. The pool itself is created once in src/db/client.ts.
 */
import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../db/schema.js'

export type Db = NodePgDatabase<typeof schema>
/** The handle a `db.transaction` callback receives. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** Services take this so they run inside a caller's transaction or on their own. */
export type DbOrTx = Db | Tx

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable'

/**
 * Run `fn` in one transaction. Throwing (an ApiError included) rolls everything back, which is how a
 * check inside the transaction (e.g. `already_exists` after the invite gate) undoes earlier writes.
 */
export function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>, isolationLevel?: IsolationLevel): Promise<T> {
  return db.transaction(fn, isolationLevel ? { isolationLevel } : undefined)
}

/**
 * Allow DELETE on the append-only tables (item_revisions, audit_log) for the rest of THIS transaction only
 * (`SET LOCAL`, see spoor_append_only in 0000_extensions.sql). Only the human hard-delete and project-delete
 * transactions call this; UPDATE stays forbidden regardless.
 */
export async function allowPurge(tx: Tx): Promise<void> {
  await tx.execute(sql`SET LOCAL spoor.allow_purge = 'on'`)
}

/**
 * The lock order of every transaction that writes item content (phase-2 review D2): the project row first,
 * then item and edge rows. A create takes it through `allocate` (its first statement, `UPDATE projects`,
 * FOR NO KEY UPDATE); every other content write (update, supersede of an existing item, restore with
 * promotion, delete, push update, chunk rebuilds) calls this before it locks any item. FOR SHARE is the
 * mode `indexItemChunks` takes later in the same transaction anyway, so the transaction never upgrades.
 * A transaction that will allocate a number must not call this first (it would upgrade SHARE → NO KEY
 * UPDATE, and two such transactions deadlock).
 */
export async function lockProjectForWrite(tx: Tx, projectId: string): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM projects WHERE id = ${projectId} FOR SHARE`)
}

/** Postgres error fields, found on the error itself or on its `cause` (drizzle wraps driver errors). */
export interface PgErrorInfo {
  code: string
  constraint?: string
  message: string
}

export function pgError(err: unknown): PgErrorInfo | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      const constraint = (e as { constraint?: unknown }).constraint
      return {
        code,
        constraint: typeof constraint === 'string' ? constraint : undefined,
        message: (e as Error).message,
      }
    }
  }
  return undefined
}

/** 23505 unique_violation, optionally of one named constraint or unique index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pg = pgError(err)
  return pg?.code === '23505' && (constraint === undefined || pg.constraint === constraint)
}

/** Escape `%`, `_` and `\` for a LIKE pattern (auth-and-security.md section 10). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}
