/**
 * The project dashboard (api.md section 4.1, web-ui.md `/projects/:slug`): item counts per space and
 * lifecycle, the review-queue counts and the last 15 content or lifecycle changes. Read only; it lives next
 * to the review queue because it reuses its counts.
 *
 * `recent` reads the audit log (index `audit_project_idx`), not `item_revisions`: one source carries both
 * content revisions (`item.create|update|supersede|push`) and the lifecycle transitions the cleanup job and
 * the web write (`item.stale|archive|expire|restore`), with the same actor fields. Rows of deleted items are
 * left out (the item join).
 */
import {
  type ActorJson,
  type AUDIT_VIAS,
  DASHBOARD_CHANGES,
  type DashboardChange,
  type DashboardResponse,
  type LifecycleCounts,
} from '@spoor/shared'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { auditLog, items } from '../../db/schema.js'
import type { ServerDeps } from '../../lib/deps.js'
import { loadItems, summaryJson } from '../items/index.js'
import type { ProjectAccess } from '../projects/index.js'
import type { ReviewService } from './review.js'

export const DASHBOARD_RECENT = 15
const RECENT_ACTIONS = DASHBOARD_CHANGES.map((c) => `item.${c}`)

const zero = (): LifecycleCounts => ({ active: 0, stale: 0, archived: 0 })

export class DashboardService {
  constructor(
    private readonly deps: ServerDeps,
    private readonly review: ReviewService,
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
    return { counts, review, recent }
  }
}
