/**
 * One helper for every `audit_log` row (data-model.md section 4). Every mutating web, REST and MCP action
 * writes one, in the same transaction as the change. `data` never holds secrets or bodies.
 */
import { auditLog, type VIAS } from '../db/schema.js'
import { type AuthContext, actorLabel } from './auth-context.js'
import type { DbOrTx } from './db.js'

export type Via = (typeof VIAS)[number]

export interface AuditEntry {
  action: string
  summary: string
  /** NULL = instance-level row (users, invites, projects). */
  projectId?: string | null
  itemId?: string | null
  itemHandle?: string | null
  data?: Record<string, unknown>
}

/** Who did it: from the request's AuthContext (or `null` for the system), plus the channel. */
export interface AuditActor {
  ctx: AuthContext | null
  via: Via
}

const SUMMARY_MAX = 300

export async function writeAudit(db: DbOrTx, actor: AuditActor, entry: AuditEntry): Promise<void> {
  const summary =
    [...entry.summary].length > SUMMARY_MAX
      ? `${[...entry.summary].slice(0, SUMMARY_MAX - 1).join('')}…`
      : entry.summary
  await db.insert(auditLog).values({
    projectId: entry.projectId ?? null,
    actorUserId: actor.ctx?.user?.id ?? null,
    actorLabel: actorLabel(actor.ctx),
    tokenId: actor.ctx?.tokenId ?? null,
    via: actor.via,
    clientName: actor.ctx?.clientName ?? null,
    action: entry.action,
    itemId: entry.itemId ?? null,
    itemHandle: entry.itemHandle ?? null,
    summary,
    data: entry.data ?? {},
  })
}

/** The usual actor of a cookie request. */
export const webActor = (ctx: AuthContext | null): AuditActor => ({ ctx, via: 'web' })
export const systemActor: AuditActor = { ctx: null, via: 'system' }
