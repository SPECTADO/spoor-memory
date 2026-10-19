/**
 * The in-process scheduler (cleanup-and-jobs.md section 4, deployment.md sections 2 and 4). No library:
 * - `start()` seeds the lock rows and schedules the first tick 30 s later; then a tick every 60 s plus
 *   0 to 10 s of jitter (a chain of `unref()`ed timeouts, so it never keeps the process alive);
 * - each tick tries, for every registered job not already running here, the atomic lease UPDATE; a row back
 *   means this process owns the run;
 * - a run gets a `job_runs` row (`running`, or only once there is work), an AbortSignal, a lease it renews
 *   per batch, and at the end `job_locks` is released with `last_status` / `last_error`;
 * - `enqueue(name)` (the `JobsPort`) is a nudge: an early tick that skips the due check for that job, still
 *   subject to the lease;
 * - `stop()` stops ticking, aborts running handlers, waits up to 25 s, then releases what is left.
 *
 * With `SPOOR_JOBS=off` the scheduler is disabled: `start`, `enqueue` and `runNow` do nothing.
 */
import { hostname } from 'node:os'
import type { Logger } from 'pino'
import type { Db } from '../../lib/db.js'
import { loggableError } from '../../lib/errors.js'
import type { JobName, JobsPort } from '../../ports.js'
import { type Clock, systemClock, systemTimers, type TimerHandle, type Timers } from './clock.js'
import { type JobStore, jobErrorMessage, type RunStatus } from './store.js'
import { type JobContext, type JobDefinition, JobError, type JobStats, LeaseLostError } from './types.js'

export const SCHEDULER_DEFAULTS = {
  firstTickMs: 30_000,
  tickMs: 60_000,
  jitterMs: 10_000,
  nudgeDelayMs: 1_000,
  shutdownTimeoutMs: 25_000,
} as const

export interface SchedulerOptions {
  db: Db
  store: JobStore
  logger: Logger
  jobs?: JobDefinition[]
  /** `false` = `SPOOR_JOBS=off`. */
  enabled?: boolean
  /** `job_locks.locked_by`; default `hostname:pid`. */
  instanceId?: string
  firstTickMs?: number
  tickMs?: number
  jitterMs?: number
  nudgeDelayMs?: number
  shutdownTimeoutMs?: number
  clock?: Clock
  timers?: Timers
  /** `[0, 1)`; jitter source. */
  random?: () => number
}

export type RunNowResult =
  | { started: true }
  | { started: false; reason: 'disabled' | 'stopped' | 'running' | 'unknown_job' }

interface Running {
  promise: Promise<void>
  controller: AbortController
  runId: () => number | null
  /** Set when shutdown gave up waiting: the late finish must not touch the database. */
  abandoned: boolean
}

export const defaultInstanceId = () => `${hostname()}:${process.pid}`

export class Scheduler implements JobsPort {
  readonly instanceId: string
  readonly enabled: boolean
  readonly #o: Required<
    Pick<SchedulerOptions, 'firstTickMs' | 'tickMs' | 'jitterMs' | 'nudgeDelayMs' | 'shutdownTimeoutMs'>
  >
  readonly #db: Db
  readonly #store: JobStore
  readonly #log: Logger
  readonly #clock: Clock
  readonly #timers: Timers
  readonly #random: () => number
  readonly #jobs = new Map<JobName, JobDefinition>()
  readonly #running = new Map<JobName, Running>()
  /** Jobs nudged since their last run start: next lease attempt skips the due check. */
  readonly #forced = new Set<JobName>()
  readonly #hints = new Map<JobName, Set<string>>()
  #timer: TimerHandle | undefined
  #nudgeTimer: TimerHandle | undefined
  #started = false
  #stopped = false
  #ticking: Promise<void> | undefined
  #tickAgain = false

