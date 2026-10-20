/**
 * Role gates of the UI (docs/design/web-ui.md §2.1). The server is the real check; these only decide what
 * to render. `role` is the effective project role from `GET /projects/:slug` (an instance admin is `admin`
 * everywhere; on `_shared` it is admin for IA, editor for a shared editor, viewer otherwise).
 */
import type { MeResponse, ProjectRole } from '@spoor/shared'

const RANK: Record<ProjectRole, number> = { viewer: 0, editor: 1, admin: 2 }

/** `library` is the library right (`ProjectJson.can_edit_library`), never derived from the role here. */
export type Gate = 'member' | 'editor' | 'admin' | 'ia' | 'library'

export function hasRole(role: ProjectRole | null | undefined, min: ProjectRole): boolean {
  return role != null && RANK[role] >= RANK[min]
}

export const isInstanceAdmin = (me: MeResponse | undefined): boolean => me?.user.is_admin === true

/** Whether `me` passes `gate` in a project where their effective role is `role`. */
export function passes(
  gate: Gate,
  me: MeResponse | undefined,
  role: ProjectRole | null | undefined,
  canEditLibrary = false,
): boolean {
  switch (gate) {
    case 'ia':
      return isInstanceAdmin(me)
    case 'admin':
      return isInstanceAdmin(me) || hasRole(role, 'admin')
    case 'editor':
      return isInstanceAdmin(me) || hasRole(role, 'editor')
    case 'library':
      return canEditLibrary
    case 'member':
      return isInstanceAdmin(me) || role != null
  }
}
