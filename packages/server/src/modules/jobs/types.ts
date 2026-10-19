/** Shared types of the jobs module: what a job handler receives and returns. */
import type { Logger } from 'pino'
import type { Db } from '../../lib/db.js'
import type { BatchContext, JobName, JobStats } from '../../ports.js'

export { JobError, type JobStats, LeaseLostError } from '../../ports.js'

/** The scheduler's context: the shared `BatchContext` (signal, deadline, renewLease) plus run bookkeeping. */
export interface JobContext extends BatchContext {
  readonly name: JobName
  readonly db: Db
  readonly log: Logger
  /** Aborted at shutdown or when the lease is lost; handlers check it between batches. */
  readonly signal: AbortSignal
  /** Wall-clock budget end (ms since epoch, scheduler clock); `Infinity` when the job has none. */
  readonly deadline: number
  /** Projects named by `enqueue(name, { projectId })` nudges since the last run (a hint, may be empty). */
  readonly projectIds: readonly string[]
  /**
   * Extend the lease (`locked_until = now() + lease`). Long handlers call it after each batch. Throws
   * `LeaseLostError` (and aborts `signal`) when another holder took the lease meanwhile.
   */
  renewLease(): Promise<void>
  /**
   * Insert this run's `job_runs(status='running')` row if it is not there yet. Jobs that record runs only
   * when there was work (`embed-pending`, `reembed`) call it once they find some; others get it up front.
   */
  markWork(): Promise<void>
  /** A finished per-project `job_runs` row (`GET /api/v1/projects/:slug/jobs` lists them). */
  recordProjectRun(projectId: string, stats: JobStats, error?: string | null): Promise<void>
}

export type JobHandler = (ctx: JobContext) => Promise<JobStats>

export interface JobDefinition {
  name: JobName
  /** Minimum time between two runs (`last_run_at <= now() - every`). */
  everyMs: number
  /** Lease length; renewed by `ctx.renewLease()`. */
  leaseMs: number
  /** Wall-clock budget exposed as `ctx.deadline`. */
  budgetMs?: number
  /** Insert the `job_runs` row only once the handler calls `markWork()` (or fails). */
  recordOnlyWithWork?: boolean
  handler: JobHandler
}

export class JobAbortedError extends Error {
  constructor(reason = 'aborted') {
    super(reason)
    this.name = 'JobAbortedError'
  }
}

/** Throw `JobAbortedError` when the signal fired (between batches). */
export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const r: unknown = signal.reason
  if (r instanceof Error) throw r
  throw new JobAbortedError(typeof r === 'string' ? r : 'aborted')
}
