/**
 * The `resource-sample` job's work (ADR-0033): one `resource_samples` row with how this process and its
 * database are doing right now. CPU is the process's user + system time since the previous sample, as a
 * percent of one core (`top` style, so it can pass 100 on several cores). The event-loop delay is the p99 of
 * a `monitorEventLoopDelay` histogram since the previous sample; the first sample after start has none.
 */
import os from 'node:os'
import { type IntervalHistogram, monitorEventLoopDelay } from 'node:perf_hooks'
import { sql } from 'drizzle-orm'
import { resourceSamples } from '../../db/schema.js'
import type { ServerDeps } from '../../lib/deps.js'
import type { StatusSources } from './service.js'

/** `pg.Pool` counters, when the drizzle handle exposes its pool. */
export interface PoolCounters {
  total: number | null
  idle: number | null
  waiting: number | null
}

export function poolCounters(db: unknown): PoolCounters {
  const pool = (db as { $client?: { totalCount?: number; idleCount?: number; waitingCount?: number } })
    .$client
  return {
    total: pool?.totalCount ?? null,
    idle: pool?.idleCount ?? null,
    waiting: pool?.waitingCount ?? null,
  }
}

/** The CPU share between two `process.cpuUsage()` readings, percent of one core; null for no elapsed time. */
export function cpuPercent(prev: NodeJS.CpuUsage, now: NodeJS.CpuUsage, elapsedMs: number): number | null {
  if (!(elapsedMs > 0)) return null
  const usedUs = now.user - prev.user + (now.system - prev.system)
  return Math.max(0, Math.round((usedUs / 1000 / elapsedMs) * 1000) / 10)
}

export type ResourceSampleRow = typeof resourceSamples.$inferInsert

export class ResourceSampler {
  #prevCpu = process.cpuUsage()
  #prevAt = performance.now()
  #loop: IntervalHistogram | null = null

  constructor(
    private readonly deps: Pick<ServerDeps, 'db'>,
    private readonly sources: Pick<StatusSources, 'mcpSessions'>,
  ) {}

  /** Read the current values (and restart the CPU and event-loop windows). */
  async read(): Promise<ResourceSampleRow> {
    const nowCpu = process.cpuUsage()
    const nowAt = performance.now()
    const cpu = cpuPercent(this.#prevCpu, nowCpu, nowAt - this.#prevAt)
    this.#prevCpu = nowCpu
    this.#prevAt = nowAt
    let loopMs: number | null = null
    if (this.#loop === null) {
      // started on the first sample, so app instances that never sample (tests) run no histogram timer
      this.#loop = monitorEventLoopDelay({ resolution: 20 })
      this.#loop.enable()
    } else {
      if (this.#loop.count > 0) loopMs = Math.round(this.#loop.percentile(99) / 1e4) / 100
      this.#loop.reset()
    }
    const res = await this.deps.db.execute<{ size: string; connections: number; pending: number }>(
      sql`SELECT pg_database_size(current_database()) AS size,
        (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections,
        (SELECT count(*)::int FROM chunks WHERE embedding IS NULL) AS pending`,
    )
    const row = res.rows[0]
    const mem = process.memoryUsage()
    const pool = poolCounters(this.deps.db)
    return {
      host: os.hostname(),
      cpuPercent: cpu,
      loadAvg1: os.loadavg()[0] ?? 0,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      eventLoopDelayMs: loopMs,
      dbSizeBytes: Number(row?.size ?? 0),
      dbConnections: Number(row?.connections ?? 0),
      poolTotal: pool.total,
      poolWaiting: pool.waiting,
      mcpSessions: this.sources.mcpSessions(),
      embeddingsPending: Number(row?.pending ?? 0),
    }
  }

  /** The job handler: write one sample. */
  async sample(): Promise<{ samples: number }> {
    const row = await this.read()
    await this.deps.db.insert(resourceSamples).values(row)
    return { samples: 1 }
  }
}
