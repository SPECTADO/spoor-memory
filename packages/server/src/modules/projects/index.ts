/**
 * Projects module: projects and their settings, memberships, project visibility for the cookie surface,
 * and the `_shared` project row seeded at startup. Design: api.md 4.1 and 4.2, data-model.md 2 and 2.1,
 * auth-and-security.md 7 and 8.
 *
 * Public surface for other modules: `loadProjectAccess` (visibility + effective role + `can`) and
 * `requireRegularProject` for routes under `/api/v1/projects/:slug`, `resolveSettings`, and
 * `ensureSharedProject` for startup.
 */
import type { ServerDeps } from '../../lib/deps.js'
import { MemberService } from './members.js'
import { projectRoutes } from './routes.js'
import { ProjectService } from './service.js'

export {
  accessFor,
  loadProjectAccess,
  type ProjectAccess,
  type ProjectRow,
  projectNotFound,
  requireRegularProject,
} from './access.js'
export { MemberService } from './members.js'
export { ensureSharedProject, ProjectService, resolveSettings } from './service.js'

export function createProjectsModule(deps: ServerDeps) {
  const projects = new ProjectService(deps)
  const members = new MemberService(deps)
  return { name: 'projects', projects, members, routes: projectRoutes(deps, { projects, members }) }
}

export type ProjectsModule = ReturnType<typeof createProjectsModule>
