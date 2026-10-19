/**
 * Jobs-module routes. Cookie surface (mounted at /api/v1): the project dashboard (api.md section 4.1), the
 * review queue lists (api.md section 8; the bulk action is the items module's), job status (api.md section
 * 10), the admin "run now" trigger and the cookie twin of `decisions/undrafted` (api.md section 8). Bearer surface (mounted at /p/:slug/api):
 * `GET decisions/undrafted` (api.md section 7.2).
 */
import { Hono } from 'hono'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError } from '../../lib/errors.js'
import { readQuery } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import {
  assertCan,
  bearerPrincipal,
  requireBearer,
  requireInstanceAdmin,
  requireUser,
} from '../auth/index.js'
import { loadProjectAccess } from '../projects/index.js'
import type { DashboardService } from './dashboard.js'
import {
  REVIEW_SECTIONS,
  type ReviewSection,
  type ReviewService,
  reviewListQuery,
  undraftedQuery,
  webUndraftedQuery,
} from './review.js'
import type { JobStatusService } from './status.js'

const isSection = (s: string): s is ReviewSection => (REVIEW_SECTIONS as readonly string[]).includes(s)

export function jobsRoutes(
  deps: ServerDeps,
  s: { review: ReviewService; status: JobStatusService; dashboard: DashboardService },
) {
  const access = (c: Parameters<typeof requireUser>[0]) =>
    loadProjectAccess(deps.db, requireUser(c), c.req.param('slug') ?? '')
  return (
    new Hono<AppEnv>()
      .get('/projects/:slug/dashboard', async (c) => c.json(await s.dashboard.get(await access(c))))
      .get('/projects/:slug/review', async (c) => c.json(await s.review.counts(await access(c))))
      .get('/projects/:slug/review/:section', async (c) => {
        const a = await access(c)
        const section = c.req.param('section')
        if (!isSection(section)) throw new ApiError('not_found', { message: 'No such review section.' })
        return c.json(await s.review.list(a, section, readQuery(c, reviewListQuery)))
      })
      // the review queue's "Undrafted decisions" list (api.md section 8): any member, read-only
      .get('/projects/:slug/decisions/undrafted', async (c) => {
        const a = await access(c)
        a.assert('project.read')
        const q = readQuery(c, webUndraftedQuery)
        return c.json(await s.review.undrafted({ project: a.project, user: a.ctx.user }, q))
      })
      .get('/projects/:slug/jobs', async (c) => c.json(await s.status.project(await access(c))))
      .get('/jobs', async (c) => {
        requireInstanceAdmin(c)
        return c.json(await s.status.instance())
      })
      .post('/jobs/:name/run', async (c) => {
        const ctx = requireInstanceAdmin(c)
        const result = await s.status.runNow(ctx, c.req.param('name'))
        return c.json(result, result.started ? 202 : 200)
      })
  )
}

/** Mounted under `/p/:slug/api` after the bearer guards. */
export function jobsBearerRoutes(review: ReviewService) {
  return new Hono<AppEnv>().get('/decisions/undrafted', async (c) => {
    const ctx = requireBearer(c)
    assertCan(bearerPrincipal(ctx), 'project.read')
    return c.json(await review.undrafted(ctx, readQuery(c, undraftedQuery)))
  })
}
