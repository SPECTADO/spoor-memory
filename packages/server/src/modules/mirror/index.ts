/**
 * Mirror module: the bearer endpoints the `spoor` CLI and hooks need besides the items module's `push` and
 * `adr/import` and the jobs module's `decisions/undrafted` (api.md section 7.2): `GET activity` (deviation
 * I23, the Stop hook's "made no Spoor writes" check) and `POST adr/push` / `POST docs/push` (the per-space
 * forms of `POST push`; the push rules themselves stay in the items module's PushService, data-model.md 7).
 *
 * Wiring (app.ts): `bearerRoutes` is mounted on `/p/:slug/api` after `auth.bearerApiGuards`; it needs the
 * items module built by createAppModules (its PushService).
 */
import type { ServerDeps } from '../../lib/deps.js'
import type { PushService } from '../items/index.js'
import { mirrorBearerRoutes } from './routes.js'
import { ActivityService } from './service.js'

export { ACTIVITY_ACTIONS, ActivityService } from './service.js'

export function createMirrorModule(deps: ServerDeps, items: { push: PushService }) {
  const activity = new ActivityService(deps)
  return { name: 'mirror', activity, bearerRoutes: mirrorBearerRoutes(items.push, activity) }
}

export type MirrorModule = ReturnType<typeof createMirrorModule>
