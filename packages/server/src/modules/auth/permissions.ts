/**
 * The permission matrix of auth-and-security.md section 7 as one pure function. Every route asks
 * `can(principal, action, target)`; nothing else encodes who may do what. The table-driven test
 * (permissions.test.ts) checks every row of the matrix for every kind of caller on every surface.
 *
 * Visibility is separate: a project the caller cannot see is 404 before any `can` (api.md section 1).
 */
import type { ProjectRole } from '@spoor/shared'
import type { AuthContext } from '../../lib/auth-context.js'
import { roleAtLeast } from '../../lib/auth-context.js'
import { ApiError } from '../../lib/errors.js'

/** One action per row of the matrix (the shared-space rows reuse the item actions with `target.shared`). */
export const ACTIONS = [
  /** Read project items, search, history, backlinks, audit log. Shared target: "read shared space". */
  'project.read',
  /** Create / edit items, pin, verify, archive, restore, relate. Shared target: "write shared space". */
  'item.write',
  /** Hard-delete an item. Shared target: "hard-delete shared item". */
  'item.delete',
  /** Review-queue actions. */
  'review.act',
  /** Create one's own user token. */
  'token.create_own',
  /** Look up, approve or deny a device code for a project. */
  'device.approve',
  /** Revoke a token (`target.ownsToken` for one's own). */
  'token.revoke',
  /** Create / revoke service tokens, see every token of the project. */
  'service_token.manage',
  /** Memberships and roles of a project. */
  'members.manage',
  /** Project settings (name, description, cleanup days, embedding provider, ...). */
  'settings.manage',
  /** Export / import a project. Shared target: "export / import shared space". */
  'project.transfer',
  'project.create',
  'project.delete',
  /** Users (create via invite, disable, delete), `is_admin`, `shared_editor`. */
  'users.manage',
  /** Project invites (non-empty grants, all on own projects). */
  'invite.project',
  /** Reset invites, instance-flag invites. */
  'invite.instance',
  /** Job status, re-embed progress. */
  'jobs.read',
] as const
export type Action = (typeof ACTIONS)[number]

export type Surface = 'web' | 'rest' | 'mcp'

/** A cookie user, with their membership in the target project (never one on `_shared`). */
export interface WebPrincipal {
  surface: 'web'
  isAdmin: boolean
  sharedEditor: boolean
  membership: ProjectRole | null
}

/** A bearer token: its effective role in its own project (mcp.md section 2), `null` when none. */
export interface BearerPrincipal {
  surface: 'rest' | 'mcp'
  role: ProjectRole | null
}

export type Principal = WebPrincipal | BearerPrincipal

export interface Target {
  /** The target project is `_shared`. */
  shared?: boolean
  /** `token.revoke`: the token belongs to the caller. */
  ownsToken?: boolean
}

function canWeb(p: WebPrincipal, action: Action, t: Target): boolean {
  const ia = p.isAdmin
  const shared = t.shared === true
  // the effective project role: instance admins count as project admin everywhere (section 7 rules)
  const role: ProjectRole | null = ia ? 'admin' : shared ? null : p.membership
  const member = role !== null
  const pa = role === 'admin'
  const sharedWriter = ia || p.sharedEditor
  switch (action) {
    case 'project.read':
      return shared ? true : member
    case 'item.write':
    case 'review.act':
      return shared ? sharedWriter : roleAtLeast(role, 'editor')
    case 'item.delete':
      return shared ? sharedWriter : pa
    case 'token.create_own':
    case 'device.approve':
      return !shared && member
    case 'token.revoke':
      return !shared && (pa || (member && t.ownsToken === true))
    case 'service_token.manage':
    case 'members.manage':
    case 'invite.project':
      return !shared && pa
    case 'settings.manage':
    case 'project.transfer':
    case 'jobs.read':
      return shared ? ia : pa
    case 'project.delete':
      return !shared && ia
    case 'project.create':
    case 'users.manage':
    case 'invite.instance':
      return ia
  }
}

function canBearer(p: BearerPrincipal, action: Action, t: Target): boolean {
  switch (action) {
    case 'project.read':
      // shared items are readable through any valid project token
      return p.role !== null
    case 'item.write':
      // UT >= editor, ST[editor]; never the shared space
      return t.shared !== true && roleAtLeast(p.role, 'editor')
    default:
      return false
  }
}

export function can(p: Principal, action: Action, target: Target = {}): boolean {
  return p.surface === 'web' ? canWeb(p, action, target) : canBearer(p, action, target)
}

/**
 * `can` or throw: web 403 `forbidden`; bearer `read_only_space` for any write on the shared space,
 * otherwise 403 `forbidden_role` (a viewer or read-only token).
 */
export function assertCan(p: Principal, action: Action, target: Target = {}): void {
  if (can(p, action, target)) return
  if (p.surface === 'web') throw new ApiError('forbidden', { message: 'You may not do this here.' })
  if (target.shared && action !== 'project.read') {
    throw new ApiError('read_only_space', {
      message: 'The shared space is read-only for tokens.',
      hint: 'Shared items are edited by humans in the web UI.',
    })
  }
  throw new ApiError('forbidden_role', {
    message: 'This token may not do this.',
    hint: 'Ask a project admin for the editor role or a token without the read-only cap.',
  })
}

/** The principal of a bearer request (its role is already the effective, capped one). */
export function bearerPrincipal(ctx: AuthContext, surface: 'rest' | 'mcp' = 'rest'): BearerPrincipal {
  return { surface, role: ctx.role }
}

/** The principal of a cookie user for a project in which they hold `membership` (or none). */
export function webPrincipal(
  user: { isAdmin: boolean; sharedEditor: boolean },
  membership: ProjectRole | null,
): WebPrincipal {
  return { surface: 'web', isAdmin: user.isAdmin, sharedEditor: user.sharedEditor, membership }
}
