/**
 * Install module: the public, secret-free install doc `GET /p/:slug/install.md` and the machine-readable
 * `GET /p/:slug/install.json` that `spoor init` merges into a repo (api.md 11.1 and 11.1a, cli-and-hooks.md
 * 7 and 9, deviations I35, I39, D7). Templates are pure functions of server URL, slug, version and the
 * project's default digest budget (templates.ts).
 *
 * Wiring (app.ts): `routes` is mounted at `/p/:slug`.
 */
import type { ServerDeps } from '../../lib/deps.js'
import { installRoutes } from './routes.js'
import { InstallService } from './service.js'

export { InstallService } from './service.js'
export {
  GITIGNORE_LINES,
  type InstallValues,
  mcpJson,
  renderInstallJson,
  renderInstallMd,
  settingsJson,
  tokenEnvVar,
} from './templates.js'

export function createInstallModule(deps: ServerDeps, opts: { version?: string } = {}) {
  const install = new InstallService(deps, opts.version)
  return { name: 'install', install, routes: installRoutes(install) }
}

export type InstallModule = ReturnType<typeof createInstallModule>
