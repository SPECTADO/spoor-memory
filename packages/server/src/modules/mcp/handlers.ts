/**
 * The nine tool handlers (docs/design/mcp.md sections 5 to 8). Each one turns its validated input into
 * calls of the items and search services (the business rules live there: dedupe, OCC, scope resolution,
 * shared read-only, mirrored items, audit with `via='mcp'` and the client name) and formats the result as
 * the documented text. Role checks run on every call (roles can change mid-session). Every call is recorded
 * in the request log (ADR-0018); a handler notes what it read or wrote in its `RequestNote`.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from 'pino'
import type { z } from 'zod'
import { type AuthContext, actorLabel } from '../../lib/auth-context.js'
import { ApiError, loggableError } from '../../lib/errors.js'
import { assertCan, bearerPrincipal } from '../auth/index.js'
import {
  type Caller,
  handleOf,
  type ItemService,
  itemHandle,
  type LoadedItem,
  markedHandle,
  viewOf,
} from '../items/index.js'
import { common, type RequestLog, type RequestNote } from '../requests/index.js'
import { type ContextService, formatSearchResults, type SearchService } from '../search/index.js'
import {
  apiErrorText,
  duplicateText,
  errorText,
  FRAMING_LINE,
  fail,
  getItemText,
  type LinkView,
  noteLines,
  ok,
  tagOf,
} from './format.js'
import type {
  contextInput,
  decideInput,
  docWriteInput,
  getInput,
  relateInput,
  rememberInput,
  searchInput,
  supersedeInput,
  ToolName,
  verifyInput,
} from './tools.js'
import { READ_TOOLS } from './tools.js'

export interface McpServices {
  items: ItemService
  search: SearchService
  context: ContextService
  logger: Logger
  /** The request log; absent in unit tests of a single handler. */
  requests?: RequestLog
}

/** `authInfo.extra` of every MCP request (mcp.md section 2 step 6). Handlers read only this. */
export interface McpAuthExtra {
  userId: string | null
  tokenId: string
  projectId: string
  sharedProjectId: string | null
  role: AuthContext['role']
  actorLabel: string
  /** The request's AuthContext, with `clientName` = the session's client label. */
  auth: AuthContext & { project: NonNullable<AuthContext['project']> }
  requestId: string
}

export interface ToolExtra {
  authInfo?: { extra?: Record<string, unknown> }
}

export function authExtraOf(extra: ToolExtra): McpAuthExtra {
  const x = extra.authInfo?.extra as McpAuthExtra | undefined
  if (!x?.auth?.project) throw new Error('MCP tool called without authInfo')
  return x
}

/** Builds the `authInfo.extra` for one request. */
export function buildAuthExtra(
  auth: AuthContext & { project: NonNullable<AuthContext['project']> },
  sharedProjectId: string | null,
  requestId: string,
): McpAuthExtra {
  return {
    userId: auth.user?.id ?? null,
    tokenId: auth.tokenId as string,
    projectId: auth.project.id,
    sharedProjectId,
    role: auth.role,
    actorLabel: actorLabel(auth),
    auth,
    requestId,
  }
}

const callerOf = (x: McpAuthExtra): Caller => ({
  ctx: x.auth,
  via: 'mcp',
  project: { id: x.auth.project.id, slug: x.auth.project.slug, kind: x.auth.project.kind },
})

/** `forbidden_role` for a viewer or a read-only token (mcp.md section 6). The token's project is never `_shared`. */
const assertWriter = (x: McpAuthExtra) =>
  assertCan(bearerPrincipal(x.auth, 'mcp'), 'item.write', { shared: false })

type Handler<S extends z.ZodType> = (
  args: z.output<S>,
  x: McpAuthExtra,
  note: RequestNote,
) => Promise<CallToolResult | string>

const isReadTool = (name: ToolName) => (READ_TOOLS as readonly string[]).includes(name)

/**
 * Wrap a handler: expected failures (`ApiError`) become `ERR <code>` results, anything else is logged and
 * reported as `ERR internal: request <id> failed` (mcp.md section 4). With `requests`, the call is then
 * recorded in the request log with its outcome (`ok` or the error code) and duration.
 */
