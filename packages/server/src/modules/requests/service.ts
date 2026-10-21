/**
 * Reading the agent request log (api.md 10.3, ADR-0018): the filtered, cursor-paged list for project and
 * instance admins, and the newest read and write for the dashboard. Rows are written by `RequestLog`.
 */
import {
  type LastRequestJson,
  REQUEST_KINDS,
  REQUEST_SURFACES,
  type RequestKind,
  type RequestRowJson,
  type RequestSurface,
} from '@spoor/shared'
import { and, desc, eq, gte, ilike, lt, or, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { requestLog } from '../../db/schema.js'
import { escapeLike } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import { decodeTypedCursor, page, paginationQuery } from '../../lib/pagination.js'
import type { ProjectAccess } from '../projects/index.js'

const filterText = z.string().min(1).max(200)

export const requestLogQuery = z.strictObject({
  kind: z.enum(REQUEST_KINDS).optional(),
  surface: z.enum(REQUEST_SURFACES).optional(),
  /** Exact tool name or `METHOD /path`. */
  operation: filterText.optional(),
  /** Actor label, token name or client name substring, case-insensitive. */
  actor: filterText.optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
  ...paginationQuery,
})

type RequestLogQuery = z.output<typeof requestLogQuery>
type Row = typeof requestLog.$inferSelect

export function requestRowJson(r: Row): RequestRowJson {
  return {
    id: r.id,
    at: r.at.toISOString(),
    kind: r.kind,
    surface: r.surface,
    operation: r.operation,
    actor: {
      user_id: r.actorUserId,
      label: r.actorLabel,
      token: { id: r.tokenId, name: r.tokenName, prefix: r.tokenPrefix },
      client_name: r.clientName,
    },
    space: r.space,
    memory_type: r.memoryType,
    handles: r.handles,
    query: r.query,
    outcome: r.outcome,
    duration_ms: r.durationMs,
    data: r.data,
  }
}

export class RequestLogService {
  constructor(private readonly deps: ServerDeps) {}

  /** `GET /api/v1/projects/:slug/requests`: project admins and instance admins; newest first, cursor on id. */
  async list(access: ProjectAccess, q: RequestLogQuery) {
    access.assert('requests.read')
    const conds: (SQL | undefined)[] = [eq(requestLog.projectId, access.project.id)]
    if (q.kind !== undefined) conds.push(eq(requestLog.kind, q.kind))
    if (q.surface !== undefined) conds.push(eq(requestLog.surface, q.surface))
    if (q.operation !== undefined) conds.push(eq(requestLog.operation, q.operation))
    if (q.actor !== undefined) {
      const like = `%${escapeLike(q.actor)}%`
      conds.push(
        or(
          ilike(requestLog.actorLabel, like),
          ilike(requestLog.tokenName, like),
          ilike(requestLog.clientName, like),
        ),
      )
    }
    if (q.since !== undefined) conds.push(gte(requestLog.at, new Date(q.since)))
    if (q.until !== undefined) conds.push(lt(requestLog.at, new Date(q.until)))
    if (q.cursor !== undefined) {
      const [id] = decodeTypedCursor(q.cursor, ['int'] as const)
      conds.push(lt(requestLog.id, id))
    }
    const rows = await this.deps.db
      .select()
      .from(requestLog)
      .where(and(...conds))
      .orderBy(desc(requestLog.id))
      .limit(q.limit + 1)
    return page(rows, q.limit, (r) => [r.id], requestRowJson)
  }

  /** The newest read and write of the project (dashboard; any member may see these two). */
  async last(projectId: string): Promise<Record<RequestKind, LastRequestJson | null>> {
    const newest = async (kind: RequestKind): Promise<LastRequestJson | null> => {
      const [r] = await this.deps.db
        .select({
          at: requestLog.at,
          surface: requestLog.surface,
          operation: requestLog.operation,
          label: requestLog.actorLabel,
          clientName: requestLog.clientName,
        })
        .from(requestLog)
        .where(and(eq(requestLog.projectId, projectId), eq(requestLog.kind, kind)))
        .orderBy(desc(requestLog.id))
        .limit(1)
      if (!r) return null
      return {
        at: r.at.toISOString(),
        surface: r.surface as RequestSurface,
        operation: r.operation,
        actor: { label: r.label, client_name: r.clientName },
      }
    }
    const [read, write] = await Promise.all([newest('read'), newest('write')])
    return { read, write }
  }
}
