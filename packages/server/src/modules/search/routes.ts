/**
 * Search and digest routes (docs/design/api.md sections 4.1, 6 and 7.1):
 * - cookie (`/api/v1`): `GET /projects/:slug/search`, `GET /projects/:slug/context` (admin preview);
 * - bearer (`/p/:slug/api`): `GET /context` for the SessionStart hook.
 * None of them bumps `last_used_at`.
 */
import { ANCHOR_MAX_LENGTH, MEMORY_MODE_HEADER, spaces } from '@spoor/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { MEMORY_TYPES } from '../../db/schema.js'
import type { ServerDeps } from '../../lib/deps.js'
import { readQuery } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import { requireBearer, requireUser } from '../auth/index.js'
import { loadProjectAccess } from '../projects/index.js'
import { BUDGET_MAX, BUDGET_MIN, type ContextService } from './context.js'
import { loadItemSummaries } from './format.js'
import type { SearchService } from './service.js'

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1'))

const many = <T extends z.ZodType>(item: T, max: number) =>
  z.preprocess((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]), z.array(item).max(max))

export const contextQuery = z.strictObject({
  budget: z.coerce.number().int().min(BUDGET_MIN).max(BUDGET_MAX).optional(),
  query: z.string().max(500).optional(),
  file: many(z.string().min(1).max(ANCHOR_MAX_LENGTH), 200),
  include_shared: bool(true),
  format: z.enum(['text', 'json']).default('text'),
})

export const searchQuery = z.strictObject({
  q: z.string().trim().min(1).max(500),
  space: z.enum(spaces).optional(),
  type: z.enum(MEMORY_TYPES).optional(),
  tag: many(z.string().min(1).max(40), 5),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  include_shared: bool(true),
  include_inactive: bool(false),
})

export interface SearchRouteServices {
  search: SearchService
  context: ContextService
}

async function contextResponse(c: Context<AppEnv>, services: SearchRouteServices, projectId: string) {
  const q = readQuery(c, contextQuery)
  const res = await services.context.build({
    projectId,
    budget: q.budget,
    query: q.query ?? null,
    files: q.file,
    includeShared: q.include_shared,
  })
  c.header('Cache-Control', 'no-store')
  // the SessionStart hook checks the repo's AGENTS.md block against it (cli-and-hooks.md section 5.1, ADR-0015)
  c.header(MEMORY_MODE_HEADER, res.memoryExclusive ? 'exclusive' : 'shared')
  if (q.format === 'json') {
    return c.json({
      text: res.text,
      budget: res.budget,
      est_tokens: res.estTokens,
      items: res.items,
      dropped: res.dropped,
    })
  }
  c.header('Content-Type', 'text/plain; charset=utf-8')
  return c.body(res.text, 200)
}

/** Cookie routes, mounted on `/api/v1` after the cookie guards. */
export function searchRoutes(deps: ServerDeps, services: SearchRouteServices) {
  const access = async (c: Context<AppEnv>) => {
    const a = await loadProjectAccess(deps.db, requireUser(c), c.req.param('slug') ?? '')
    a.assert('project.read')
    return a
  }
  return new Hono<AppEnv>()
    .get('/projects/:slug/search', async (c) => {
      const a = await access(c)
      const q = readQuery(c, searchQuery)
      const res = await services.search.search({
        projectId: a.project.id,
        query: q.q,
        spaces: q.space ? [q.space] : undefined,
        type: q.type ?? null,
        tags: q.tag,
        limit: q.limit,
        includeShared: q.include_shared && !a.shared,
        includeInactive: q.include_inactive,
      })
      const summaries = await loadItemSummaries(
        deps.db,
        res.hits.map((h) => h.id),
        a.shared,
      )
      return c.json({
        items: res.hits.flatMap((h) => {
          const item = summaries.get(h.id)
          return item ? [{ item, score: h.score, snippet: h.snippet }] : []
        }),
        notes: res.notes,
      })
    })
    .get('/projects/:slug/context', async (c) => {
      const a = await access(c)
      return contextResponse(c, services, a.project.id)
    })
}

/** Bearer routes, mounted on `/p/:slug/api` after the bearer guards (any role). */
export function searchBearerRoutes(services: SearchRouteServices) {
  return new Hono<AppEnv>().get('/context', async (c) => {
    const auth = requireBearer(c)
    return contextResponse(c, services, auth.project.id)
  })
}
