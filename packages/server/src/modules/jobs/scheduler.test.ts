// The scheduler's tick loop, leases, nudges, run recording and graceful shutdown (cleanup-and-jobs.md
// section 4), against an in-memory store that mimics the lease SQL on the same fake clock.
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import type { Db } from '../../lib/db.js'
import type { JobName } from '../../ports.js'
import { FakeClock } from './clock.js'
import { Scheduler, type SchedulerOptions } from './scheduler.js'
import type { JobStore, LeaseRequest, RunStatus } from './store.js'
import { type JobContext, type JobDefinition, JobError, type JobStats, throwIfAborted } from './types.js'

const MIN = 60_000
const HOUR = 60 * MIN

interface Lock {
  lockedUntil: number
  lockedBy: string | null
  lastRunAt: number | null
  lastStatus: RunStatus | null
  lastError: string | null
}

interface Run {
  id: number
  name: string
  projectId: string | null
  startedAt: number
  finishedAt: number | null
  status: 'running' | RunStatus
  stats: JobStats
  error: string | null
}

class MemoryJobStore implements JobStore {
  readonly locks = new Map<string, Lock>()
  readonly runs: Run[] = []
  constructor(private readonly clock: FakeClock) {}

  async seed(names: readonly string[]) {
    for (const n of names) {
      if (!this.locks.has(n))
        this.locks.set(n, {
          lockedUntil: Number.NEGATIVE_INFINITY,
          lockedBy: null,
          lastRunAt: null,
          lastStatus: null,
          lastError: null,
        })
    }
  }
  async tryLease(r: LeaseRequest) {
    const now = this.clock.now()
    const l = this.locks.get(r.name)
    if (!l || !(l.lockedUntil < now)) return false
    if (!r.force && l.lastRunAt !== null && !(l.lastRunAt <= now - r.everyMs)) return false
    Object.assign(l, { lockedUntil: now + r.leaseMs, lockedBy: r.instance, lastRunAt: now })
    return true
  }
  async renew(name: string, instance: string, leaseMs: number) {
    const l = this.locks.get(name)
    if (!l || l.lockedBy !== instance) return false
    l.lockedUntil = this.clock.now() + leaseMs
    return true
  }
  async release(name: string, instance: string, status: RunStatus, error: string | null) {
    const l = this.locks.get(name)
    if (!l || l.lockedBy !== instance) return
    Object.assign(l, { lockedUntil: Number.NEGATIVE_INFINITY, lastStatus: status, lastError: error })
  }
  async insertRun(name: string, startedAt: Date, projectId: string | null) {
    const id = this.runs.length + 1
    this.runs.push({
      id,
      name,
      projectId,
      startedAt: startedAt.getTime(),
      finishedAt: null,
      status: 'running',
      stats: {},
      error: null,
    })
    return id
  }
  async finishRun(id: number, status: RunStatus, stats: JobStats, error: string | null) {
    const r = this.runs.find((x) => x.id === id)
    if (r) Object.assign(r, { status, stats, error, finishedAt: this.clock.now() })
  }
  async insertFinishedRun(row: {
    name: string
    projectId: string | null
    startedAt: Date
    status: RunStatus
    stats: JobStats
    error: string | null
  }) {
    this.runs.push({
      id: this.runs.length + 1,
      ...row,
      startedAt: row.startedAt.getTime(),
      finishedAt: this.clock.now(),
    })
  }
}

/** Let pending promise chains run (the fake timers fire synchronously; handlers are async). */
async function settle() {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
}

function harness(
  jobs: JobDefinition[],
  opts: Partial<SchedulerOptions> & { store?: MemoryJobStore; clock?: FakeClock } = {},
) {
  const clock = opts.clock ?? new FakeClock()
  const store = opts.store ?? new MemoryJobStore(clock)
  const scheduler = new Scheduler({
    db: {} as Db, // handlers in these tests never touch it
    store,
    logger: pino({ level: 'silent' }),
    jobs,
    instanceId: 'test:1',
    clock,
    timers: clock,
    random: () => 0.5,
    ...opts,
  })
  return { clock, store, scheduler }
}

function job(name: JobName, handler: JobDefinition['handler'], over: Partial<JobDefinition> = {}) {
  return { name, everyMs: HOUR, leaseMs: 10 * MIN, handler, ...over } satisfies JobDefinition
}

