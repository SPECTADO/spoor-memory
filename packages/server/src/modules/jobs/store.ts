/**
 * The scheduler's persistence: DB leases in `job_locks` and run history in `job_runs`
 * (cleanup-and-jobs.md section 4, data-model.md section 4). The interface lets the scheduler's tick logic be
 * unit-tested with an in-memory store; `PgJobStore` is the real one.
 *
 * Due-ness and lock-freeness are checked in ONE conditional UPDATE, so two containers sharing a database
 * never run the same job twice. All lease times are the database's `now()`.
 */
import { sql } from 'drizzle-orm'
import { type Db, pgError } from '../../lib/db.js'
import type { JobStats } from './types.js'

export interface LeaseRequest {
  name: string
  instance: string
  leaseMs: number
  everyMs: number
  /** Skip the due check (a nudge or an admin "run now"); the lock is still required. */
  force: boolean
}

export type RunStatus = 'ok' | 'error'

export interface JobStore {
  /** `INSERT … ON CONFLICT DO NOTHING` one lock row per job name (startup step 5). */
  seed(names: readonly string[]): Promise<void>
  tryLease(req: LeaseRequest): Promise<boolean>
  /** `false` when this instance no longer holds the lease. */
  renew(name: string, instance: string, leaseMs: number): Promise<boolean>
  /** Free the lease and record the outcome; a no-op when another instance holds it now. */
  release(name: string, instance: string, status: RunStatus, error: string | null): Promise<void>
  /** A `running` row; returns its id. */
  insertRun(name: string, startedAt: Date, projectId: string | null): Promise<number>
  finishRun(id: number, status: RunStatus, stats: JobStats, error: string | null): Promise<void>
  /** A complete row in one go (per-project rows). */
  insertFinishedRun(row: {
    name: string
    projectId: string | null
    startedAt: Date
    status: RunStatus
    stats: JobStats
    error: string | null
  }): Promise<void>
}

const secs = (ms: number) => Math.max(1, Math.round(ms / 1000))
const interval = (ms: number) => sql`make_interval(secs => ${secs(ms)}::int)`

/**
 * What a failed run may say in `job_runs.error` (served to project admins by the job status API): a database
 * error is only `database error <SQLSTATE>`, never drizzle's `Failed query: <SQL> params: <values>` (item
 * text, ids); the full detail goes to the server log only (`loggableError`). Review S5.
 */
export function jobErrorMessage(err: unknown): string {
  const pg = pgError(err)
  if (pg) return `database error ${pg.code}`
  const msg = err instanceof Error ? err.message : String(err)
  return /Failed query:/.test(msg) ? 'database error' : msg
}

/** `job_locks.last_error` / `job_runs.error`: the message only, one line, bounded. Never a stack or secret. */
export function errorText(error: string | null): string | null {
  if (error === null) return null
  // defence in depth: whatever the caller passed, no query text or bound parameters survive
  const line = error
    .replace(/Failed query:[\s\S]*/, 'database error')
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > 500 ? `${line.slice(0, 499)}…` : line
}

export class PgJobStore implements JobStore {
  constructor(private readonly db: Db) {}

  async seed(names: readonly string[]): Promise<void> {
    if (names.length === 0) return
    const rows = sql.join(
      names.map((n) => sql`(${n})`),
      sql`, `,
    )
    await this.db.execute(sql`INSERT INTO job_locks (name) VALUES ${rows} ON CONFLICT (name) DO NOTHING`)
  }

  async tryLease(r: LeaseRequest): Promise<boolean> {
    const due = r.force
      ? sql``
      : sql`AND (last_run_at IS NULL OR last_run_at <= now() - ${interval(r.everyMs)})`
    const res = await this.db.execute(sql`UPDATE job_locks
      SET locked_until = now() + ${interval(r.leaseMs)}, locked_by = ${r.instance}, last_run_at = now()
      WHERE name = ${r.name} AND locked_until < now() ${due}
      RETURNING name`)
    return res.rows.length === 1
  }

  async renew(name: string, instance: string, leaseMs: number): Promise<boolean> {
    const res = await this.db.execute(sql`UPDATE job_locks SET locked_until = now() + ${interval(leaseMs)}
      WHERE name = ${name} AND locked_by = ${instance}
      RETURNING name`)
    return res.rows.length === 1
  }

  async release(name: string, instance: string, status: RunStatus, error: string | null): Promise<void> {
    await this.db.execute(sql`UPDATE job_locks
      SET locked_until = '-infinity', last_status = ${status}, last_error = ${errorText(error)}
      WHERE name = ${name} AND locked_by = ${instance}`)
  }

  async insertRun(name: string, startedAt: Date, projectId: string | null): Promise<number> {
    const res = await this.db.execute<{ id: string | number }>(sql`INSERT INTO job_runs
      (name, project_id, started_at, status) VALUES (${name}, ${projectId}::uuid, ${startedAt.toISOString()}::timestamptz, 'running')
      RETURNING id`)
    return Number(res.rows[0]?.id)
  }

  async finishRun(id: number, status: RunStatus, stats: JobStats, error: string | null): Promise<void> {
    await this.db.execute(sql`UPDATE job_runs
      SET finished_at = now(), status = ${status}, stats = ${JSON.stringify(stats)}::jsonb, error = ${errorText(error)}
      WHERE id = ${id}`)
  }

  async insertFinishedRun(row: {
    name: string
    projectId: string | null
    startedAt: Date
    status: RunStatus
    stats: JobStats
    error: string | null
  }): Promise<void> {
    await this.db.execute(sql`INSERT INTO job_runs (name, project_id, started_at, finished_at, status, stats, error)
      VALUES (${row.name}, ${row.projectId}::uuid, ${row.startedAt.toISOString()}::timestamptz, now(), ${row.status},
              ${JSON.stringify(row.stats)}::jsonb, ${errorText(row.error)})`)
  }
}
