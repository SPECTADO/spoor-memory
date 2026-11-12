/**
 * The instance usage page (`GET /api/v1/status/usage`, IA; api.md section 10.4, ADR-0033). Agent traffic comes
 * from the request log (MCP and CLI calls only, not web UI use; kept 14 days), content writes from
 * `item_revisions` and `items`, host resources from `resource_samples` (the `resource-sample` job). Days are
 * UTC and gap-free; resource points are fixed-width buckets, null where a bucket has no sample.
 */

import os from 'node:os'
import {
  REQUEST_LOG_KEEP_DAYS,
  RESOURCE_METRICS,
  RESOURCE_SAMPLE_EVERY_S,
  type ResourceMetric,
  type ResourcePointJson,
  type ResourceSummaryJson,
  USAGE_BUCKET_S,
  USAGE_RANGE_S,
  USAGE_RANGES,
  type UsageClientJson,
  type UsageDayJson,
  type UsageJson,
  type UsageOperationJson,
  type UsageProjectJson,
  type UsageRange,
  type UsageSurfaceJson,
} from '@spoor/shared'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { ServerDeps } from '../../lib/deps.js'

export const usageQuery = z.strictObject({ range: z.enum(USAGE_RANGES).default('24h') })

const DAY_MS = 86_400_000
const BY_PROJECT_LIMIT = 100
const BY_OPERATION_LIMIT = 50
const BY_CLIENT_LIMIT = 30

/** Metric → column and how a chart bucket combines its samples (CPU and load average, the rest peak). */
const COLUMNS: Record<ResourceMetric, { col: string; agg: 'avg' | 'max'; digits: number }> = {
  cpu_percent: { col: 'cpu_percent', agg: 'avg', digits: 1 },
  load_avg_1: { col: 'load_avg1', agg: 'avg', digits: 2 },
  rss_bytes: { col: 'rss_bytes', agg: 'max', digits: 0 },
  heap_used_bytes: { col: 'heap_used_bytes', agg: 'max', digits: 0 },
  event_loop_delay_ms: { col: 'event_loop_delay_ms', agg: 'max', digits: 2 },
  db_size_bytes: { col: 'db_size_bytes', agg: 'max', digits: 0 },
  db_connections: { col: 'db_connections', agg: 'max', digits: 0 },
  pool_total: { col: 'pool_total', agg: 'max', digits: 0 },
  pool_waiting: { col: 'pool_waiting', agg: 'max', digits: 0 },
  mcp_sessions: { col: 'mcp_sessions', agg: 'max', digits: 0 },
  embeddings_pending: { col: 'embeddings_pending', agg: 'max', digits: 0 },
}

const int = (v: unknown) => Number(v ?? 0)
function num(v: unknown, digits: number): number | null {
  if (v === null || v === undefined) return null
  const f = 10 ** digits
  return Math.round(Number(v) * f) / f
}
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const tsJson = (col: string) => sql.raw(`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`)

export class UsageService {
  constructor(private readonly deps: ServerDeps) {}

