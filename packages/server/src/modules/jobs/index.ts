/**
 * Jobs module: the in-process scheduler with DB leases, the cleanup / purge jobs, the embed-pending and
 * re-embed wrappers around the search module's job functions, the review-queue lists, the project dashboard
 * and job status.
 * Design: docs/design/cleanup-and-jobs.md, deployment.md sections 2 and 4, api.md sections 7.2, 8 and 10.
 *
 * Wiring (src/index.ts):
 *   const scheduler = createScheduler({ db, logger, config })        // before the ports: it IS ports.jobs
 *   const ports = { embeddings, search, jobs: scheduler }
 *   registerJobs(scheduler, { searchJobs })                           // once the search module exists
 *   await scheduler.seed()                                            // startup step 5 (also with jobs off)
 *   await scheduler.start()                                           // startup step 8 (first tick after 30 s)
 *   on SIGTERM: await scheduler.stop()                                // before closing the pool
 * and in app.ts: `createJobsModule(deps, { scheduler })`, `api.route('/', jobs.routes)`,
 * `bearerApi.route('/', jobs.bearerRoutes)`.
 */
import type { Logger } from 'pino'
import type { Config } from '../../config.js'
import type { Db } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import { RequestLogService } from '../requests/index.js'
import { DashboardService } from './dashboard.js'
import { jobDefinitions } from './definitions.js'
import { ReviewService } from './review.js'
import { jobsBearerRoutes, jobsRoutes } from './routes.js'
import { Scheduler, type SchedulerOptions } from './scheduler.js'
import type { SearchJobs } from './search-jobs.js'
import { JobStatusService } from './status.js'
import { PgJobStore } from './store.js'

export { cleanupProject, pArchive, pExpired, pStale, runCleanup } from './cleanup.js'
export { type Clock, FakeClock, systemClock, systemTimers, type Timers } from './clock.js'
export { DASHBOARD_RECENT, DashboardService } from './dashboard.js'
export { JOB_SCHEDULE, jobDefinitions } from './definitions.js'
export * as lifecycle from './lifecycle.js'
export { runPurgeEphemeral } from './purge.js'
export { REVIEW_SECTIONS, ReviewService } from './review.js'
export {
  defaultInstanceId,
  type RunNowResult,
  SCHEDULER_DEFAULTS,
  Scheduler,
  type SchedulerOptions,
} from './scheduler.js'
export { embedPendingHandler, noopSearchJobs, reembedHandler, type SearchJobs } from './search-jobs.js'
export { JobStatusService, jobRunJson } from './status.js'
export { type JobStore, PgJobStore } from './store.js'
export {
  JobAbortedError,
  type JobContext,
  type JobDefinition,
  JobError,
  type JobHandler,
  type JobStats,
  LeaseLostError,
} from './types.js'

/** The scheduler on the real store; disabled when `SPOOR_JOBS=off`. Registers the default jobs. */
export function createScheduler(
  deps: { db: Db; logger: Logger; config: Pick<Config, 'SPOOR_JOBS'> },
  opts: { searchJobs?: SearchJobs } & Partial<Omit<SchedulerOptions, 'db' | 'store' | 'logger'>> = {},
): Scheduler {
  const { searchJobs, ...rest } = opts
  return new Scheduler({
    db: deps.db,
    store: new PgJobStore(deps.db),
    logger: deps.logger.child({ module: 'jobs' }),
    enabled: deps.config.SPOOR_JOBS === 'on',
    jobs: jobDefinitions({ searchJobs }),
    ...rest,
  })
}

/** Replace the job definitions once the search module's job functions exist. */
export function registerJobs(scheduler: Scheduler, opts: { searchJobs?: SearchJobs } = {}): void {
  for (const def of jobDefinitions(opts)) scheduler.register(def)
}

export function createJobsModule(
  deps: ServerDeps,
  opts: { scheduler?: Scheduler; requests?: RequestLogService } = {},
) {
  const scheduler = opts.scheduler ?? createScheduler(deps)
  const review = new ReviewService(deps)
  const status = new JobStatusService(deps, scheduler)
  const dashboard = new DashboardService(deps, review, opts.requests ?? new RequestLogService(deps))
  return {
    name: 'jobs',
    scheduler,
    review,
    status,
    dashboard,
    routes: jobsRoutes(deps, { review, status, dashboard }),
    bearerRoutes: jobsBearerRoutes(review),
  }
}

export type JobsModule = ReturnType<typeof createJobsModule>
