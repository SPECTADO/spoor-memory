/**
 * `GET /p/:slug/api/activity` (api.md section 7.2, deviation I23): how many content or edge writes this
 * token made through MCP or the CLI since a point in time (CLI pushes marked `(auto)` excluded). The Stop hook asks it to decide "the session made
 * no Spoor writes". Counts only: no item, no text.
 */
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { auditLog } from '../../db/schema.js'
import type { AuthContext } from '../../lib/auth-context.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError } from '../../lib/errors.js'

/** The audit actions that count as "recorded something in Spoor" (api.md section 7.2). */
export const ACTIVITY_ACTIONS = [
  'item.create',
  'item.update',
  'item.supersede',
  'edge.add',
  'item.verify',
  'item.push',
] as const

/**
 * The CLI marks the pushes it makes on its own (the detached drafting run, the SessionStart queue replay and mirror
 * sweep) with this User-Agent suffix, which the bearer guard stores as the client name. They are not something the
 * agent recorded in this session, so they never suppress the Stop nag (review-log-phase5 A3).
 */
export const AUTO_CLIENT_SUFFIX = ' (auto)'

/** Without `since`: the last 6 hours (what the Stop hook assumes for a session without a start marker). */
export const ACTIVITY_DEFAULT_HOURS = 6

export class ActivityService {
  constructor(private readonly deps: ServerDeps) {}

  async writes(ctx: AuthContext & { project: NonNullable<AuthContext['project']> }, since?: string) {
    if (ctx.tokenId === undefined) throw new ApiError('invalid_token')
    const from =
      since === undefined
        ? sql`now() - make_interval(hours => ${ACTIVITY_DEFAULT_HOURS})`
        : sql`${since}::timestamptz`
    const [row] = await this.deps.db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.projectId, ctx.project.id),
          eq(auditLog.tokenId, ctx.tokenId),
          inArray(auditLog.via, ['mcp', 'cli']),
          inArray(auditLog.action, [...ACTIVITY_ACTIONS]),
          gte(auditLog.at, from),
          sql`not (${auditLog.via} = 'cli' and coalesce(${auditLog.clientName}, '') like ${`%${AUTO_CLIENT_SUFFIX}`})`,
        ),
      )
    return { writes: row?.n ?? 0 }
  }
}