  constructor(opts: SchedulerOptions) {
    this.#db = opts.db
    this.#store = opts.store
    this.#log = opts.logger
    this.enabled = opts.enabled ?? true
    this.instanceId = opts.instanceId ?? defaultInstanceId()
    this.#clock = opts.clock ?? systemClock
    this.#timers = opts.timers ?? systemTimers
    this.#random = opts.random ?? Math.random
    this.#o = {
      firstTickMs: opts.firstTickMs ?? SCHEDULER_DEFAULTS.firstTickMs,
      tickMs: opts.tickMs ?? SCHEDULER_DEFAULTS.tickMs,
      jitterMs: opts.jitterMs ?? SCHEDULER_DEFAULTS.jitterMs,
      nudgeDelayMs: opts.nudgeDelayMs ?? SCHEDULER_DEFAULTS.nudgeDelayMs,
      shutdownTimeoutMs: opts.shutdownTimeoutMs ?? SCHEDULER_DEFAULTS.shutdownTimeoutMs,
    }
    for (const def of opts.jobs ?? []) this.register(def)
  }

  /** Add (or replace) a job definition; allowed before `start()` so the wiring can break dependency cycles. */
  register(def: JobDefinition): void {
    this.#jobs.set(def.name, def)
  }

  definitions(): JobDefinition[] {
    return [...this.#jobs.values()]
  }

  /** Names of jobs running in this process right now. */
  runningJobs(): JobName[] {
    return [...this.#running.keys()]
  }

  /** Seed `job_locks` (startup step 5). Safe to call with jobs off; idempotent. */
  async seed(): Promise<void> {
    await this.#store.seed([...this.#jobs.keys()])
  }

  /** Seed the lock rows and schedule the first tick (startup step 8). */
  async start(): Promise<void> {
    if (!this.enabled || this.#started || this.#stopped) return
    await this.seed()
    this.#started = true
    this.#schedule(this.#o.firstTickMs)
    this.#log.info({ instance: this.instanceId, jobs: [...this.#jobs.keys()] }, 'scheduler started')
  }

  /** `JobsPort`: ask for a run soon. A nudge, not a queue. */
  enqueue(name: JobName, opts: { projectId?: string } = {}): void {
    if (!this.enabled || this.#stopped || !this.#jobs.has(name)) return
    this.#forced.add(name)
    if (opts.projectId) {
      const set = this.#hints.get(name) ?? new Set<string>()
      set.add(opts.projectId)
      this.#hints.set(name, set)
    }
    if (this.#started && this.#nudgeTimer === undefined) {
      this.#nudgeTimer = this.#timers.setTimeout(() => {
        this.#nudgeTimer = undefined
        void this.tick()
      }, this.#o.nudgeDelayMs)
    }
  }

  /**
   * Admin "run now": take the lease immediately (skipping the due check) and start the handler in the
   * background. Works only while the scheduler is enabled; never runs a job a second time concurrently.
   */
  async runNow(name: JobName, opts: { projectId?: string } = {}): Promise<RunNowResult> {
    if (!this.enabled) return { started: false, reason: 'disabled' }
    if (this.#stopped) return { started: false, reason: 'stopped' }
    const def = this.#jobs.get(name)
    if (!def) return { started: false, reason: 'unknown_job' }
    if (this.#running.has(name)) return { started: false, reason: 'running' }
    if (opts.projectId) this.#hints.set(name, new Set([...(this.#hints.get(name) ?? []), opts.projectId]))
    await this.#store.seed([name])
    const got = await this.#store.tryLease(this.#leaseRequest(def, true))
    if (!got) return { started: false, reason: 'running' }
    this.#launch(def)
    return { started: true }
  }

  /** One pass over every job. Public for tests; overlapping calls coalesce into one extra pass. */
  async tick(): Promise<void> {
    if (!this.enabled || this.#stopped) return
    if (this.#ticking) {
      this.#tickAgain = true
      return this.#ticking
    }
    this.#ticking = (async () => {
      do {
        this.#tickAgain = false
        for (const def of this.#jobs.values()) {
          if (this.#stopped) return
          if (this.#running.has(def.name)) continue
          try {
            const force = this.#forced.has(def.name)
            if (await this.#store.tryLease(this.#leaseRequest(def, force))) this.#launch(def)
          } catch (err) {
            this.#log.error({ err: loggableError(err), job: def.name }, 'job lease attempt failed')
          }
        }
      } while (this.#tickAgain && !this.#stopped)
    })()
    try {
      await this.#ticking
    } finally {
      this.#ticking = undefined
    }
  }

  /** Wait until no handler runs in this process (tests). */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running.values()].map((r) => r.promise))
  }

  /**
   * Graceful shutdown: stop ticking, abort running handlers, wait up to `shutdownTimeoutMs`, then release
   * the leases (and mark the runs) of handlers that did not finish. A crashed holder's lease simply runs out.
   */
  async stop(): Promise<void> {
    if (this.#stopped) return
    this.#stopped = true
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer)
    if (this.#nudgeTimer !== undefined) this.#timers.clearTimeout(this.#nudgeTimer)
    this.#timer = undefined
    this.#nudgeTimer = undefined
    if (this.#ticking) await this.#ticking.catch(() => {})
    const running = [...this.#running.entries()]
    if (running.length === 0) return
    for (const [, r] of running) r.controller.abort(new Error('shutting down'))
    let timeout: TimerHandle | undefined
    const timedOut = await Promise.race([
      Promise.allSettled(running.map(([, r]) => r.promise)).then(() => false),
      new Promise<boolean>((resolve) => {
        timeout = this.#timers.setTimeout(() => resolve(true), this.#o.shutdownTimeoutMs)
      }),
    ])
    if (timeout !== undefined) this.#timers.clearTimeout(timeout)
    if (!timedOut) return
    for (const [name, r] of running) {
      if (!this.#running.has(name)) continue
      r.abandoned = true
      this.#running.delete(name)
      const msg = 'interrupted by shutdown'
      this.#log.warn({ job: name }, 'job did not stop in time; releasing its lease')
      try {
        const id = r.runId()
        if (id !== null) await this.#store.finishRun(id, 'error', {}, msg)
        await this.#store.release(name, this.instanceId, 'error', msg)
      } catch (err) {
        this.#log.error({ err: loggableError(err), job: name }, 'releasing a job lease at shutdown failed')
      }
    }
  }

  // ---- internals ----------------------------------------------------------------------------------------

  #leaseRequest(def: JobDefinition, force: boolean) {
    return { name: def.name, instance: this.instanceId, leaseMs: def.leaseMs, everyMs: def.everyMs, force }
  }

  #schedule(ms: number): void {
    if (this.#stopped) return
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined
      void this.tick().finally(() =>
        this.#schedule(this.#o.tickMs + Math.floor(this.#random() * this.#o.jitterMs)),
      )
    }, ms)
  }

  #launch(def: JobDefinition): void {
    const name = def.name
    this.#forced.delete(name)
    const projectIds = [...(this.#hints.get(name) ?? [])]
    this.#hints.delete(name)
    const controller = new AbortController()
    const startedAtMs = this.#clock.now()
    const startedAt = new Date(startedAtMs)
    let runId: number | null = null
    let runInsert: Promise<void> | undefined
    const store = this.#store
    const log = this.#log.child({ job: name })
    const markWork = () => {
      runInsert ??= store.insertRun(name, startedAt, null).then((id) => {
        runId = id
      })
      return runInsert
    }
    const entry: Running = {
      promise: Promise.resolve(),
      controller,
      runId: () => runId,
      abandoned: false,
    }
    const ctx: JobContext = {
      name,
      db: this.#db,
      log,
      signal: controller.signal,
      deadline: def.budgetMs === undefined ? Number.POSITIVE_INFINITY : startedAtMs + def.budgetMs,
      projectIds,
      renewLease: async () => {
        if (await store.renew(name, this.instanceId, def.leaseMs)) return
        const err = new LeaseLostError(name)
        controller.abort(err)
        throw err
      },
      markWork,
      recordProjectRun: (projectId, stats, error = null) =>
        store.insertFinishedRun({
          name,
          projectId,
          startedAt,
          status: error === null ? 'ok' : 'error',
          stats,
          error,
        }),
    }
    entry.promise = (async () => {
      let status: RunStatus = 'ok'
      let error: string | null = null
      let stats: JobStats = {}
      try {
        if (!def.recordOnlyWithWork) await markWork()
        stats = (await def.handler(ctx)) ?? {}
      } catch (err) {
        status = 'error'
        error = jobErrorMessage(err)
        if (err instanceof JobError) stats = err.stats
        log.error({ err: loggableError(err) }, 'job failed')
      }
      if (entry.abandoned) return
      try {
        if (runInsert) await runInsert.catch(() => {})
        // a failed run always gets a row, also for jobs that record only runs with work
        if (status === 'error' && runId === null) await markWork()
        if (runId !== null) await store.finishRun(runId, status, stats, error)
      } catch (err) {
        log.error({ err: loggableError(err) }, 'recording a job run failed')
      }
      try {
        // released separately, so a failed history write never keeps the lease until it runs out
        await store.release(name, this.instanceId, status, error)
        if (status === 'ok') log.debug({ stats, ms: this.#clock.now() - startedAtMs }, 'job finished')
      } catch (err) {
        log.error({ err: loggableError(err) }, 'releasing a job lease failed')
      } finally {
        if (this.#running.get(name) === entry) this.#running.delete(name)
      }
    })()
    this.#running.set(name, entry)
  }
}