function counter() {
  const calls: JobContext[] = []
  const handler = async (ctx: JobContext) => {
    calls.push(ctx)
    return { n: calls.length }
  }
  return { calls, handler }
}

describe('tick loop', () => {
  it('seeds the lock rows on start and ticks first after 30 s, then every 60 s plus jitter', async () => {
    const c = counter()
    const { clock, store, scheduler } = harness([job('purge-ephemeral', c.handler, { everyMs: MIN })])
    await scheduler.start()
    expect([...store.locks.keys()]).toEqual(['purge-ephemeral'])
    clock.advance(29_999)
    await settle()
    expect(c.calls).toHaveLength(0)
    clock.advance(1)
    await settle()
    expect(c.calls).toHaveLength(1)
    // random() = 0.5 -> 60 s + 5 s jitter
    expect(clock.pending()).toEqual([65_000])
    clock.advance(65_000)
    await settle()
    expect(c.calls).toHaveLength(2)
    await scheduler.stop()
  })

  it('runs a job only when it is due (last_run_at <= now - every)', async () => {
    const c = counter()
    const { clock, scheduler } = harness([job('cleanup', c.handler)])
    await scheduler.start()
    clock.advance(30_000)
    await settle()
    expect(c.calls).toHaveLength(1)
    for (let i = 0; i < 50; i++) {
      clock.advance(65_000)
      await settle()
    }
    // 50 * 65 s = 54 min: not due yet
    expect(c.calls).toHaveLength(1)
    for (let i = 0; i < 6; i++) {
      clock.advance(65_000)
      await settle()
    }
    expect(c.calls).toHaveLength(2)
    await scheduler.stop()
  })

  it('never runs a job twice at once: a second instance on the same store waits for the lease', async () => {
    const clock = new FakeClock()
    const store = new MemoryJobStore(clock)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const started: string[] = []
    const mk = (instance: string) =>
      harness(
        [
          job(
            'cleanup',
            async () => {
              started.push(instance)
              await gate
              return {}
            },
            { everyMs: MIN },
          ),
        ],
        { clock, store, instanceId: instance },
      ).scheduler
    const a = mk('a:1')
    const b = mk('b:1')
    await a.seed()
    await a.tick()
    await b.tick()
    expect(started).toEqual(['a:1'])
    release()
    await a.idle()
    clock.advance(MIN)
    await b.tick()
    expect(started).toEqual(['a:1', 'b:1'])
    await b.idle()
  })

  it('a job that is still running here is not leased again by the next tick', async () => {
    let calls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { clock, scheduler, store } = harness([
      job(
        'reembed',
        async (ctx) => {
          calls++
          await gate
          await ctx.renewLease()
          return {}
        },
        { everyMs: MIN, leaseMs: 5 * MIN },
      ),
    ])
    await scheduler.seed()
    await scheduler.tick()
    clock.advance(10 * MIN) // lease would have run out, but this process still runs it
    await scheduler.tick()
    expect(calls).toBe(1)
    expect(scheduler.runningJobs()).toEqual(['reembed'])
    release()
    await scheduler.idle()
    expect(store.locks.get('reembed')?.lastStatus).toBe('ok')
  })
})

