/**
 * Token routes: the cookie routes under /api/v1/projects/:slug/tokens (api.md section 4.3) and the bearer
 * route `GET /p/:slug/api/whoami` (api.md section 7.2).
 */
import { tokenCreateRequest } from '@spoor/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ServerDeps } from '../../lib/deps.js'
import { readJson, readQuery, uuidOr404 } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import { requireBearer, requireUser } from '../auth/index.js'
import { loadProjectAccess } from '../projects/index.js'
import type { TokenService } from './service.js'

const listQuery = z.strictObject({ include: z.enum(['revoked']).optional() })

export function tokenRoutes(deps: ServerDeps, tokens: TokenService) {
  const access = (c: Parameters<typeof requireUser>[0]) =>
    loadProjectAccess(deps.db, requireUser(c), c.req.param('slug') ?? '')
  return new Hono<AppEnv>()
    .get('/projects/:slug/tokens', async (c) => {
      const a = await access(c)
      const q = readQuery(c, listQuery)
      return c.json(await tokens.list(a, q.include === 'revoked'))
    })
    .post('/projects/:slug/tokens', async (c) => {
      const a = await access(c)
      const body = await readJson(c, tokenCreateRequest)
      return c.json(await tokens.create(a, body), 201)
    })
    .delete('/projects/:slug/tokens/:id', async (c) => {
      const a = await access(c)
      await tokens.revoke(a, uuidOr404(c.req.param('id')))
      return c.body(null, 204)
    })
}

/** Mounted under `/p/:slug/api` after the bearer guards. */
export function tokenBearerRoutes(tokens: TokenService) {
  return new Hono<AppEnv>().get('/whoami', async (c) => c.json(await tokens.whoami(requireBearer(c))))
}
