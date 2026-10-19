/** Audit-log routes, mounted at /api/v1 (api.md section 10). */
import { Hono } from 'hono'
import type { ServerDeps } from '../../lib/deps.js'
import { readQuery } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import { requireUser } from '../auth/index.js'
import { loadProjectAccess } from '../projects/index.js'
import { type AuditService, instanceAuditQuery, projectAuditQuery } from './service.js'

export function auditRoutes(deps: ServerDeps, audit: AuditService) {
  return new Hono<AppEnv>()
    .get('/projects/:slug/audit', async (c) => {
      const a = await loadProjectAccess(deps.db, requireUser(c), c.req.param('slug'))
      return c.json(await audit.listProject(a, readQuery(c, projectAuditQuery)))
    })
    .get('/audit', async (c) => {
      const ctx = requireUser(c)
      return c.json(await audit.listInstance(ctx, readQuery(c, instanceAuditQuery)))
    })
}