export function guarded<S extends z.ZodType>(
  name: ToolName,
  logger: Logger,
  fn: Handler<S>,
  hints: Partial<Record<string, string>> = {},
  requests?: RequestLog,
) {
  return async (args: z.output<S>, extra: ToolExtra): Promise<CallToolResult> => {
    let requestId = 'unknown'
    let x: McpAuthExtra | undefined
    const note: RequestNote = {}
    const start = performance.now()
    let outcome = 'ok'
    try {
      x = authExtraOf(extra)
      requestId = x.requestId
      const r = await fn(args, x, note)
      const res = typeof r === 'string' ? ok(r) : r
      if (res.isError) outcome = 'error'
      return res
    } catch (err) {
      if (err instanceof ApiError) {
        outcome = err.code
        return fail(apiErrorText(err, hints))
      }
      outcome = 'internal'
      logger.error({ err: loggableError(err), request_id: requestId, tool: name }, 'mcp tool failed')
      return fail(errorText('internal', `request ${requestId} failed`))
    } finally {
      if (requests && x) {
        await requests.record({
          auth: x.auth,
          kind: isReadTool(name) ? 'read' : 'write',
          surface: 'mcp',
          operation: name,
          note,
          outcome,
          durationMs: performance.now() - start,
        })
      }
    }
  }
}

// ---- read tools -----------------------------------------------------------------------------------------

export function contextTool(s: McpServices): Handler<typeof contextInput> {
  return async (a, x, note) => {
    note.query = a.query
    note.data = { files: a.files, budget: a.budget, include_shared: a.include_shared }
    const res = await s.context.build({
      projectId: x.projectId,
      budget: a.budget,
      query: a.query ?? null,
      files: a.files ?? [],
      includeShared: a.include_shared,
    })
    note.handles = res.items
    return res.text.replace(/\n$/, '')
  }
}

export function searchTool(s: McpServices): Handler<typeof searchInput> {
  return async (a, x, note) => {
    note.query = a.query
    note.space = a.space ?? null
    note.memoryType = a.type ?? null
    note.data = { tags: a.tags, limit: a.limit }
    const res = await s.search.search({
      projectId: x.projectId,
      query: a.query,
      spaces: a.space ? [a.space] : undefined,
      type: a.type ?? null,
      tags: a.tags ?? [],
      limit: a.limit,
      includeShared: a.include_shared,
      includeInactive: a.include_inactive,
    })
    note.handles = res.hits.map((h) => itemHandle(h, h.shared))
    return formatSearchResults(a.query, res)
  }
}

export function getTool(s: McpServices): Handler<typeof getInput> {
  return async (a, x, note) => {
    const caller = callerOf(x)
    const view = viewOf(caller.project)
    const blocks: string[] = []
    const found: string[] = []
    const rows: LoadedItem[] = []
    for (const ref of a.ids) {
      let row: LoadedItem
      try {
        row = await s.items.load(caller, ref, 'read')
      } catch (err) {
        if (err instanceof ApiError && ['not_found', 'ambiguous_id'].includes(err.code)) {
          blocks.push(`=== ${ref}\n${apiErrorText(err)}`)
          continue
        }
        throw err
      }
      // links on a shared item are limited to shared items and the caller's own project (mcp.md section 6)
      const edges = await s.items.edges(caller, row.id, [caller.project.id])
      const links: LinkView[] = [
        ...edges.outgoing.map((e) => ({
          kind: e.kind,
          direction: 'out' as const,
          other: e.other?.handle ?? null,
          ref: 'dst_ref' in e ? (e.dst_ref as string | null) : null,
        })),
        ...edges.incoming.map((e) => ({
          kind: e.kind,
          direction: 'in' as const,
          other: e.other?.handle ?? null,
        })),
      ]
      blocks.push(
        getItemText(
          {
            id: row.id,
            space: row.space,
            title: row.title,
            tags: row.tags,
            anchors: row.anchors,
            type: row.type,
            confidence: row.confidence,
            status: row.status,
            adrNumber: row.adrNumber,
            decidedOn: row.decidedOn,
            extras: row.frontmatter,
            markedHandle: markedHandle(row, view),
            handle: handleOf(row, view),
            revision: row.revision,
            slug: row.slug,
            body: row.body,
            lifecycle: row.lifecycle,
            pinned: row.pinned,
            lastVerifiedAt: row.lastVerifiedAt,
            expiresAt: row.expiresAt,
            sourcePath: row.sourcePath,
          },
          links,
          { offset: a.offset, maxChars: a.max_chars },
        ),
      )
      found.push(row.id)
      rows.push(row)
    }
    note.handles = rows.map((r) => handleOf(r, view))
    note.space = common(rows.map((r) => r.space))
    note.memoryType = common(rows.map((r) => r.type))
    if (found.length === 0) note.outcome = 'not_found'
    await s.items.touchUsed(found)
    const text = [FRAMING_LINE, ...blocks].join('\n')
    return found.length === 0 ? fail(text) : ok(text)
  }
}

