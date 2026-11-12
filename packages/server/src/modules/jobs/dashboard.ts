/**
 * The project dashboard (api.md section 4.1, web-ui.md `/projects/:slug`): item counts per space and
 * lifecycle, the review-queue counts and the last 15 content or lifecycle changes. Read only; it lives next
 * to the review queue because it reuses its counts.
 *
 * `recent` reads the audit log (index `audit_project_idx`), not `item_revisions`: one source carries both
 * content revisions (`item.create|update|supersede|push`) and the lifecycle transitions the cleanup job and
 * the web write (`item.stale|archive|expire|restore`), with the same actor fields. Rows of deleted items are
 * left out (the item join).
 *
 * `last_requests` is the newest agent read and write of the request log (ADR-0018). Any member sees these
 * two rows; the full log is for admins.
 *
 * `activity` is the newest `DASHBOARD_ACTIVITY` request rows, only for viewers with `requests.read` (project
 * and instance admins); the field is left out for everyone else and on `_shared`.
 *
 * `stats` (counts only, every member): per UTC day of the last 14, agent reads and writes (request log) and
 * item changes (audit log, the `recent` actions), plus a few totals. Two queries: one per-day, one with the
 * scalar totals. The request log is read through `request_log_project_idx` (its rows are at most 14 days
 * old), the audit log through `audit_project_idx`. On `_shared` the request parts are left out.
 *
 * `links` (ADR-0021): live items (active or stale, not superseded or deprecated) with no edge of any kind in
 * either direction, and the distinct dangling wikilink refs written in such items. For `_shared`, incoming
 * edges from every project count (only a number, so no membership filter).
 */
import {
  type ActorJson,
  type AUDIT_VIAS,
  DASHBOARD_ACTIVITY,
  DASHBOARD_CHANGES,
  type DashboardChange,
  type DashboardResponse,
  type DashboardStatsJson,
  type LifecycleCounts,
  REQUEST_LOG_KEEP_DAYS,
} from '@spoor/shared'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { auditLog, edges, items } from '../../db/schema.js'
import type { ServerDeps } from '../../lib/deps.js'
import { loadItems, summaryJson } from '../items/index.js'
import type { ProjectAccess } from '../projects/index.js'
import type { RequestLogService } from '../requests/index.js'
import type { ReviewService } from './review.js'

export const DASHBOARD_RECENT = 15
const RECENT_ACTIONS = DASHBOARD_CHANGES.map((c) => `item.${c}`)

const DAY_MS = 86_400_000
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const int = (v: unknown) => Number(v ?? 0)
const actionList = sql.join(
  RECENT_ACTIONS.map((a) => sql`${a}`),
  sql`, `,
)

const zero = (): LifecycleCounts => ({ active: 0, stale: 0, archived: 0 })

export class DashboardService {
  constructor(
    private readonly deps: ServerDeps,
    private readonly review: ReviewService,
    private readonly requests: RequestLogService,
  ) {}

  /** `GET /api/v1/projects/:slug/dashboard`. */
  async get(access: ProjectAccess): Promise<DashboardResponse> {
    access.assert('project.read')
    const p = access.project.id
    const db = this.deps.db

    const grouped = await db
      .select({ space: items.space, lifecycle: items.lifecycle, n: sql<number>`count(*)::int` })
      .from(items)
      .where(eq(items.projectId, p))
      .groupBy(items.space, items.lifecycle)
    const counts = { memories: zero(), decisions: zero(), docs: zero(), library: zero() }
    for (const g of grouped) {
      const space = counts[g.space as keyof typeof counts]
      if (space && g.lifecycle in space) space[g.lifecycle as keyof LifecycleCounts] = g.n
    }

    const { counts: review } = await this.review.counts(access)

    const rows = await db
      .select({
        itemId: auditLog.itemId,
        action: auditLog.action,
        at: auditLog.at,
        userId: auditLog.actorUserId,
        label: auditLog.actorLabel,
        via: auditLog.via,
        clientName: auditLog.clientName,
      })
      .from(auditLog)
      .innerJoin(items, and(eq(items.id, auditLog.itemId), eq(items.projectId, p)))
      .where(and(eq(auditLog.projectId, p), inArray(auditLog.action, RECENT_ACTIONS)))
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(DASHBOARD_RECENT)
    const ids = [...new Set(rows.map((r) => r.itemId as string))]
    const view = { projectId: p, projectIsShared: access.shared }
    const summaries = new Map(
      ids.length === 0
        ? []
        : (await loadItems(db, inArray(items.id, ids))).map((r) => [r.id, summaryJson(r, view)] as const),
    )
    const recent: DashboardResponse['recent'] = []
    for (const r of rows) {
      const item = summaries.get(r.itemId as string)
      if (!item) continue // deleted between the two reads
      const actor: ActorJson = {
        user_id: r.userId,
        label: r.label,
        via: r.via as (typeof AUDIT_VIAS)[number],
        client_name: r.clientName,
      }
      recent.push({
        item,
        change: r.action.slice('item.'.length) as DashboardChange,
        actor,
        at: r.at.toISOString(),
      })
    }
    const [links, lastRequests, stats, activity] = await Promise.all([
      this.links(p),
      this.requests.last(p),
      this.stats(p, access.shared),
      access.can('requests.read') ? this.requests.latest(p, DASHBOARD_ACTIVITY) : undefined,
    ])
    return {
      counts,
      review,
      recent,
      links,
      last_requests: lastRequests,
      stats,
      ...(activity ? { activity } : {}),
    }
  }

