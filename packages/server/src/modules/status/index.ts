/**
 * Status module: the instance admin's "Status" page (api.md section 10.4), the "Usage" page
 * (`GET /status/usage`, usage.ts; ADR-0033) with the `resource-sample` job's sampler (sampler.ts; app.ts
 * registers it with the scheduler), and the update check behind the "newer release" notice
 * (`GET /status/update`, update-check.ts; bound as `ports.updates` in src/runtime.ts).
 * Mounted in app.ts with `api.route('/', status.routes)`; it reads the mcp module's session table and the scheduler through
 * `StatusSources`, never their internals.
 */
import { Hono } from 'hono'
import type { ServerDeps } from '../../lib/deps.js'
import { readQuery } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import { requireInstanceAdmin } from '../auth/index.js'
import { ResourceSampler } from './sampler.js'
import { StatusService, type StatusSources } from './service.js'
import { UsageService, usageQuery } from './usage.js'

export { cpuPercent, poolCounters, ResourceSampler } from './sampler.js'
export { type StatusJson, StatusService, type StatusSources } from './service.js'
export {
  createUpdateChecker,
  latestReleaseFile,
  type UpdateChecker,
  type UpdateCheckerOptions,
} from './update-check.js'
export { UsageService, usageQuery } from './usage.js'

export function createStatusModule(deps: ServerDeps, sources: StatusSources) {
  const service = new StatusService(deps, sources)
  const usage = new UsageService(deps)
  const sampler = new ResourceSampler(deps, sources)
  const routes = new Hono<AppEnv>()
    .get('/status', async (c) => {
      requireInstanceAdmin(c)
      c.header('Cache-Control', 'no-store')
      return c.json(await service.get())
    })
    // the usage page: request-log aggregates and host samples, refetched every 60 s (heavier than /status)
    .get('/status/usage', async (c) => {
      requireInstanceAdmin(c)
      const q = readQuery(c, usageQuery)
      c.header('Cache-Control', 'no-store')
      return c.json(await usage.get(q.range))
    })
    // the web shell's update notice: the cached update check only, none of the status queries
    .get('/status/update', (c) => {
      requireInstanceAdmin(c)
      c.header('Cache-Control', 'no-store')
      return c.json({ update: deps.ports.updates.current() })
    })
  return { name: 'status', service, usage, sampler, routes }
}
