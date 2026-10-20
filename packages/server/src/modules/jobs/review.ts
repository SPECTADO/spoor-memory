/**
 * The review queue, read side (cleanup-and-jobs.md section 6, api.md section 8): counts and the five
 * sections (stale, archived in the last 30 days, observations expiring within 48 h, open conflicts, push
 * conflicts), plus the bearer list of undrafted decision memories (api.md section 7.2) the Stop hook drafts
 * ADRs from. Listing only: every action (verify, archive, restore, supersede, delete, bulk) belongs to the
 * items module and reuses its endpoints.
 */

import {
  type ItemSummary,
  REVIEW_SECTIONS,
  type ReviewCounts,
  type ReviewSection,
  type UndraftedDecisionsResponse,
} from '@spoor/shared'
import { type AnyColumn, and, asc, desc, eq, inArray, isNotNull, type SQL, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { edges, items, projects } from '../../db/schema.js'
import type { AuthContext } from '../../lib/auth-context.js'
import type { ServerDeps } from '../../lib/deps.js'
import { cursorTimestamp, decodeTypedCursor, page, paginationQuery } from '../../lib/pagination.js'
import {
  itemHandle,
  type LoadedItem,
  loadedColumns,
  loadItems,
  summaryJson,
  toLoadedItem,
} from '../items/index.js'
import { type ProjectAccess, resolveSettings } from '../projects/index.js'
import { daysToArchive, type LifecycleState, usedSinceStale } from './lifecycle.js'

export { REVIEW_SECTIONS, type ReviewSection }

export const reviewListQuery = z.strictObject(paginationQuery)
export const undraftedQuery = z.strictObject({
  since: z.iso.datetime({ offset: true }).optional(),
  mine: z.enum(['true', 'false']).default('true'),
})
/** The cookie twin lists the whole project by default (`mine=true`: the caller's own). */
export const webUndraftedQuery = z.strictObject({
  since: z.iso.datetime({ offset: true }).optional(),
  mine: z.enum(['true', 'false']).default('false'),
})

/** Who asks for `decisions/undrafted`: a bearer context, or a cookie user's project access. */
export interface UndraftedScope {
  project: { id: string }
  user?: { id: string } | null
  tokenId?: string
}

/** "Recently archived" window and "expiring" horizon (cleanup-and-jobs.md section 6). */
const ARCHIVED_WINDOW = sql`interval '30 days'`
const EXPIRING_HORIZON = sql`interval '48 hours'`
/** `decisions/undrafted`: default and floor of `since`. */
const UNDRAFTED_DAYS = 14
const UNDRAFTED_MAX = 200

function lifecycleOf(r: LoadedItem): LifecycleState {
  const ms = (d: Date | null) => (d === null ? null : d.getTime())
  return {
    space: r.space,
    type: r.type,
    status: r.status,
    lifecycle: r.lifecycle,
    pinned: r.pinned,
    lastVerifiedAt: r.lastVerifiedAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
    lastUsedAt: ms(r.lastUsedAt),
    expiresAt: ms(r.expiresAt),
    staleSince: ms(r.staleSince),
    archivedAt: ms(r.archivedAt),
    archiveReason: r.archiveReason,
  }
}

const nowMs = sql<number>`(extract(epoch from now()) * 1000)::float8`.mapWith(Number)

/** Both ends not archived and active / accepted (the same rule as the project list's `review_total`). */
const live = (t: { lifecycle: AnyColumn; status: AnyColumn }) =>
  sql`${t.lifecycle} <> 'archived' AND ${t.status} IN ('active', 'accepted')`

interface SectionSpec {
  where: SQL
  /** Sort column (a timestamptz), then id in the same direction. */
  sort:
    | typeof items.staleSince
    | typeof items.archivedAt
    | typeof items.expiresAt
    | typeof items.pushConflictAt
  dir: 'asc' | 'desc'
}

function sectionSpec(section: Exclude<ReviewSection, 'conflicts'>): SectionSpec {
  switch (section) {
    case 'stale':
      return {
        where: sql`${items.lifecycle} = 'stale' AND ${items.space} <> 'library'`,
        sort: items.staleSince,
        dir: 'asc',
      }
    case 'archived':
      return {
        where: sql`${items.lifecycle} = 'archived' AND ${items.space} <> 'library'
          AND ${items.archivedAt} > now() - ${ARCHIVED_WINDOW}`,
        sort: items.archivedAt,
        dir: 'desc',
      }
    case 'expiring':
      return {
        where: sql`${items.type} = 'observation' AND ${items.lifecycle} = 'active'
          AND ${items.expiresAt} < now() + ${EXPIRING_HORIZON}`,
        sort: items.expiresAt,
        dir: 'asc',
      }
    case 'push_conflicts':
      return { where: isNotNull(items.pushConflictAt), sort: items.pushConflictAt, dir: 'desc' }
  }
}

/** A `[timestamp, uuid]` cursor; anything else is 400 `invalid_input`. */
function decodeTsCursor(cursor: string): [string, string] {
  return decodeTypedCursor(cursor, ['timestamp', 'uuid'] as const)
}

export type BearerContext = AuthContext & { project: NonNullable<AuthContext['project']> }

export class ReviewService {
  constructor(private readonly deps: ServerDeps) {}

  /** `GET /api/v1/projects/:slug/review`. */
  async counts(access: ProjectAccess): Promise<ReviewCounts> {
    access.assert('project.read')
    const p = access.project.id
    const [row] = await this.deps.db
      .select({
        stale: sql<number>`(count(*) FILTER (WHERE ${items.lifecycle} = 'stale'
          AND ${items.space} <> 'library'))::int`,
        archived: sql<number>`(count(*) FILTER (WHERE ${items.lifecycle} = 'archived' AND ${items.space} <> 'library'
          AND ${items.archivedAt} > now() - ${ARCHIVED_WINDOW}))::int`,
        expiring: sql<number>`(count(*) FILTER (WHERE ${items.type} = 'observation'
          AND ${items.lifecycle} = 'active' AND ${items.expiresAt} < now() + ${EXPIRING_HORIZON}))::int`,
        push_conflicts: sql<number>`(count(*) FILTER (WHERE ${items.pushConflictAt} IS NOT NULL))::int`,
      })
      .from(items)
      .where(eq(items.projectId, p))
    const a = alias(items, 'a')
    const b = alias(items, 'b')
    const [conf] = await this.deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(edges)
      .innerJoin(a, eq(a.id, edges.srcId))
      .innerJoin(b, eq(b.id, edges.dstId))
      .where(and(eq(edges.projectId, p), eq(edges.kind, 'conflicts_with'), live(a), live(b)))
    return {
      counts: {
        stale: row?.stale ?? 0,
        archived: row?.archived ?? 0,
        expiring: row?.expiring ?? 0,
        conflicts: conf?.n ?? 0,
        push_conflicts: row?.push_conflicts ?? 0,
      },
    }
  }

  /** `GET /api/v1/projects/:slug/review/:section`. */
  async list(access: ProjectAccess, section: ReviewSection, q: z.output<typeof reviewListQuery>) {
    access.assert('project.read')
    if (section === 'conflicts') return this.#conflicts(access, q)
    const spec = sectionSpec(section)
    const conds: SQL[] = [eq(items.projectId, access.project.id), spec.where]
    if (q.cursor !== undefined) {
      const [at, id] = decodeTsCursor(q.cursor)
      const op = spec.dir === 'asc' ? sql`>` : sql`<`
      conds.push(sql`(${spec.sort}, ${items.id}) ${op} (${at}::timestamptz, ${id}::uuid)`)
    }
    const order = spec.dir === 'asc' ? [asc(spec.sort), asc(items.id)] : [desc(spec.sort), desc(items.id)]
    const rows = await this.deps.db
      .select({
        ...loadedColumns,
        cursorAt: cursorTimestamp(spec.sort),
        nowMs,
        editedVia: sql<string | null>`(SELECT r.via FROM item_revisions r WHERE r.item_id = ${items.id}
          ORDER BY r.revision DESC LIMIT 1)`,
      })
      .from(items)
      .innerJoin(projects, eq(projects.id, items.projectId))
      .where(and(...conds))
      .orderBy(...order)
      .limit(q.limit + 1)
    const cleanup = resolveSettings(access.project.settings).cleanup
    const view = { projectId: access.project.id, projectIsShared: access.shared }
    return page(
      rows.map((r) => ({ ...r, row: toLoadedItem(r) })),
      q.limit,
      (r) => [r.cursorAt, r.row.id],
      ({ row: r, nowMs, editedVia }) => {
        const base = summaryJson(r, view)
        switch (section) {
          case 'stale': {
            const state = lifecycleOf(r)
            return {
              ...base,
              days_to_archive: daysToArchive(state, cleanup, nowMs),
              used_since_stale: usedSinceStale(state),
            }
          }
          case 'expiring':
            return {
              ...base,
              expires_in_s:
                r.expiresAt === null ? null : Math.max(0, Math.floor((r.expiresAt.getTime() - nowMs) / 1000)),
            }
          case 'push_conflicts':
            return {
              ...base,
              edited_by: {
                label: r.updatedByLabel,
                via: editedVia,
                client_name: r.clientName,
                at: r.updatedAt.toISOString(),
              },
            }
          default:
            return base
        }
      },
    )
  }

  async #conflicts(access: ProjectAccess, q: z.output<typeof reviewListQuery>) {
    const a = alias(items, 'a')
    const b = alias(items, 'b')
    const conds: SQL[] = [
      eq(edges.projectId, access.project.id),
      eq(edges.kind, 'conflicts_with'),
      live(a),
      live(b),
    ]
    if (q.cursor !== undefined) {
      const [at, id] = decodeTsCursor(q.cursor)
      conds.push(sql`(${edges.createdAt}, ${edges.id}) < (${at}::timestamptz, ${id}::uuid)`)
    }
    const rows = await this.deps.db
      .select({ edgeId: edges.id, cursorAt: cursorTimestamp(edges.createdAt), aId: a.id, bId: b.id })
      .from(edges)
      .innerJoin(a, eq(a.id, edges.srcId))
      .innerJoin(b, eq(b.id, edges.dstId))
      .where(and(...conds))
      .orderBy(desc(edges.createdAt), desc(edges.id))
      .limit(q.limit + 1)
    const ids = [...new Set(rows.flatMap((r) => [r.aId, r.bId]))]
    const summaries = new Map<string, ItemSummary>()
    if (ids.length > 0) {
      const view = { projectId: access.project.id, projectIsShared: access.shared }
      for (const s of await loadItems(this.deps.db, inArray(items.id, ids)))
        summaries.set(s.id, summaryJson(s, view))
    }
    return page(
      rows,
      q.limit,
      (r) => [r.cursorAt, r.edgeId],
      (r) => ({
        edge_id: r.edgeId,
        a: summaries.get(r.aId) as ItemSummary,
        b: summaries.get(r.bId) as ItemSummary,
      }),
    )
  }

  /**
   * `GET /p/:slug/api/decisions/undrafted`: decision memories (`type='decision'`, active, not archived) with
   * no `drafted_from` edge from a non-superseded ADR, created at or after `since` (default and floor: 14 days
   * ago), oldest first. `mine` limits them to the token's owner; for a service token, to items created
   * through that token (its `item.create` audit rows). The cookie twin (`GET /api/v1/projects/:slug/decisions/undrafted`,
   * the review queue) passes the user's project access.
   */
  async undrafted(
    ctx: UndraftedScope,
    q: z.output<typeof undraftedQuery>,
  ): Promise<UndraftedDecisionsResponse> {
    const mine = q.mine === 'true'
    const floor = sql`now() - make_interval(days => ${UNDRAFTED_DAYS}::int)`
    const since = q.since === undefined ? floor : sql`greatest(${q.since}::timestamptz, ${floor})`
    const conds: SQL[] = [
      eq(items.projectId, ctx.project.id),
      eq(items.space, 'memories'),
      eq(items.type, 'decision'),
      eq(items.status, 'active'),
      sql`${items.lifecycle} <> 'archived'`,
      sql`${items.createdAt} >= ${since}`,
      sql`NOT EXISTS (SELECT 1 FROM edges e JOIN items adr ON adr.id = e.src_id
            WHERE e.kind = 'drafted_from' AND e.dst_id = ${items.id} AND adr.status <> 'superseded')`,
    ]
    if (mine) {
      if (ctx.user) conds.push(eq(items.createdBy, ctx.user.id))
      else if (ctx.tokenId)
        conds.push(sql`EXISTS (SELECT 1 FROM audit_log a WHERE a.item_id = ${items.id}
          AND a.action = 'item.create' AND a.token_id = ${ctx.tokenId}::uuid)`)
      else conds.push(sql`false`)
    }
    const rows = await this.deps.db
      .select({
        id: items.id,
        number: items.number,
        title: items.title,
        body: items.body,
        tags: items.tags,
        anchors: items.anchors,
        confidence: items.confidence,
        createdAt: items.createdAt,
      })
      .from(items)
      .where(and(...conds))
      .orderBy(asc(items.createdAt), asc(items.id))
      .limit(UNDRAFTED_MAX)
    return {
      items: rows.map((r) => ({
        handle: itemHandle({ space: 'memories', number: r.number, adrNumber: null }),
        spoor_id: r.id,
        title: r.title,
        body: r.body,
        tags: r.tags,
        anchors: r.anchors,
        confidence: r.confidence,
        created_at: r.createdAt.toISOString(),
      })),
    }
  }
}