  /** `stats`: the 14-day per-day series and the totals (see the module comment). */
  async stats(projectId: string, shared: boolean, now = Date.now()): Promise<DashboardStatsJson> {
    const db = this.deps.db
    const days = REQUEST_LOG_KEEP_DAYS
    const today = Math.floor(now / DAY_MS) * DAY_MS
    const from = isoDay(today - (days - 1) * DAY_MS)
    const to = isoDay(today)
    const start = `${from}T00:00:00Z`
    const todayStart = `${to}T00:00:00Z`
    const weekStart = `${isoDay(today - 6 * DAY_MS)}T00:00:00Z`
    const changes = sql`project_id = ${projectId} AND at >= ${start}::timestamptz AND action IN (${actionList})`
    const reqs = sql`project_id = ${projectId} AND at >= ${start}::timestamptz`
    const who = sql.raw('coalesce(actor_user_id::text, actor_label)')

    const [perDay, totals] = await Promise.all([
      db.execute<Record<string, string | number>>(sql`
        WITH days AS (
          SELECT d::date AS day FROM generate_series(${from}::date, ${to}::date, interval '1 day') AS d
        ), r AS (
          SELECT (at AT TIME ZONE 'UTC')::date AS day,
            count(*) FILTER (WHERE kind = 'read') AS reads,
            count(*) FILTER (WHERE kind = 'write') AS writes
          FROM request_log WHERE ${reqs} GROUP BY 1
        ), a AS (
          SELECT (at AT TIME ZONE 'UTC')::date AS day, count(*) AS n FROM audit_log WHERE ${changes} GROUP BY 1
        )
        SELECT to_char(days.day, 'YYYY-MM-DD') AS day, coalesce(r.reads, 0) AS reads,
          coalesce(r.writes, 0) AS writes, coalesce(a.n, 0) AS changes
        FROM days LEFT JOIN r USING (day) LEFT JOIN a USING (day)
        ORDER BY days.day`),
      db.execute<Record<string, string | number | null>>(sql`
        WITH r AS (
          SELECT count(*) FILTER (WHERE at >= ${todayStart}::timestamptz) AS today,
            count(*) FILTER (WHERE at >= ${weekStart}::timestamptz) AS week,
            count(DISTINCT coalesce(token_id::text, '') || '/' || coalesce(client_name, '')) AS agents
          FROM request_log WHERE ${reqs}
        )
        SELECT r.today, r.week, r.agents,
          (SELECT count(DISTINCT w) FROM (
             SELECT ${who} AS w FROM request_log WHERE ${reqs}
             UNION SELECT ${who} FROM audit_log WHERE ${changes} AND via <> 'system'
           ) x) AS people,
          (SELECT count(DISTINCT item_id) FROM audit_log
             WHERE ${changes} AND at >= ${weekStart}::timestamptz) AS items_changed,
          (SELECT to_char(last_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             FROM job_locks WHERE name = 'cleanup') AS last_cleanup
        FROM r`),
    ])
    const t = totals.rows[0] ?? {}
    return {
      window: { days, from, to },
      per_day: perDay.rows.map((r) => ({
        day: String(r.day),
        reads: int(r.reads),
        writes: int(r.writes),
        changes: int(r.changes),
      })),
      requests: shared
        ? null
        : { today: int(t.today), last_7_days: int(t.week), agents_14_days: int(t.agents) },
      people_14_days: int(t.people),
      items_changed_7_days: int(t.items_changed),
      last_cleanup_at: typeof t.last_cleanup === 'string' ? t.last_cleanup : null,
    }
  }

  private async links(projectId: string): Promise<DashboardResponse['links']> {
    const live = sql`i.project_id = ${projectId} AND i.lifecycle IN ('active','stale')
      AND i.status NOT IN ('superseded','deprecated')`
    const res = await this.deps.db.execute<{ unlinked: number; dangling: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM ${items} i WHERE ${live}
           AND NOT EXISTS (SELECT 1 FROM ${edges} e WHERE e.src_id = i.id OR e.dst_id = i.id)) AS unlinked,
        (SELECT count(DISTINCT e.dst_ref)::int FROM ${edges} e JOIN ${items} i ON i.id = e.src_id
           WHERE e.dst_id IS NULL AND ${live}) AS dangling`)
    const r = res.rows[0]
    return { unlinked_items: r?.unlinked ?? 0, dangling_refs: r?.dangling ?? 0 }
  }
}
