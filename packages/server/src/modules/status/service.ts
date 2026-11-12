/**
 * The instance status page (`GET /api/v1/status`, IA; api.md section 10.4): what this deployment runs (version,
 * Node, embedding providers), how much it holds (records per table, chunk embeddings per model, database and
 * table sizes) and how the process is doing (uptime, memory, load, DB pool, open MCP sessions). Read-only,
 * secret-free: no keys, no URLs with credentials, no item text.
 */
import os from 'node:os'
import { sql } from 'drizzle-orm'
import type { ServerDeps } from '../../lib/deps.js'
import { VERSION } from '../../version.js'

export interface StatusSources {
  /** Open MCP sessions (the mcp module's session table). */
  mcpSessions: () => number
  /** The scheduler runs jobs on this instance (`SPOOR_JOBS=on`). */
  jobsEnabled: () => boolean
}

/** `pg.Pool` counters, when the drizzle handle exposes its pool. */
interface PoolLike {
  totalCount: number
  idleCount: number
  waitingCount: number
}

const n = (v: unknown) => Number(v ?? 0)
const startedAt = new Date(Date.now() - process.uptime() * 1000)

export class StatusService {
  constructor(
    private readonly deps: ServerDeps,
    private readonly sources: StatusSources,
  ) {}

  async get() {
    const { db, config, ports } = this.deps
    const [counts, items, chunks, models, pg, exts, tables] = await Promise.all([
      db.execute<Record<string, string | number>>(sql`SELECT
        (SELECT count(*) FROM projects WHERE kind = 'project') AS projects,
        (SELECT count(*) FROM users) AS users,
        (SELECT count(*) FROM users WHERE disabled_at IS NULL) AS users_active,
        (SELECT count(*) FROM memberships) AS memberships,
        (SELECT count(*) FROM tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS tokens_active,
        (SELECT count(*) FROM sessions WHERE expires_at > now()) AS web_sessions,
        (SELECT count(*) FROM item_revisions) AS revisions,
        (SELECT count(*) FROM edges) AS edges,
        (SELECT count(*) FROM audit_log) AS audit_rows,
        (SELECT count(*) FROM request_log) AS request_log_rows,
        (SELECT count(*) FROM job_runs) AS job_runs`),
      db.execute<{ space: string; lifecycle: string; n: number }>(
        sql`SELECT space, lifecycle, count(*)::int AS n FROM items GROUP BY 1, 2 ORDER BY 1, 2`,
      ),
      db.execute<{ model: string; dims: number; chunks: number; pending: number }>(
        sql`SELECT model, dims, count(*)::int AS chunks, count(*) FILTER (WHERE embedding IS NULL)::int AS pending
          FROM chunks GROUP BY 1, 2 ORDER BY 3 DESC`,
      ),
      db.execute<{ model: string; projects: number; reembedding: number }>(
        sql`SELECT embedding_model AS model, count(*)::int AS projects,
          count(*) FILTER (WHERE embedding_target IS NOT NULL)::int AS reembedding
          FROM projects GROUP BY 1 ORDER BY 2 DESC`,
      ),
      db.execute<{ version: string; database: string; size: string; connections: number }>(
        sql`SELECT current_setting('server_version') AS version, current_database() AS database,
          pg_database_size(current_database()) AS size,
          (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections`,
      ),
      db.execute<{ name: string; version: string }>(
        sql`SELECT extname AS name, extversion AS version FROM pg_extension ORDER BY 1`,
      ),
      db.execute<{ name: string; bytes: string; rows: string }>(
        sql`SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes, greatest(c.reltuples, 0)::bigint AS rows
          FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p') AND ns.nspname = current_schema()
          ORDER BY 2 DESC`,
      ),
    ])

    const c = counts.rows[0] ?? {}
    const itemTotals: Record<string, Record<string, number>> = {}
    for (const r of items.rows) {
      itemTotals[r.space] = { ...itemTotals[r.space], [r.lifecycle]: r.n }
    }
    const pgRow = pg.rows[0]
    const pool = (db as unknown as { $client?: Partial<PoolLike> }).$client
    const mem = process.memoryUsage()
    const def = ports.embeddings.defaultProvider

    return {
      instance: {
        version: VERSION,
        public_url: config.publicOrigin,
        started_at: startedAt.toISOString(),
        uptime_s: Math.round(process.uptime()),
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        hostname: os.hostname(),
        jobs_enabled: this.sources.jobsEnabled(),
      },
      embedding: {
        default: {
          name: def.name,
          model: def.model,
          variant: def.variant,
          dims: def.dims,
          tag: def.tag,
          max_input_tokens: def.maxInputTokens,
        },
        providers: ports.embeddings.list().map((p) => ({
          name: p.name,
          model: p.model,
          dims: p.dims,
          tag: p.tag,
          remote: p.name !== 'local',
        })),
        local_threads: config.SPOOR_EMBED_THREADS,
        chunks: chunks.rows,
        projects_by_model: models.rows,
      },
      records: {
        projects: n(c.projects),
        users: n(c.users),
        users_active: n(c.users_active),
        memberships: n(c.memberships),
        tokens_active: n(c.tokens_active),
        web_sessions: n(c.web_sessions),
        items: itemTotals,
        items_total: items.rows.reduce((a, r) => a + r.n, 0),
        revisions: n(c.revisions),
        edges: n(c.edges),
        chunks: chunks.rows.reduce((a, r) => a + r.chunks, 0),
        chunks_pending: chunks.rows.reduce((a, r) => a + r.pending, 0),
        audit_rows: n(c.audit_rows),
        request_log_rows: n(c.request_log_rows),
        job_runs: n(c.job_runs),
      },
      database: {
        version: pgRow?.version ?? null,
        name: pgRow?.database ?? null,
        size_bytes: n(pgRow?.size),
        connections: pgRow?.connections ?? null,
        extensions: exts.rows,
        tables: tables.rows.map((t) => ({ name: t.name, bytes: n(t.bytes), rows_estimate: n(t.rows) })),
        pool: {
          max: config.SPOOR_DB_POOL_MAX,
          total: pool?.totalCount ?? null,
          idle: pool?.idleCount ?? null,
          waiting: pool?.waitingCount ?? null,
        },
      },
      // the newest release, from the update check's cache (null while off or unknown); never waits on the network
      update: ports.updates.current(),
      runtime: {
        rss_bytes: mem.rss,
        heap_used_bytes: mem.heapUsed,
        heap_total_bytes: mem.heapTotal,
        external_bytes: mem.external,
        load_avg: os.loadavg(),
        cpus: os.availableParallelism(),
        system_memory_bytes: os.totalmem(),
        system_free_bytes: os.freemem(),
        mcp_sessions: this.sources.mcpSessions(),
      },
    }
  }
}

export type StatusJson = Awaited<ReturnType<StatusService['get']>>
