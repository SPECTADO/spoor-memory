/**
 * Requests module: the agent request log (ADR-0018). `RequestLog` writes one row per MCP tool call (the MCP
 * module's tool wrapper) and per bearer REST call (`bearerRequestLog`, mounted after the bearer guards);
 * `RequestLogService` reads it for admins and the dashboard. The `purge-ephemeral` job deletes rows after
 * 14 days. Design: api.md 10.3, data-model.md 4.
 */
import type { ServerDeps } from '../../lib/deps.js'
import { RequestLog } from './log.js'
import { bearerRequestLog } from './middleware.js'
import { requestRoutes } from './routes.js'
import { RequestLogService } from './service.js'

export {
  common,
  REQUEST_HANDLES_MAX,
  REQUEST_QUERY_MAX,
  type RequestEntry,
  RequestLog,
  type RequestNote,
} from './log.js'
export { bearerRequestLog, bearerSubpath } from './middleware.js'
export { RequestLogService, requestLogQuery, requestRowJson } from './service.js'

export function createRequestsModule(deps: ServerDeps) {
  const log = new RequestLog(deps.db, deps.logger)
  const service = new RequestLogService(deps)
  return {
    name: 'requests',
    log,
    service,
    routes: requestRoutes(deps, service),
    /** After `bearerApiGuards` on `/p/:slug/api`. */
    bearerMiddleware: bearerRequestLog(log),
  }
}

export type RequestsModule = ReturnType<typeof createRequestsModule>
