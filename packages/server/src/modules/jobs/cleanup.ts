/**
 * The `cleanup` job (cleanup-and-jobs.md sections 1, 2, 4, 5): for each project, `_shared` included, one
 * transaction applying `P_expired`, `P_stale`, `P_archive` in that order with the project's own settings.
 * Each transition and its audit rows (`actor_label='system'`, `via='system'`) are ONE statement, so they
 * cannot diverge, and every UPDATE is predicate-guarded, so re-running after a crash only touches rows that
 * still match. Time is the transaction's `now()`. Then the chunk consistency sweep of the search module.
 *
 * The TypeScript twins of the predicates are in lifecycle.ts; keep both in step.
 */
import { asc, type SQL, sql } from 'drizzle-orm'
import { projects } from '../../db/schema.js'
import type { Db, Tx } from '../../lib/db.js'
import { withTx } from '../../lib/db.js'
import { loggableError } from '../../lib/errors.js'
import { resolveSettings } from '../projects/index.js'
import type { CleanupSettings } from './lifecycle.js'
import type { SearchJobs } from './search-jobs.js'
import { jobErrorMessage } from './store.js'
import { type JobContext, JobError, type JobStats, throwIfAborted } from './types.js'

const daysAgo = (n: number) => sql`now() - make_interval(days => ${n}::int)`

/** `P_stale` (cleanup-and-jobs.md section 1). */
export function pStale(staleDays: number): SQL {
  return sql`space = 'memories' AND lifecycle = 'active' AND status = 'active' AND NOT pinned
    AND type <> 'observation'
    AND greatest(last_verified_at, updated_at, coalesce(last_used_at, '-infinity')) < ${daysAgo(staleDays)}`
}

/** `P_archive` with the D9 guard (not used within the last `stale_days`). */
export function pArchive(staleDays: number, archiveDays: number): SQL {
  return sql`space = 'memories' AND lifecycle = 'stale' AND NOT pinned
    AND stale_since < ${daysAgo(archiveDays)}
    AND coalesce(last_used_at, '-infinity') < ${daysAgo(staleDays)}`
}

/** `P_expired`: observations past their hard expiry (pinning does not stop it). */
export const pExpired: SQL = sql`space = 'memories' AND type = 'observation' AND lifecycle <> 'archived'
  AND expires_at <= now()`

export interface ProjectCleanupResult {
  expired: number
  staled: number
  archived: number
}

export interface CleanupProject {
  id: string
  kind: 'project' | 'shared'
  settings: unknown
}

/**
 * One state change plus its audit rows in one statement. `set` must keep the table's CHECKs true
 * (`stale_since` set exactly while stale; `archived_at`/`archive_reason` exactly while archived).
 */
async function transition(
  tx: Tx,
  p: { projectId: string },
  set: SQL,
  where: SQL,
  audit: { action: string; summary: string; data: Record<string, unknown> },
): Promise<number> {
  const res = await tx.execute(sql`
    WITH changed AS (
      UPDATE items SET ${set}
      WHERE project_id = ${p.projectId}::uuid AND ${where}
      RETURNING id, number)
    INSERT INTO audit_log (project_id, actor_label, via, action, item_id, item_handle, summary, data)
    SELECT ${p.projectId}::uuid, 'system', 'system', ${audit.action}::text, id,
           'm' || number, ${audit.summary}::text, ${JSON.stringify(audit.data)}::jsonb
    FROM changed
    RETURNING item_id`)
  return res.rowCount ?? res.rows.length
}

/** Apply the three predicates to one project in one transaction. */
export async function cleanupProject(db: Db, project: CleanupProject): Promise<ProjectCleanupResult> {
  const s: CleanupSettings = resolveSettings(project.settings).cleanup
  // handle snapshots are relative to the row's project: plain `m1` in `_shared` too (api.md 0.6)
  const p = { projectId: project.id }
  return withTx(db, async (tx) => {
    const expired = await transition(
      tx,
      p,
      sql`lifecycle = 'archived', archived_at = now(), archive_reason = 'expired', stale_since = NULL`,
      pExpired,
      { action: 'item.expire', summary: 'observation expired', data: { reason: 'expired' } },
    )
    const staled = await transition(
      tx,
      p,
      sql`lifecycle = 'stale', stale_since = now()`,
      pStale(s.stale_days),
      {
        action: 'item.stale',
        summary: `unverified and unused for ${s.stale_days} days`,
        data: { stale_days: s.stale_days },
      },
    )
    const archived = await transition(
      tx,
      p,
      sql`lifecycle = 'archived', archived_at = now(), archive_reason = 'stale', stale_since = NULL`,
      pArchive(s.stale_days, s.archive_days),
      {
        action: 'item.archive',
        summary: `stale for over ${s.archive_days} days and unused for ${s.stale_days} days`,
        data: { reason: 'stale', stale_days: s.stale_days, archive_days: s.archive_days },
      },
    )
    return { expired, staled, archived }
  })
}

/**
 * The job handler body. A failing project is logged, recorded on its own `job_runs` row and skipped; the run
 * still ends as `error` (with the stats of the others) so the admin page shows it. Per-project rows are
 * written only for projects where something changed or failed, so the history is not one row per project
 * per hour.
 */
export async function runCleanup(ctx: JobContext, search: Pick<SearchJobs, 'chunkSweep'>): Promise<JobStats> {
  const list = await ctx.db
    .select({ id: projects.id, kind: projects.kind, settings: projects.settings })
    .from(projects)
    .orderBy(asc(projects.id))
  const stats = { projects: 0, expired: 0, staled: 0, archived: 0, rechunked: 0, failed_projects: 0 }
  for (const project of list) {
    throwIfAborted(ctx.signal)
    try {
      const r = await cleanupProject(ctx.db, project)
      stats.projects++
      stats.expired += r.expired
      stats.staled += r.staled
      stats.archived += r.archived
      if (r.expired + r.staled + r.archived > 0) await ctx.recordProjectRun(project.id, { ...r })
    } catch (err) {
      stats.failed_projects++
      ctx.log.error({ err: loggableError(err), project_id: project.id }, 'cleanup of a project failed')
      await ctx.recordProjectRun(project.id, {}, jobErrorMessage(err)).catch(() => {})
    }
    await ctx.renewLease()
  }
  throwIfAborted(ctx.signal)
  const sweep = await search.chunkSweep(ctx)
  stats.rechunked = sweep.rechunked
  if (sweep.rechunked > 0) {
    ctx.log.warn({ rechunked: sweep.rechunked }, 'chunk consistency sweep re-chunked items')
  }
  if (stats.failed_projects > 0) {
    throw new JobError(`cleanup failed for ${stats.failed_projects} project(s)`, stats)
  }
  return stats
}
