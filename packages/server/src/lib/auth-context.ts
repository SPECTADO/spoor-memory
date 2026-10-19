/**
 * Who is calling, resolved once per request by the auth middleware and read by every module.
 * Cookie requests (`/api/v1`) start with `project: null`; a project route resolves the project and the
 * effective role itself (`effectiveRole`). Bearer requests (`/p/:slug/api`, `/p/:slug/mcp`) carry the
 * token's project and its effective role from the start.
 */
import type { ProjectRole } from '@spoor/shared'

export type { ProjectRole } from '@spoor/shared'

export interface AuthUser {
  id: string
  email: string
  name: string
  isAdmin: boolean
  sharedEditor: boolean
}

export interface AuthProject {
  id: string
  slug: string
  name: string
  kind: 'project' | 'shared'
}

export interface AuthContext {
  /** The person. `null` only for a service token. */
  user: AuthUser | null
  project: AuthProject | null
  /** Effective project role (`admin` for an instance admin without membership). `null` = none resolved. */
  role: ProjectRole | null
  via: 'cookie' | 'bearer'
  tokenId?: string
  /** Bearer requests: the token name (service tokens: `actor_label = 'service:<name>'`). */
  tokenName?: string
  /** Bearer requests: `user` or `service`. */
  tokenKind?: 'user' | 'service'
  /** Bearer requests: `tokens.prefix` (first 12 characters, display only). */
  tokenPrefix?: string
  /** MCP `initialize` client name or a sanitised CLI user agent; `'web'` for the SPA. */
  clientName?: string
}

/** `audit_log.actor_label` / `items.*_by_label`: the user's email, `service:<token name>`, or `system`. */
export function actorLabel(ctx: Pick<AuthContext, 'user' | 'tokenName'> | null): string {
  if (ctx?.user) return ctx.user.email
  if (ctx?.tokenName !== undefined) return `service:${ctx.tokenName}`
  return 'system'
}

const RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, admin: 3 }

/** Instance admins count as project `admin` everywhere (auth-and-security.md section 7). */
export function effectiveRole(isInstanceAdmin: boolean, membership: ProjectRole | null): ProjectRole | null {
  return isInstanceAdmin ? 'admin' : membership
}

/** Role cap for tokens: the lower of the two (`null` cap = inherit). */
export function capRole(role: ProjectRole | null, cap: ProjectRole | null): ProjectRole | null {
  if (role === null || cap === null) return role
  return RANK[cap] < RANK[role] ? cap : role
}

export function roleAtLeast(role: ProjectRole | null, min: ProjectRole): boolean {
  return role !== null && RANK[role] >= RANK[min]
}
