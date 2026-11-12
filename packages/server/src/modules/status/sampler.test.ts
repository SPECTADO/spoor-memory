import { describe, expect, it } from 'vitest'
import { resourceSampleJob } from '../jobs/definitions.js'
import { cpuPercent, poolCounters } from './sampler.js'

describe('cpuPercent', () => {
  it('is user + system time over wall time, percent of one core, one decimal', () => {
    // 150 ms of CPU in 1 s
    expect(cpuPercent({ user: 0, system: 0 }, { user: 100_000, system: 50_000 }, 1000)).toBe(15)
    // two busy cores
    expect(cpuPercent({ user: 0, system: 0 }, { user: 2_000_000, system: 0 }, 1000)).toBe(200)
    expect(cpuPercent({ user: 0, system: 0 }, { user: 1234, system: 0 }, 1000)).toBe(0.1)
  })

  it('is null without elapsed time', () => {
    expect(cpuPercent({ user: 0, system: 0 }, { user: 5, system: 5 }, 0)).toBeNull()
  })
})

describe('poolCounters', () => {
  it('reads pg.Pool counters, or nulls when the handle has no pool', () => {
    expect(poolCounters({ $client: { totalCount: 3, idleCount: 1, waitingCount: 0 } })).toEqual({
      total: 3,
      idle: 1,
      waiting: 0,
    })
    expect(poolCounters({})).toEqual({ total: null, idle: null, waiting: null })
  })
})

describe('resourceSampleJob', () => {
  it('runs every 5 minutes and records a run only on failure', async () => {
    const def = resourceSampleJob(async () => ({ samples: 1 }))
    expect(def).toMatchObject({ name: 'resource-sample', everyMs: 300_000, recordOnlyWithWork: true })
    // biome-ignore lint/suspicious/noExplicitAny: the handler ignores its context
    expect(await def.handler({} as any)).toEqual({ samples: 1 })
  })
})
