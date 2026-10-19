/**
 * Cookie routes of projects and memberships, mounted at /api/v1 (api.md sections 4.1, 4.2).
 * Parsing and status codes only; visibility in access.ts, rules in the services.
 */
import { memberAddRequest, memberRoleRequest, projectCreateRequest, projectPatchRequest } from '@spoor/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ServerDeps } from '../../lib/deps.js'
import { readJson, readQuery, uuidOr404 } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import { requireUser } from '../auth/index.js'
import { loadProjectAccess } from './access.js'
import type { MemberService } from './members.js'
import type { ProjectService } from './service.js'

const deleteQuery = z.strictObject({ confirm: z.string().max(100).optional() })

export function projectRoutes(deps: ServerDeps, s: { projects: ProjectService; members: MemberService }) {
  const access = (c: Parameters<typeof requireUser>[0]) =>
    loadProjectAccess(deps.db, requireUser(c), c.req.param('slug') ?? '')
  return (
    new Hono<AppEnv>()
      // ---- 4.1 projects ----
      .get('/projects', async (c) => c.json(await s.projects.list(requireUser(c))))
      .post('/projects', async (c) => {
        const ctx = requireUser(c)
        const body = await readJson(c, projectCreateRequest)
        return c.json(await s.projects.create(ctx, body), 201)
      })
      .get('/projects/:slug', async (c) => c.json(await s.projects.get(await access(c))))
      .patch('/projects/:slug', async (c) => {
        const a = await access(c)
        const body = await readJson(c, projectPatchRequest)
        return c.json(await s.projects.update(a, body))
      })
      .delete('/projects/:slug', async (c) => {
        const ctx = requireUser(c)
        const q = readQuery(c, deleteQuery)
        await s.projects.delete(ctx, c.req.param('slug'), q.confirm)
        return c.body(null, 204)
      })

      // ---- 4.2 memberships ----
      .get('/projects/:slug/members', async (c) => c.json(await s.members.list(await access(c))))
      .post('/projects/:slug/members', async (c) => {
        const a = await access(c)
        const body = await readJson(c, memberAddRequest)
        return c.json(await s.members.add(a, body.email, body.role), 201)
      })
      .put('/projects/:slug/members/:userId', async (c) => {
        const a = await access(c)
        const body = await readJson(c, memberRoleRequest)
        return c.json(await s.members.setRole(a, uuidOr404(c.req.param('userId')), body.role))
      })
      .delete('/projects/:slug/members/:userId', async (c) => {
        const a = await access(c)
        await s.members.remove(a, uuidOr404(c.req.param('userId')))
        return c.body(null, 204)
      })
  )
}