  async get(range: UsageRange, now = Date.now()): Promise<UsageJson> {
    const { db } = this.deps
    const days = REQUEST_LOG_KEEP_DAYS
    const today = Math.floor(now / DAY_MS) * DAY_MS
    const from = isoDay(today - (days - 1) * DAY_MS)
    const to = isoDay(today)
    const start = `${from}T00:00:00Z`
    const actor = sql.raw('coalesce(actor_user_id::text, actor_label)')

    const [perDay, totals, content, byProject, byOperation, byClient, bySurface, resources] =
      await Promise.all([
        db.execute<Record<string, string | number>>(sql`
        WITH days AS (
          SELECT d::date AS day FROM generate_series(${from}::date, ${to}::date, interval '1 day') AS d
        ), r AS (
          SELECT (at AT TIME ZONE 'UTC')::date AS day,
            count(*) FILTER (WHERE kind = 'read') AS reads,
            count(*) FILTER (WHERE kind = 'write') AS writes,
            count(*) FILTER (WHERE operation = 'spoor_search') AS searches,
            count(DISTINCT ${actor}) AS people,
            count(DISTINCT token_id) AS tokens
          FROM request_log WHERE at >= ${start}::timestamptz GROUP BY 1
        ), rv AS (
          SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n
          FROM item_revisions WHERE created_at >= ${start}::timestamptz GROUP BY 1
        ), ic AS (
          SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n
          FROM items WHERE created_at >= ${start}::timestamptz GROUP BY 1
        )
        SELECT to_char(days.day, 'YYYY-MM-DD') AS day, coalesce(r.reads, 0) AS reads,
          coalesce(r.writes, 0) AS writes, coalesce(r.searches, 0) AS searches, coalesce(r.people, 0) AS people,
          coalesce(r.tokens, 0) AS tokens, coalesce(rv.n, 0) AS revisions, coalesce(ic.n, 0) AS items_created
        FROM days LEFT JOIN r USING (day) LEFT JOIN rv USING (day) LEFT JOIN ic USING (day)
        ORDER BY days.day`),
        db.execute<Record<string, string | number>>(sql`SELECT count(*) AS requests,
          count(*) FILTER (WHERE kind = 'read') AS reads,
          count(*) FILTER (WHERE kind = 'write') AS writes,
          count(*) FILTER (WHERE operation = 'spoor_search') AS searches,
          count(*) FILTER (WHERE outcome <> 'ok') AS errors,
          count(DISTINCT ${actor}) AS people,
          count(DISTINCT token_id) AS tokens,
          count(DISTINCT client_name) AS clients,
          count(DISTINCT project_id) AS projects
        FROM request_log WHERE at >= ${start}::timestamptz`),
        db.execute<Record<string, string | number>>(sql`SELECT
          (SELECT count(*) FROM item_revisions WHERE created_at >= ${start}::timestamptz) AS revisions,
          (SELECT count(*) FROM items WHERE created_at >= ${start}::timestamptz) AS items_created`),
        db.execute<Record<string, string | number>>(sql`SELECT p.slug, p.name,
          count(*) FILTER (WHERE r.kind = 'read') AS reads,
          count(*) FILTER (WHERE r.kind = 'write') AS writes,
          ${tsJson('max(r.at)')} AS last_at
        FROM request_log r JOIN projects p ON p.id = r.project_id
        WHERE r.at >= ${start}::timestamptz
        GROUP BY p.id, p.slug, p.name ORDER BY count(*) DESC, p.slug LIMIT ${BY_PROJECT_LIMIT}`),
        db.execute<Record<string, string | number>>(sql`SELECT operation, surface, kind, count(*) AS requests,
          count(*) FILTER (WHERE outcome <> 'ok') AS errors,
          avg(duration_ms) AS avg_ms,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
        FROM request_log WHERE at >= ${start}::timestamptz
        GROUP BY 1, 2, 3 ORDER BY count(*) DESC, 1 LIMIT ${BY_OPERATION_LIMIT}`),
        db.execute<{ client: string | null; requests: string; people: string }>(sql`SELECT
          nullif(split_part(client_name, '/', 1), '') AS client, count(*) AS requests,
          count(DISTINCT ${actor}) AS people
        FROM request_log WHERE at >= ${start}::timestamptz
        GROUP BY 1 ORDER BY count(*) DESC, 1 NULLS LAST LIMIT ${BY_CLIENT_LIMIT}`),
        db.execute<Record<string, string | number>>(sql`SELECT surface,
          count(*) FILTER (WHERE kind = 'read') AS reads,
          count(*) FILTER (WHERE kind = 'write') AS writes
        FROM request_log WHERE at >= ${start}::timestamptz GROUP BY 1 ORDER BY 1`),
        this.resources(range, now),
      ])

    const t = totals.rows[0] ?? {}
    const c = content.rows[0] ?? {}
    return {
      generated_at: new Date(now).toISOString(),
      window: { days, from, to },
      totals: {
        requests: int(t.requests),
        reads: int(t.reads),
        writes: int(t.writes),
        searches: int(t.searches),
        errors: int(t.errors),
        people: int(t.people),
        tokens: int(t.tokens),
        clients: int(t.clients),
        projects: int(t.projects),
        revisions: int(c.revisions),
        items_created: int(c.items_created),
      },
      per_day: perDay.rows.map(
        (r): UsageDayJson => ({
          day: String(r.day),
          reads: int(r.reads),
          writes: int(r.writes),
          searches: int(r.searches),
          people: int(r.people),
          tokens: int(r.tokens),
          revisions: int(r.revisions),
          items_created: int(r.items_created),
        }),
      ),
      by_project: byProject.rows.map(
        (r): UsageProjectJson => ({
          slug: String(r.slug),
          name: String(r.name),
          reads: int(r.reads),
          writes: int(r.writes),
          last_at: String(r.last_at),
        }),
      ),
      by_operation: byOperation.rows.map(
        (r): UsageOperationJson => ({
          operation: String(r.operation),
          surface: String(r.surface),
          kind: String(r.kind),
          requests: int(r.requests),
          errors: int(r.errors),
          avg_ms: Math.round(Number(r.avg_ms ?? 0)),
          p95_ms: Math.round(Number(r.p95_ms ?? 0)),
        }),
      ),
      by_client: byClient.rows.map(
        (r): UsageClientJson => ({ client: r.client, requests: int(r.requests), people: int(r.people) }),
      ),
      by_surface: bySurface.rows.map(
        (r): UsageSurfaceJson => ({ surface: String(r.surface), reads: int(r.reads), writes: int(r.writes) }),
      ),
      resources,
    }
  }

