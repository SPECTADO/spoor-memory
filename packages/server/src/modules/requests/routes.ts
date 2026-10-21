/** Request-log routes, mounted at /api/v1 (api.md section 10.3, ADR-0018). */
import { Hono } from 'hono'
import type { ServerDeps } from '../../lib/deps.js'
import { readQuery } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import { requireUser } from '../auth/index.js'
import { loadProjectAccess } from '../projects/index.js'
import { type RequestLogService, requestLogQuery } from './service.js'

export function requestRoutes(deps: ServerDeps, service: RequestLogService) {
  return new Hono<AppEnv>().get('/projects/:slug/requests', async (c) => {
    const a = await loadProjectAccess(deps.db, requireUser(c), c.req.param('slug'))
    return c.json(await service.list(a, readQuery(c, requestLogQuery)))
  })
}
