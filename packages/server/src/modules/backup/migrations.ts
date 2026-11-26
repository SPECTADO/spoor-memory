/**
 * Which drizzle migrations a database has (backup.json `migration`) and which this server ships. A backup with
 * more migrations than this server knows cannot be fully restored (`backup_too_new`, ADR-0039).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BackupMigration } from '@spoor/shared'
import { sql } from 'drizzle-orm'
import { DEFAULT_MIGRATIONS_DIR } from '../../db/migrate.js'
import type { DbOrTx } from '../../lib/db.js'

interface JournalEntry {
  idx: number
  when: number
  tag: string
}

const journals = new Map<string, JournalEntry[]>()

/** The migration journal of this server (meta/_journal.json), read once per directory. */
export function journalEntries(dir = DEFAULT_MIGRATIONS_DIR): JournalEntry[] {
  let entries = journals.get(dir)
  if (!entries) {
    const raw = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as {
      entries: JournalEntry[]
    }
    entries = [...raw.entries].sort((a, b) => a.idx - b.idx)
    journals.set(dir, entries)
  }
  return entries
}

/** The migrations this server ships. */
export function currentMigration(dir = DEFAULT_MIGRATIONS_DIR): BackupMigration {
  const e = journalEntries(dir)
  return { count: e.length, last_tag: e.at(-1)?.tag ?? null }
}

/**
 * The migrations applied to the database (`drizzle.__drizzle_migrations`). The table stores the journal's
 * `when`, so the newest row maps back to its tag; a `when` this server does not know (a newer release) gives
 * `last_tag: null`.
 */
export async function databaseMigration(db: DbOrTx, dir = DEFAULT_MIGRATIONS_DIR): Promise<BackupMigration> {
  const res = await db.execute<{ count: number; last: string | null }>(
    sql`SELECT count(*)::int AS count, max(created_at)::text AS last FROM drizzle.__drizzle_migrations`,
  )
  const row = res.rows[0]
  const count = Number(row?.count ?? 0)
  const last = row?.last ?? null
  const tag = last === null ? null : (journalEntries(dir).find((e) => String(e.when) === last)?.tag ?? null)
  return { count, last_tag: tag }
}
