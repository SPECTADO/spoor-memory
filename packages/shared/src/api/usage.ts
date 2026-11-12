/**
 * The instance usage page (`GET /api/v1/status/usage`, IA; api.md section 10.4, ADR-0033): agent traffic of the
 * last 14 UTC days from the request log, content written per day, and host resource samples over time.
 */

/** Resource samples older than this are deleted by the `purge-ephemeral` job. */
export const RESOURCE_SAMPLE_KEEP_DAYS = 14

/** The `resource-sample` job writes one row this often. */
export const RESOURCE_SAMPLE_EVERY_S = 300

/** Chart windows of `?range=`: one day in 15-minute buckets, or 14 days in 2-hour buckets. */
export const USAGE_RANGES = ['24h', '14d'] as const
export type UsageRange = (typeof USAGE_RANGES)[number]
export const USAGE_BUCKET_S: Record<UsageRange, number> = { '24h': 900, '14d': 7200 }
export const USAGE_RANGE_S: Record<UsageRange, number> = { '24h': 86_400, '14d': 14 * 86_400 }

/** The sampled host metrics, in the order the page shows them. */
export const RESOURCE_METRICS = [
  'cpu_percent',
  'load_avg_1',
  'rss_bytes',
  'heap_used_bytes',
  'event_loop_delay_ms',
  'db_size_bytes',
  'db_connections',
  'pool_total',
  'pool_waiting',
  'mcp_sessions',
  'embeddings_pending',
] as const
export type ResourceMetric = (typeof RESOURCE_METRICS)[number]

/** One UTC day of agent traffic and content writes. */
export interface UsageDayJson {
  /** `YYYY-MM-DD` (UTC). */
  day: string
  reads: number
  writes: number
  /** `spoor_search` calls (part of `reads`). */
  searches: number
  /** Distinct people (or service tokens) that made a request. */
  people: number
  tokens: number
  /** Item revisions written (any surface, web included). */
  revisions: number
  items_created: number
}

export interface UsageTotalsJson {
  requests: number
  reads: number
  writes: number
  searches: number
  /** Requests whose outcome was not `ok`. */
  errors: number
  people: number
  tokens: number
  clients: number
  /** Projects with at least one agent request. */
  projects: number
  revisions: number
  items_created: number
}

export interface UsageProjectJson {
  slug: string
  name: string
  reads: number
  writes: number
  last_at: string
}

export interface UsageOperationJson {
  operation: string
  surface: string
  kind: string
  requests: number
  errors: number
  avg_ms: number
  p95_ms: number
}

export interface UsageClientJson {
  /** The agent name without its version (`claude-code`), or null when the client sent none. */
  client: string | null
  requests: number
  people: number
}

export interface UsageSurfaceJson {
  surface: string
  reads: number
  writes: number
}

/** One chart bucket: averages (CPU, load) or maxima (the rest) of the samples in it; null without samples. */
export type ResourcePointJson = { at: string } & Record<ResourceMetric, number | null>

export interface ResourceSummaryJson {
  /** The newest sample's value. */
  current: number | null
  min: number | null
  max: number | null
}

export interface ResourcesJson {
  range: UsageRange
  /** Seconds per chart point. */
  bucket_s: number
  /** Seconds between two samples. */
  interval_s: number
  from: string
  to: string
  samples: number
  last_sample_at: string | null
  /** The host of the newest sample (the instance that holds the job's lease). */
  host: string | null
  pool_max: number
  cpus: number
  points: ResourcePointJson[]
  metrics: Record<ResourceMetric, ResourceSummaryJson>
}

/** `GET /api/v1/status/usage?range=24h|14d`. */
export interface UsageJson {
  generated_at: string
  /** The UTC days covered, oldest first; the request log keeps 14 days, so the first day may be partial. */
  window: { days: number; from: string; to: string }
  totals: UsageTotalsJson
  per_day: UsageDayJson[]
  by_project: UsageProjectJson[]
  by_operation: UsageOperationJson[]
  by_client: UsageClientJson[]
  by_surface: UsageSurfaceJson[]
  resources: ResourcesJson
}