  /** Host samples of the range in fixed buckets, plus current / min / max per metric over the raw samples. */
  async resources(range: UsageRange, now = Date.now()): Promise<UsageJson['resources']> {
    const { db, config } = this.deps
    const bucket = USAGE_BUCKET_S[range]
    const count = USAGE_RANGE_S[range] / bucket
    const lastBucket = Math.floor(now / 1000 / bucket) * bucket
    const firstBucket = lastBucket - (count - 1) * bucket
    const startIso = new Date(firstBucket * 1000).toISOString()
    const endIso = new Date(lastBucket * 1000).toISOString()
    const step = sql`make_interval(secs => ${bucket}::int)`
    const bucketCols = sql.join(
      RESOURCE_METRICS.map((m) => sql.raw(`${COLUMNS[m].agg}(s.${COLUMNS[m].col}) AS ${m}`)),
      sql`, `,
    )
    const summaryCols = sql.join(
      RESOURCE_METRICS.map((m) =>
        sql.raw(`min(${COLUMNS[m].col}) AS ${m}_min, max(${COLUMNS[m].col}) AS ${m}_max`),
      ),
      sql`, `,
    )
    const latestCols = sql.join(
      RESOURCE_METRICS.map((m) => sql.raw(`${COLUMNS[m].col} AS ${m}`)),
      sql`, `,
    )
    const [points, summary, latest] = await Promise.all([
      db.execute<Record<string, string | number | null>>(sql`
        WITH b AS (SELECT generate_series(${startIso}::timestamptz, ${endIso}::timestamptz, ${step}) AS t)
        SELECT ${sql.raw(`to_char(b.t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`)} AS at, ${bucketCols}
        FROM b LEFT JOIN resource_samples s ON s.at >= b.t AND s.at < b.t + ${step}
        GROUP BY b.t ORDER BY b.t`),
      db.execute<Record<string, string | number | null>>(
        sql`SELECT count(*) AS samples, ${summaryCols} FROM resource_samples WHERE at >= ${startIso}::timestamptz`,
      ),
      db.execute<Record<string, string | number | null>>(sql`SELECT ${tsJson('at')} AS at, host, ${latestCols}
        FROM resource_samples WHERE at >= ${startIso}::timestamptz ORDER BY at DESC, id DESC LIMIT 1`),
    ])
    const s = summary.rows[0] ?? {}
    const l = latest.rows[0]
    const metrics = Object.fromEntries(
      RESOURCE_METRICS.map((m): [ResourceMetric, ResourceSummaryJson] => {
        const d = COLUMNS[m].digits
        return [m, { current: num(l?.[m], d), min: num(s[`${m}_min`], d), max: num(s[`${m}_max`], d) }]
      }),
    ) as Record<ResourceMetric, ResourceSummaryJson>
    return {
      range,
      bucket_s: bucket,
      interval_s: RESOURCE_SAMPLE_EVERY_S,
      from: startIso,
      to: new Date(Math.min(now, (lastBucket + bucket) * 1000)).toISOString(),
      samples: int(s.samples),
      last_sample_at: l ? String(l.at) : null,
      host: l ? String(l.host) : null,
      pool_max: config.SPOOR_DB_POOL_MAX,
      cpus: os.availableParallelism(),
      points: points.rows.map((r) => {
        const p = { at: String(r.at) } as ResourcePointJson
        for (const m of RESOURCE_METRICS) p[m] = num(r[m], COLUMNS[m].digits)
        return p
      }),
      metrics,
    }
  }
}