// ---- write tools ----------------------------------------------------------------------------------------

export function rememberTool(s: McpServices): Handler<typeof rememberInput> {
  return async (a, x, note) => {
    assertWriter(x)
    const caller = callerOf(x)
    note.space = 'memories'
    if (a.id === undefined) {
      note.memoryType = a.type ?? 'fact'
      const res = await s.items.create(
        caller,
        'memories',
        {
          title: a.title,
          // a create without `type` is a fact (mcp.md section 4.4): no failed first call (review-log-phase5 A5)
          type: a.type ?? 'fact',
          body: a.body,
          confidence: a.confidence,
          anchors: a.anchors,
          tags: a.tags,
          relations: a.relations,
          allow_duplicate: a.allow_duplicate,
        },
        { dedupe: 'block' },
      )
      if (res.duplicate) {
        note.outcome = 'duplicate'
        return duplicateText({ ...res.duplicate, space: 'memories' }, 'spoor_remember')
      }
      const item = res.item as NonNullable<typeof res.item>
      note.handles = [item.handle]
      return [
        `OK created ${item.handle} r${item.revision} [${tagOf(item)}]`,
        ...noteLines(res.notes, res.warnings),
      ].join('\n')
    }
    // update: patch semantics, `revision` required (the service says `revision_required`); no dedupe runs.
    // The content write and the relation edges are one transaction (mcp.md section 8); relation targets are
    // resolved before anything is written (not_found names the position).
    const res = await s.items.update(
      caller,
      a.id,
      {
        revision: a.revision,
        title: a.title,
        body: a.body,
        type: a.type,
        confidence: a.confidence,
        tags: a.tags,
        anchors: a.anchors,
      },
      { expectSpace: 'memories', relations: a.relations ?? [] },
    )
    note.handles = [res.item.handle]
    note.memoryType = res.item.type
    const view = viewOf(caller.project)
    const added = res.relations
      .filter((r) => r.changed)
      .map((r) => `note: linked ${r.kind}→${handleOf(r.to, view)}`)
    const verb = res.changed ? 'updated' : 'unchanged'
    return [
      `OK ${verb} ${res.item.handle} r${res.item.revision}`,
      ...noteLines([], res.warnings),
      ...added,
    ].join('\n')
  }
}

export const REMEMBER_HINTS = {
  wrong_space: 'spoor_remember edits memories; docs: spoor_doc_write; ADRs: edit the ADR file or the web UI',
}

export function decideTool(s: McpServices): Handler<typeof decideInput> {
  return async (a, x, note) => {
    assertWriter(x)
    note.space = 'memories'
    note.memoryType = 'decision'
    const caller = callerOf(x)
    const view = viewOf(caller.project)
    let old: LoadedItem | null = null
    if (a.supersedes !== undefined) {
      old = await s.items.load(caller, a.supersedes, 'write')
      const h = handleOf(old, view)
      if (old.space === 'decisions') {
        throw new ApiError('wrong_space', {
          message: `${h} is an ADR.`,
          hint: `put supersedes: ${h} in the new ADR file`,
        })
      }
      if (old.space !== 'memories' || old.type !== 'decision') {
        throw new ApiError('wrong_space', {
          message: `${h} is not a decision memory.`,
          hint: old.space === 'docs' ? 'docs are edited with spoor_doc_write' : 'use spoor_supersede',
        })
      }
    }
    const res = await s.items.create(
      caller,
      'memories',
      {
        title: a.title,
        type: 'decision',
        confidence: 'high',
        body: a.body,
        anchors: a.anchors,
        tags: a.tags,
        supersedes: old?.id,
        allow_duplicate: a.allow_duplicate,
      },
      { dedupe: 'block' },
    )
    if (res.duplicate) {
      note.outcome = 'duplicate'
      return duplicateText({ ...res.duplicate, space: 'memories' }, 'spoor_remember')
    }
    const item = res.item as NonNullable<typeof res.item>
    note.handles = old ? [item.handle, handleOf(old, view)] : [item.handle]
    let line = `OK decided ${item.handle} r${item.revision} [dec]`
    if (old) {
      const now = await s.items.get(caller, old.id)
      line += ` supersedes ${now.handle} (${now.handle} now ${now.status} r${now.revision})`
    }
    return [
      line,
      ...noteLines(res.notes, res.warnings),
      'note: decision recorded; an ADR is drafted from it by spoor adr draft (Claude Code with Spoor hooks: automatically at turn end)',
    ].join('\n')
  }
}

