/**
 * `GET /p/:slug/install.md` and `GET /p/:slug/install.json` (api.md sections 11.1 and 11.1a): public, no
 * cookie, no token, secret-free. Unknown slugs and `_shared` are 404 (text/plain for the Markdown page, the
 * JSON error body for install.json, which `spoor init` parses).
 */
import type { Context } from 'hono'
import { Hono } from 'hono'
import { ApiError } from '../../lib/errors.js'
import type { AppEnv } from '../../types.js'
import type { InstallService } from './service.js'
import { renderInstallJson, renderInstallMd } from './templates.js'

/** Mount at `/p/:slug` (public). */
export function installRoutes(install: InstallService) {
  const slugOf = (c: Context<AppEnv>) => c.req.param('slug') ?? ''
  return new Hono<AppEnv>()
    .get('/install.md', async (c) => {
      c.header('Cache-Control', 'no-cache')
      const v = await install.values(slugOf(c))
      if (!v) return c.text('not found', 404)
      c.header('Content-Type', 'text/markdown; charset=utf-8')
      return c.body(renderInstallMd(v), 200)
    })
    .get('/install.json', async (c) => {
      c.header('Cache-Control', 'no-cache')
      const v = await install.values(slugOf(c))
      if (!v) throw new ApiError('not_found', { message: 'No such project.' })
      return c.json(renderInstallJson(v))
    })
}
