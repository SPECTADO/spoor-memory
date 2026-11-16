/**
 * `GET /p/:slug/api/activity` (api.md section 7.2, deviation I23): how many content or edge writes this
 * token made through MCP or the CLI since a point in time (CLI pushes marked `(auto)` excluded). The Stop hook asks it to decide "the session made
 * no Spoor writes". Counts only: no item, no text.
 */
import { normalizeFilePath } from '@spoor/shared'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { auditLog, items } from '../../db/schema.js'
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

/** What `GET /p/:slug/api/pull` answers: the current text of the item a repo file is mirrored to. */
export interface PullResult {
  source_path: string
  spoor_id: string
  space: string
  revision: number
  status: string
  /** The item's Markdown body (no frontmatter): the CLI keeps the file's own frontmatter block. */
  body: string
}

/**
 * `GET /p/:slug/api/pull` (api.md section 7.2): the read half of the two-way sync of local memory files
 * (ADR-0036). Only an item that mirrors a repo file (`source_path`) in this project can be read, by that path.
 */
export class PullService {
  constructor(private readonly deps: ServerDeps) {}

  async pull(
    ctx: AuthContext & { project: NonNullable<AuthContext['project']> },
    sourcePath: string,
  ): Promise<PullResult> {
    const path = normalizeFilePath(sourcePath)
    if (path === null || path.endsWith('/'))
      throw new ApiError('invalid_input', { message: 'Invalid source_path.' })
    const [row] = await this.deps.db
      .select({
        id: items.id,
        space: items.space,
        revision: items.revision,
        status: items.status,
        body: items.body,
      })
      .from(items)
      .where(and(eq(items.projectId, ctx.project.id), eq(items.sourcePath, path)))
      .limit(1)
    if (!row) throw new ApiError('not_found', { message: `No item mirrors ${path}.` })
    return {
      source_path: path,
      spoor_id: row.id,
      space: row.space,
      revision: row.revision,
      status: row.status,
      body: row.body,
    }
  }
}
