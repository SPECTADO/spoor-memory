/**
 * The `purge-ephemeral` job (cleanup-and-jobs.md section 4): deletes rows past fixed cutoffs from tables
 * that are not append-only. Nothing else in Spoor deletes automatically; content (items, revisions, audit)
 * is never touched here.
 */
import { sql } from 'drizzle-orm'
import { type JobContext, type JobStats, throwIfAborted } from './types.js'

/** auth-and-security.md section 3 (sessions: absolute `expires_at`, idle 14 days after `last_seen_at`). */
export const SESSION_IDLE_DAYS = 14
/** Device codes are kept one day past `expires_at` (auth-and-security.md section 6). */
export const DEVICE_CODE_KEEP_DAYS = 1
/** Invites used, revoked or expired for longer than this are deleted. */
export const INVITE_KEEP_DAYS = 30
/** `job_runs` history kept for the admin page. */
export const JOB_RUNS_KEEP_DAYS = 30

const STATEMENTS = {
  sessions: sql`DELETE FROM sessions
    WHERE expires_at <= now() OR last_seen_at <= now() - make_interval(days => ${SESSION_IDLE_DAYS}::int)`,
  device_codes: sql`DELETE FROM device_codes
    WHERE expires_at < now() - make_interval(days => ${DEVICE_CODE_KEEP_DAYS}::int)`,
  invites: sql`DELETE FROM invites
    WHERE least(used_at, revoked_at, expires_at) < now() - make_interval(days => ${INVITE_KEEP_DAYS}::int)`,
  job_runs: sql`DELETE FROM job_runs
    WHERE status <> 'running' AND started_at < now() - make_interval(days => ${JOB_RUNS_KEEP_DAYS}::int)`,
} as const

export async function runPurgeEphemeral(ctx: JobContext): Promise<JobStats> {
  const stats: Record<keyof typeof STATEMENTS, number> = {
    sessions: 0,
    device_codes: 0,
    invites: 0,
    job_runs: 0,
  }
  for (const key of Object.keys(STATEMENTS) as (keyof typeof STATEMENTS)[]) {
    throwIfAborted(ctx.signal)
    const res = await ctx.db.execute(STATEMENTS[key])
    stats[key] = res.rowCount ?? 0
  }
  return stats
}
