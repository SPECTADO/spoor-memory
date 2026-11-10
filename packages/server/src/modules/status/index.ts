/**
 * Status module: the instance admin's "Status" page (api.md section 10.4). Mounted in app.ts with
 * `api.route('/', status.routes)`; it reads the mcp module's session table and the scheduler through
 * `StatusSources`, never their internals.
 */
import { Hono } from 'hono'
import type { ServerDeps } from '../../lib/deps.js'
import type { AppEnv } from '../../types.js'
import { requireInstanceAdmin } from '../auth/index.js'
import { StatusService, type StatusSources } from './service.js'

export { type StatusJson, StatusService, type StatusSources } from './service.js'

export function createStatusModule(deps: ServerDeps, sources: StatusSources) {
  const service = new StatusService(deps, sources)
  const routes = new Hono<AppEnv>().get('/status', async (c) => {
    requireInstanceAdmin(c)
    c.header('Cache-Control', 'no-store')
    return c.json(await service.get())
  })
  return { name: 'status', service, routes }
}
