/**
 * Reading the audit log (api.md section 10). Writing is `writeAudit` in src/lib/audit.ts, called by every
 * mutation in its own transaction. Rows are append-only; items deleted since keep their handle snapshot.
 */
import { AUDIT_VIAS, type AuditRowJson, formatHandle, parseHandle } from '@spoor/shared'
import { and, desc, eq, gte, ilike, isNull, like, lt, or, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { auditLog } from '../../db/schema.js'
import { escapeLike } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError } from '../../lib/errors.js'
import { decodeTypedCursor, page, paginationQuery } from '../../lib/pagination.js'
import { assertCan, type UserContext, webPrincipal } from '../auth/index.js'
import { resolveItemRef } from '../items/index.js'
import type { ProjectAccess } from '../projects/index.js'

const filterText = z.string().min(1).max(200)
const filters = {
  /** Repeatable; a value ending in `.` is a prefix (`item.` matches every item action). */
  action: z.union([filterText, z.array(filterText).max(20)]).optional(),
  /** Label substring, case-insensitive. */
  actor: filterText.optional(),
  via: z.enum(AUDIT_VIAS).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
  ...paginationQuery,
}

export const projectAuditQuery = z.strictObject({ ...filters, item: filterText.optional() })
export const instanceAuditQuery = z.strictObject(filters)

type ProjectAuditQuery = z.output<typeof projectAuditQuery>
type InstanceAuditQuery = z.output<typeof instanceAuditQuery>
type Row = typeof auditLog.$inferSelect

export function auditRowJson(r: Row): AuditRowJson {
  return {
    id: r.id,
    at: r.at.toISOString(),
    actor: { user_id: r.actorUserId, label: r.actorLabel, via: r.via, client_name: r.clientName },
    action: r.action,
    item_handle: r.itemHandle,
    item_id: r.itemId,
    summary: r.summary,
    data: r.data,
  }
}

function commonConditions(q: InstanceAuditQuery): SQL[] {
  const conds: (SQL | undefined)[] = []
  if (q.action !== undefined) {
    const actions = Array.isArray(q.action) ? q.action : [q.action]
    conds.push(
      or(
        ...actions.map((a) =>
          a.endsWith('.') ? like(auditLog.action, `${escapeLike(a)}%`) : eq(auditLog.action, a),
        ),
      ),
    )
  }
  if (q.actor !== undefined) conds.push(ilike(auditLog.actorLabel, `%${escapeLike(q.actor)}%`))
  if (q.via !== undefined) conds.push(eq(auditLog.via, q.via))
  if (q.since !== undefined) conds.push(gte(auditLog.at, new Date(q.since)))
  if (q.until !== undefined) conds.push(lt(auditLog.at, new Date(q.until)))
  if (q.cursor !== undefined) {
    const [id] = decodeTypedCursor(q.cursor, ['int'] as const)
    conds.push(lt(auditLog.id, id))
  }
  return conds.filter((c): c is SQL => c !== undefined)
}

export class AuditService {
  constructor(private readonly deps: ServerDeps) {}

  async #page(where: SQL | undefined, limit: number) {
    const rows = await this.deps.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.id))
      .limit(limit + 1)
    return page(rows, limit, (r) => [r.id], auditRowJson)
  }

  /** Members (any role) and instance admins; `_shared`: any logged-in user. Newest first, cursor on id. */
  async listProject(access: ProjectAccess, q: ProjectAuditQuery) {
    access.assert('project.read')
    const conds = [eq(auditLog.projectId, access.project.id), ...commonConditions(q)]
    if (q.item !== undefined) {
      const byItem = await this.#itemCondition(access, q.item)
      if (byItem === null) return { items: [], next_cursor: null }
      conds.push(byItem)
    }
    return this.#page(and(...conds), q.limit)
  }

  /** Instance-level rows (`project_id IS NULL`: users, invites, projects); instance admins only. */
  async listInstance(ctx: UserContext, q: InstanceAuditQuery) {
    assertCan(webPrincipal(ctx.user, null), 'users.manage')
    return this.#page(and(isNull(auditLog.projectId), ...commonConditions(q)), q.limit)
  }

  /**
   * `item=<ref>`: a live item by id (resolved in this project only); a handle of an item deleted since by its
   * snapshot; anything else that resolves to nothing matches no row.
   */
  async #itemCondition(access: ProjectAccess, ref: string): Promise<SQL | null> {
    try {
      const item = await resolveItemRef(
        this.deps.db,
        { projectId: access.project.id, projectIsShared: access.shared, mode: 'write' },
        ref,
      )
      return eq(auditLog.itemId, item.id)
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'not_found') throw err
      const h = parseHandle(ref)
      if (!h || h.shared) return null
      return eq(auditLog.itemHandle, formatHandle(h.kind, h.number))
    }
  }
}
