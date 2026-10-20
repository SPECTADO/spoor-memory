/**
 * Who may see a project on the cookie surface, and with which effective role (api.md sections 0.2, 1, 4).
 * A regular project is visible to its members and to instance admins; everyone else gets 404 `not_found`,
 * so a non-member learns nothing about it. `_shared` is visible to every logged-in user. What the caller may
 * then do is `can()` of the permission matrix.
 */
import type { ProjectRole } from '@spoor/shared'
import { and, eq } from 'drizzle-orm'
import { memberships, projects } from '../../db/schema.js'
import type { DbOrTx } from '../../lib/db.js'
import { ApiError } from '../../lib/errors.js'
import {
  type Action,
  assertCan,
  can,
  type Target,
  type UserContext,
  type WebPrincipal,
  webPrincipal,
} from '../auth/index.js'

export type ProjectRow = typeof projects.$inferSelect

export interface ProjectAccess {
  ctx: UserContext
  project: ProjectRow
  /** The project is `_shared`. */
  shared: boolean
  /** The caller's membership (never one on `_shared`). */
  membership: ProjectRole | null
  /** The membership's library flag (`library_editor`); always false on `_shared` and without a membership. */
  libraryEditor: boolean
  /**
   * Effective role for display (`GET /projects/:slug`, the SPA's role gates): projects, the membership or
   * `admin` for an instance admin; `_shared`, `admin` for an instance admin, `editor` for a shared editor,
   * `viewer` for everyone else.
   */
  role: ProjectRole
  principal: WebPrincipal
  can(action: Action, target?: Omit<Target, 'shared'>): boolean
  /** 403 `forbidden` unless `can`. */
  assert(action: Action, target?: Omit<Target, 'shared'>): void
}

export const projectNotFound = () => new ApiError('not_found', { message: 'No such project.' })

export function accessFor(
  ctx: UserContext,
  project: ProjectRow,
  membership: ProjectRole | null,
  libraryEditor = false,
): ProjectAccess {
  const shared = project.kind === 'shared'
  const principal = webPrincipal(ctx.user, shared ? null : membership, !shared && libraryEditor)
  const role: ProjectRole = ctx.user.isAdmin
    ? 'admin'
    : shared
      ? ctx.user.sharedEditor
        ? 'editor'
        : 'viewer'
      : (membership as ProjectRole)
  return {
    ctx,
    project,
    shared,
    membership: shared ? null : membership,
    libraryEditor: principal.libraryEditor,
    role,
    principal,
    can: (action, target = {}) => can(principal, action, { ...target, shared }),
    assert: (action, target = {}) => assertCan(principal, action, { ...target, shared }),
  }
}

/** Load `slug` for a logged-in user: 404 when it does not exist or the user may not see it. */
export async function loadProjectAccess(db: DbOrTx, ctx: UserContext, slug: string): Promise<ProjectAccess> {
  const [row] = await db
    .select({ project: projects, membership: memberships.role, libraryEditor: memberships.libraryEditor })
    .from(projects)
    .leftJoin(memberships, and(eq(memberships.projectId, projects.id), eq(memberships.userId, ctx.user.id)))
    .where(eq(projects.slug, slug))
    .limit(1)
  if (!row) throw projectNotFound()
  const membership = (row.membership ?? null) as ProjectRole | null
  if (row.project.kind === 'project' && membership === null && !ctx.user.isAdmin) throw projectNotFound()
  return accessFor(ctx, row.project, membership, row.libraryEditor === true)
}

/** Member and token routes do not exist on `_shared` (api.md 4.2, 4.3): 404 there. */
export function requireRegularProject(access: ProjectAccess): void {
  if (access.shared) throw projectNotFound()
}