describe('runs and leases', () => {
  it('records a job_runs row (running -> ok with stats) and releases the lease', async () => {
    const { store, scheduler } = harness([job('cleanup', async () => ({ staled: 3 }))])
    await scheduler.seed()
    await scheduler.tick()
    await scheduler.idle()
    expect(store.runs).toHaveLength(1)
    expect(store.runs[0]).toMatchObject({ name: 'cleanup', status: 'ok', stats: { staled: 3 }, error: null })
    expect(store.locks.get('cleanup')).toMatchObject({
      lockedUntil: Number.NEGATIVE_INFINITY,
      lastStatus: 'ok',
      lastError: null,
    })
  })

  it('records a failure with its message and partial stats', async () => {
    const { store, scheduler } = harness([
      job('cleanup', async () => {
        throw new JobError('cleanup failed for 1 project(s)', { staled: 2, failed_projects: 1 })
      }),
    ])
    await scheduler.seed()
    await scheduler.tick()
    await scheduler.idle()
    expect(store.runs[0]).toMatchObject({
      status: 'error',
      error: 'cleanup failed for 1 project(s)',
      stats: { staled: 2, failed_projects: 1 },
    })
    expect(store.locks.get('cleanup')).toMatchObject({
      lastStatus: 'error',
      lastError: 'cleanup failed for 1 project(s)',
    })
  })

  it('recordOnlyWithWork: no row for an idle run, a row once the handler marks work', async () => {
    let work = false
    const { clock, store, scheduler } = harness([
      job(
        'embed-pending',
        async (ctx) => {
          if (work) await ctx.markWork()
          return { embedded: work ? 5 : 0 }
        },
        { everyMs: MIN, recordOnlyWithWork: true },
      ),
    ])
    await scheduler.seed()
    await scheduler.tick()
    await scheduler.idle()
    expect(store.runs).toHaveLength(0)
    expect(store.locks.get('embed-pending')?.lastStatus).toBe('ok')
    work = true
    clock.advance(MIN)
    await scheduler.tick()
    await scheduler.idle()
    expect(store.runs).toHaveLength(1)
    expect(store.runs[0]).toMatchObject({ status: 'ok', stats: { embedded: 5 } })
  })

  it('recordOnlyWithWork still records a failed run', async () => {
    const { store, scheduler } = harness([
      job(
        'embed-pending',
        async () => {
          throw new Error('provider down')
        },
        { recordOnlyWithWork: true },
      ),
    ])
    await scheduler.seed()
    await scheduler.tick()
    await scheduler.idle()
    expect(store.runs).toMatchObject([{ status: 'error', error: 'provider down' }])
  })

  it('a lost lease aborts the handler and the run ends in error without touching the new holder', async () => {
    const { store, scheduler } = harness([
      job('reembed', async (ctx) => {
        // another instance took over meanwhile
        const l = store.locks.get('reembed')
        if (l) l.lockedBy = 'other:2'
        await expect(ctx.renewLease()).rejects.toThrow('lease of job reembed was lost')
        expect(ctx.signal.aborted).toBe(true)
        throwIfAborted(ctx.signal)
        return {}
      }),
    ])
    await scheduler.seed()
    await scheduler.tick()
    await scheduler.idle()
    expect(store.runs[0]).toMatchObject({ status: 'error', error: 'lease of job reembed was lost' })
    // the release is guarded by locked_by, so the other holder keeps its lease
    expect(store.locks.get('reembed')).toMatchObject({ lockedBy: 'other:2', lastStatus: null })
  })

  it('passes the wall-clock budget as ctx.deadline and records per-project rows', async () => {
    let seen: JobContext | undefined
    const { clock, store, scheduler } = harness([
      job(
        'embed-pending',
        async (ctx) => {
          seen = ctx
          await ctx.recordProjectRun('00000000-0000-4000-8000-000000000001', { embedded: 1 })
          return {}
        },
        { budgetMs: 4 * MIN },
      ),
    ])
    const start = clock.now()
    await scheduler.seed()
    await scheduler.tick()
    await scheduler.idle()
    expect(seen?.deadline).toBe(start + 4 * MIN)
    expect(store.runs.find((r) => r.projectId !== null)).toMatchObject({
      name: 'embed-pending',
      status: 'ok',
      stats: { embedded: 1 },
    })
  })
})

describe('nudges and run now', () => {
  it('enqueue runs a job that is not due yet, about a second later, with the project hint', async () => {
    const c = counter()
    const { clock, scheduler } = harness([job('reembed', c.handler, { everyMs: HOUR })])
    await scheduler.start()
    clock.advance(30_000)
    await settle()
    expect(c.calls).toHaveLength(1)
    scheduler.enqueue('reembed', { projectId: 'p1' })
    scheduler.enqueue('reembed', { projectId: 'p2' }) // coalesced into one nudge
    clock.advance(1_000)
    await settle()
    expect(c.calls).toHaveLength(2)
    expect(c.calls[1]?.projectIds).toEqual(['p1', 'p2'])
    // the force is spent: the next regular tick does not run it again
    clock.advance(65_000)
    await settle()
    expect(c.calls).toHaveLength(2)
    await scheduler.stop()
  })

  it('runNow starts immediately, skipping the due check, but never alongside a running instance', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let calls = 0
    const { scheduler } = harness([
      job('cleanup', async () => {
        calls++
        await gate
        return {}
      }),
    ])
    await scheduler.seed()
    expect(await scheduler.runNow('cleanup')).toEqual({ started: true })
    expect(await scheduler.runNow('cleanup')).toEqual({ started: false, reason: 'running' })
    release()
    await scheduler.idle()
    expect(await scheduler.runNow('cleanup')).toEqual({ started: true })
    await scheduler.idle()
    expect(calls).toBe(2)
    expect(await scheduler.runNow('purge-ephemeral')).toEqual({ started: false, reason: 'unknown_job' })
  })

  it('SPOOR_JOBS=off: start, enqueue and runNow do nothing', async () => {
    const c = counter()
    const { clock, store, scheduler } = harness([job('cleanup', c.handler)], { enabled: false })
    await scheduler.start()
    scheduler.enqueue('cleanup')
    expect(await scheduler.runNow('cleanup')).toEqual({ started: false, reason: 'disabled' })
    clock.advance(10 * MIN)
    await settle()
    expect(c.calls).toHaveLength(0)
    expect(store.locks.size).toBe(0)
    expect(clock.pending()).toEqual([])
  })
})