export function docWriteTool(s: McpServices): Handler<typeof docWriteInput> {
  return async (a, x, note) => {
    assertWriter(x)
    const caller = callerOf(x)
    note.space = 'docs'
    if (a.id === undefined) {
      const res = await s.items.create(
        caller,
        'docs',
        {
          title: a.title,
          body: a.body,
          slug: a.slug,
          anchors: a.anchors,
          tags: a.tags,
          allow_duplicate: a.allow_duplicate,
        },
        { dedupe: 'block' },
      )
      if (res.duplicate) {
        note.outcome = 'duplicate'
        return duplicateText({ ...res.duplicate, space: 'docs' }, 'spoor_doc_write')
      }
      const item = res.item as NonNullable<typeof res.item>
      note.handles = [item.handle]
      return [`OK created ${item.handle} r${item.revision}`, ...noteLines(res.notes, res.warnings)].join('\n')
    }
    if (a.slug !== undefined) {
      throw new ApiError('invalid_input', {
        message: 'A slug is fixed at creation and cannot change.',
        details: { issues: [{ path: 'slug', message: 'only on create' }] },
      })
    }
    const res = await s.items.update(
      caller,
      a.id,
      { revision: a.revision, title: a.title, body: a.body, tags: a.tags, anchors: a.anchors },
      { expectSpace: 'docs' },
    )
    note.handles = [res.item.handle]
    const verb = res.changed ? 'updated' : 'unchanged'
    return [`OK ${verb} ${res.item.handle} r${res.item.revision}`, ...noteLines([], res.warnings)].join('\n')
  }
}

export const DOC_WRITE_HINTS = {
  wrong_space: 'spoor_doc_write edits docs; memories: spoor_remember; ADRs: edit the ADR file or the web UI',
}

export function supersedeTool(s: McpServices): Handler<typeof supersedeInput> {
  return async (a, x, note) => {
    assertWriter(x)
    const caller = callerOf(x)
    const res = await s.items.supersede(caller, a.old, {
      new: a.new,
      new_id: a.new_id,
      revision: a.revision,
      reason: a.reason,
    })
    const n = res.new
    const o = res.old
    note.handles = [n.handle, o.handle]
    note.space = n.space
    note.memoryType = n.type
    return [
      `OK ${n.handle} r${n.revision} supersedes ${o.handle} (${o.handle} now ${o.status} r${o.revision})`,
      ...noteLines([], res.warnings),
    ].join('\n')
  }
}

export function relateTool(s: McpServices): Handler<typeof relateInput> {
  return async (a, x, note) => {
    assertWriter(x)
    const caller = callerOf(x)
    const view = viewOf(caller.project)
    const res = await s.items.relate(caller, a.from, a.kind, a.to, a.remove)
    const edge = `${handleOf(res.from, view)} ${a.kind} ${handleOf(res.to, view)}`
    note.handles = [handleOf(res.from, view), handleOf(res.to, view)]
    note.data = { kind: a.kind, remove: a.remove || undefined }
    if (!res.changed) return `OK unchanged ${edge}`
    return a.remove ? `OK removed ${edge}` : `OK ${edge}`
  }
}

export function verifyTool(s: McpServices): Handler<typeof verifyInput> {
  return async (a, x, note) => {
    assertWriter(x)
    const res = await s.items.verifyMany(callerOf(x), a.ids, a.note)
    note.handles = res.verified
    note.space = 'memories'
    const parts = [`OK verified ${res.verified.length ? res.verified.join(' ') : 'none'}`]
    if (res.restored.length) parts.push(`restored: ${res.restored.join(' ')}`)
    if (res.skipped.length) {
      parts.push(`skipped: ${res.skipped.map((k) => `${k.handle ?? k.ref} ${k.reason}`).join(', ')}`)
    }
    return parts.join(' · ')
  }
}
