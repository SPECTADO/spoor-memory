/**
 * One heavy operation (backup, verify, full restore) at a time across every Spoor container (ADR-0038): an
 * in-process flag (set synchronously, so two requests of one process cannot race) plus a session-level
 * advisory lock held on a dedicated connection for the whole operation (it must survive a full restore, which
 * replaces every table). A second operation gets 503 `busy`.
 *
 * The holder's connection carries what it runs in a comment of its last statement, so any container can show
 * `status.running` from `pg_locks` + `pg_stat_activity` (same role, no extra table that a restore could rewind).
 */
import {
  BACKUP_KINDS,
  BACKUP_OPERATIONS,
  type BackupKind,
  type BackupOperation,
  type BackupRunningJson,
  isBackupId,
} from '@spoor/shared'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { appApplicationName } from '../../db/client.js'
import type { DbOrTx } from '../../lib/db.js'
import { ApiError } from '../../lib/errors.js'

/** Two-int advisory key in its own key space (pg_locks: classid, objid, objsubid = 2). */
export const HEAVY_LOCK_KEY = [38038, 1] as const
const MARK = 'spoor-heavy'

export const busyError = (running: BackupRunningJson | null) =>
  new ApiError('busy', {
    message: running
      ? `Another backup operation is running (${running.operation} ${running.backup_id}).`
      : 'Another backup operation is running.',
    hint: 'Try again when it has finished.',
  })

/** Only values that passed these checks are ever put into the SQL comment. */
function safeInfo(info: BackupRunningJson): BackupRunningJson {
  if (!BACKUP_OPERATIONS.includes(info.operation)) throw new Error('bad operation')
  if (info.backup_id !== '' && !isBackupId(info.backup_id)) throw new Error('bad backup id')
  if (info.kind !== null && !BACKUP_KINDS.includes(info.kind)) throw new Error('bad kind')
  if (Number.isNaN(Date.parse(info.started_at)) || !/^[0-9T:.Z-]+$/.test(info.started_at)) {
    throw new Error('bad started_at')
  }
  return info
}

export function parseRunningMark(query: string): BackupRunningJson | null {
  const m = new RegExp(`/\\* ${MARK} (\\{[^*]*\\}) \\*/`).exec(query)
  if (!m) return null
  try {
    const raw = JSON.parse(m[1] as string) as Record<string, unknown>
    return safeInfo({
      operation: raw.operation as BackupOperation,
      backup_id: String(raw.backup_id ?? ''),
      kind: (raw.kind ?? null) as BackupKind | null,
      started_at: String(raw.started_at ?? ''),
    })
  } catch {
    return null
  }
}

export interface HeldLock {
  readonly info: BackupRunningJson
  release(): Promise<void>
}

export class HeavyLock {
  #held: BackupRunningJson | null = null

  constructor(private readonly databaseUrl: string) {}

  /** What this process runs, or null. */
  get current(): BackupRunningJson | null {
    return this.#held
  }

  /** Take the lock or throw 503 `busy`. The caller must `release()` it (finally). */
  async acquire(info: BackupRunningJson): Promise<HeldLock> {
    const checked = safeInfo(info)
    if (this.#held) throw busyError(this.#held)
    this.#held = checked
    const client = new pg.Client({
      connectionString: this.databaseUrl,
      application_name: appApplicationName(),
      connectionTimeoutMillis: 5000,
    })
    // a dropped lock connection must not crash the process; the lock is then simply gone
    client.on('error', () => {})
    try {
      await client.connect()
      const mark = JSON.stringify(checked)
      const res = await client.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock(${HEAVY_LOCK_KEY[0]}, ${HEAVY_LOCK_KEY[1]}) AS ok /* ${MARK} ${mark} */`,
      )
      if (!res.rows[0]?.ok) {
        const other = await observeLock(client)
        throw busyError(other)
      }
    } catch (err) {
      this.#held = null
      await client.end().catch(() => {})
      throw err
    }
    let released = false
    return {
      info: checked,
      release: async () => {
        if (released) return
        released = true
        this.#held = null
        try {
          await client.query(`SELECT pg_advisory_unlock(${HEAVY_LOCK_KEY[0]}, ${HEAVY_LOCK_KEY[1]})`)
        } catch {
          // the connection is gone: so is its lock
        }
        await client.end().catch(() => {})
      },
    }
  }

  /** The operation running anywhere: this process's, else the holder's mark from `pg_stat_activity`. */
  async running(db: DbOrTx): Promise<BackupRunningJson | null> {
    if (this.#held) return this.#held
    return observeLock(db)
  }
}

type Queryable = DbOrTx | pg.Client

async function observeLock(q: Queryable): Promise<BackupRunningJson | null> {
  const text = `SELECT a.query FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory' AND l.granted AND l.classid = ${HEAVY_LOCK_KEY[0]}
      AND l.objid = ${HEAVY_LOCK_KEY[1]} AND l.objsubid = 2
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    LIMIT 1`
  const rows =
    q instanceof pg.Client
      ? (await q.query<{ query: string | null }>(text)).rows
      : (await q.execute<{ query: string | null }>(sql.raw(text))).rows
  const row = rows[0]
  if (!row) return null
  // held, but the mark is unreadable (e.g. a role without pg_read_all_stats): still busy
  return (
    parseRunningMark(row.query ?? '') ?? {
      operation: 'backup',
      backup_id: '',
      kind: null,
      started_at: new Date().toISOString(),
    }
  )
}