describe('graceful shutdown', () => {
  it('stops ticking, aborts the running handler and waits for it', async () => {
    let sawAbort = false
    const { clock, store, scheduler } = harness([
      job('cleanup', async (ctx) => {
        await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()))
        sawAbort = true
        throwIfAborted(ctx.signal)
        return {}
      }),
    ])
    await scheduler.start()
    clock.advance(30_000)
    await settle()
    expect(scheduler.runningJobs()).toEqual(['cleanup'])
    await scheduler.stop()
    expect(sawAbort).toBe(true)
    expect(clock.pending()).toEqual([])
    expect(store.runs[0]).toMatchObject({ status: 'error', error: 'shutting down' })
    expect(store.locks.get('cleanup')?.lockedUntil).toBe(Number.NEGATIVE_INFINITY)
  })

  it('gives up after the timeout and releases the lease of a handler that ignores the signal', async () => {
    const { clock, store, scheduler } = harness([job('cleanup', () => new Promise<JobStats>(() => {}))], {
      shutdownTimeoutMs: 25_000,
    })
    await scheduler.seed()
    await scheduler.tick()
    await settle()
    const stopping = scheduler.stop()
    await settle()
    clock.advance(24_999)
    await settle()
    let done = false
    void stopping.then(() => {
      done = true
    })
    await settle()
    expect(done).toBe(false)
    clock.advance(1)
    await stopping
    expect(store.runs[0]).toMatchObject({ status: 'error', error: 'interrupted by shutdown' })
    expect(store.locks.get('cleanup')).toMatchObject({
      lockedUntil: Number.NEGATIVE_INFINITY,
      lastStatus: 'error',
      lastError: 'interrupted by shutdown',
    })
    expect(scheduler.runningJobs()).toEqual([])
  })

  it('after stop, nudges and ticks are ignored', async () => {
    const c = counter()
    const { clock, scheduler } = harness([job('cleanup', c.handler)])
    await scheduler.start()
    await scheduler.stop()
    scheduler.enqueue('cleanup')
    await scheduler.tick()
    clock.advance(10 * MIN)
    await settle()
    expect(c.calls).toHaveLength(0)
    expect(await scheduler.runNow('cleanup')).toEqual({ started: false, reason: 'stopped' })
  })
})

describe('store failures', () => {
  it('a failing history write still releases the lease', async () => {
    const clock = new FakeClock()
    const store = new MemoryJobStore(clock)
    store.insertRun = async () => {
      throw new Error('db down')
    }
    const { scheduler } = harness([job('cleanup', async () => ({}))], { clock, store })
    await scheduler.seed()
    await scheduler.tick()
    await scheduler.idle()
    expect(store.locks.get('cleanup')).toMatchObject({
      lockedUntil: Number.NEGATIVE_INFINITY,
      lastStatus: 'error',
      lastError: 'db down',
    })
    expect(scheduler.runningJobs()).toEqual([])
  })

  it('a failing lease attempt is logged and the other jobs still get their turn', async () => {
    const clock = new FakeClock()
    const store = new MemoryJobStore(clock)
    const real = store.tryLease.bind(store)
    store.tryLease = async (r) => {
      if (r.name === 'cleanup') throw new Error('db down')
      return real(r)
    }
    const c = counter()
    const { scheduler } = harness([job('cleanup', c.handler), job('purge-ephemeral', c.handler)], {
      clock,
      store,
    })
    await scheduler.seed()
    await scheduler.tick()
    await scheduler.idle()
    expect(c.calls.map((x) => x.name)).toEqual(['purge-ephemeral'])
  })
})
