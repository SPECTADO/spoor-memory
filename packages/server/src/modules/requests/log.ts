/**
 * Writing the agent request log (ADR-0018). The MCP tool wrapper and the bearer REST middleware each start a
 * `RequestNote`, let the handler fill in what it read or wrote, then `record` it with the outcome. Logging
 * never fails a request: an insert error is logged and dropped.
 */
import { cleanLine, type RequestKind, type RequestSurface } from '@spoor/shared'
import type { Logger } from 'pino'
import { requestLog } from '../../db/schema.js'
import { type AuthContext, actorLabel } from '../../lib/auth-context.js'
import type { DbOrTx } from '../../lib/db.js'
import { loggableError } from '../../lib/errors.js'

export const REQUEST_QUERY_MAX = 200
export const REQUEST_HANDLES_MAX = 50
const DATA_LIST_MAX = 20

/** What a handler adds to its row; every field is optional. */
export interface RequestNote {
  space?: string | null
  memoryType?: string | null
  handles?: string[]
  query?: string | null
  /** Overrides `error` for a tool result that failed without an ApiError (e.g. `not_found` on every id). */
  outcome?: string
  data?: Record<string, unknown>
}

export interface RequestEntry {
  auth: AuthContext & { project: NonNullable<AuthContext['project']> }
  kind: RequestKind
  surface: RequestSurface
  operation: string
  note: RequestNote
  outcome: string
  durationMs: number
}

/** One line, at most `max` characters; `null` for nothing. */
function clip(s: string | null | undefined, max: number): string | null {
  if (s == null) return null
  const line = [...cleanLine(s)].slice(0, max).join('').trim()
  return line === '' ? null : line
}

/** `data` with long lists cut to 20 entries (digest file lists can hold 200). */
function boundedData(data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!data) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue
    out[k] = Array.isArray(v) && v.length > DATA_LIST_MAX ? [...v.slice(0, DATA_LIST_MAX), '…'] : v
  }
  return out
}

/** The space or memory type when every value agrees, else `null` (a `spoor_get` of a memory and a doc). */
export function common<T>(values: (T | null | undefined)[]): T | null {
  const set = new Set(values.filter((v) => v != null))
  return set.size === 1 ? ([...set][0] as T) : null
}

export class RequestLog {
  constructor(
    private readonly db: DbOrTx,
    private readonly logger: Logger,
  ) {}

  async record(e: RequestEntry): Promise<void> {
    const { auth, note } = e
    try {
      await this.db.insert(requestLog).values({
        projectId: auth.project.id,
        kind: e.kind,
        surface: e.surface,
        operation: e.operation,
        actorUserId: auth.user?.id ?? null,
        actorLabel: actorLabel(auth),
        tokenId: auth.tokenId ?? null,
        tokenName: auth.tokenName ?? null,
        tokenPrefix: auth.tokenPrefix ?? null,
        clientName: auth.clientName ?? null,
        space: note.space ?? null,
        memoryType: note.memoryType ?? null,
        handles: (note.handles ?? []).slice(0, REQUEST_HANDLES_MAX),
        query: clip(note.query, REQUEST_QUERY_MAX),
        outcome: note.outcome ?? e.outcome,
        durationMs: Math.max(0, Math.round(e.durationMs)),
        data: boundedData(note.data),
      })
    } catch (err) {
      this.logger.warn({ err: loggableError(err), operation: e.operation }, 'request log write failed')
    }
  }
}
