/**
 * The mirror's bearer routes under `/p/:slug/api` (api.md section 7.2): `GET activity`, and
 * `POST adr/push` / `POST docs/push`, the per-space forms of `POST push` (items module) that the
 * `spoor adr push` / `spoor docs push` commands may call. All push semantics (matching, fast-forward,
 * `pushed_over_spoor_edit`, `force`, renumbering, `ambiguous_ref`, write-back data) are the items module's
 * PushService; these routes only fix the space.
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import { readJson, readQuery } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import { assertCan, bearerPrincipal, requireBearer } from '../auth/index.js'
import type { Caller, PushService } from '../items/index.js'
import { activityQuery, spacePushRequest } from './schemas.js'
import type { ActivityService } from './service.js'

/** Mount on `/p/:slug/api` after `auth.bearerApiGuards`. */
export function mirrorBearerRoutes(push: PushService, activity: ActivityService) {
  const writer = (c: Context<AppEnv>): Caller => {
    const ctx = requireBearer(c)
    assertCan(bearerPrincipal(ctx, 'rest'), 'item.write', { shared: false })
    return {
      ctx,
      via: 'cli',
      project: { id: ctx.project.id, slug: ctx.project.slug, kind: ctx.project.kind },
    }
  }
  const pushTo = (space: 'decisions' | 'docs') => async (c: Context<AppEnv>) => {
    const caller = writer(c)
    const body = await readJson(c, spacePushRequest)
    return c.json(await push.push(caller, { space, ...body }))
  }
  return new Hono<AppEnv>()
    .get('/activity', async (c) => {
      const ctx = requireBearer(c)
      assertCan(bearerPrincipal(ctx, 'rest'), 'project.read')
      c.header('Cache-Control', 'no-store')
      return c.json(await activity.writes(ctx, readQuery(c, activityQuery).since))
    })
    .post('/adr/push', pushTo('decisions'))
    .post('/docs/push', pushTo('docs'))
}
