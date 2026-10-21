/**
 * MCP module: the agent endpoint `/p/:slug/mcp` (docs/design/mcp.md). Streamable HTTP via the SDK's
 * web-standard transport, session-managed (one McpServer per session, bound to its token, idle TTL with a
 * sweep), bearer auth on every request, the client name from `initialize` on every write (`via='mcp'`), a
 * role-aware tool list, and the nine `spoor_*` tools, which delegate to the items and search services. Each
 * tool call is recorded in the request log (ADR-0018).
 *
 * Wiring: createAppModules (app.ts) builds it on the items module's ItemService and the search module's
 * SearchService / ContextService; createApp mounts `routes` at `/p/:slug/mcp` with no other guards; src/index.ts
 * calls `close()` on SIGTERM (stops the sweep, closes every session).
 */
import type { ServerDeps } from '../../lib/deps.js'
import type { ItemService } from '../items/index.js'
import { RequestLog } from '../requests/index.js'
import type { ContextService, SearchService } from '../search/index.js'
import { mcpRoutes } from './routes.js'
import { SESSION_SWEEP_MS, SessionStore, type SessionStoreOptions } from './sessions.js'

export { FRAMING_LINE } from './format.js'
export type { McpAuthExtra, McpServices } from './handlers.js'
export { clientLabel } from './routes.js'
export { buildMcpServer, toolsFor } from './server.js'
export {
  type McpSession,
  SESSION_IDLE_TTL_MS,
  SESSION_SWEEP_MS,
  SESSIONS_PER_TOKEN,
  SESSIONS_TOTAL,
  SessionStore,
} from './sessions.js'
export {
  INSTRUCTIONS,
  instructionsFor,
  READ_ONLY_INSTRUCTIONS,
  READ_TOOLS,
  TOOL_SPECS,
  type ToolName,
  WRITE_TOOLS,
} from './tools.js'

export interface McpModuleServices {
  items: ItemService
  search: SearchService
  context: ContextService
  /** The request log every tool call is recorded in; built on `deps` when not given. */
  requests?: RequestLog
}

export function createMcpModule(
  deps: ServerDeps,
  services: McpModuleServices,
  opts: { sessions?: SessionStoreOptions; sweepMs?: number | null } = {},
) {
  const store = new SessionStore(opts.sessions)
  const sweepMs = opts.sweepMs === undefined ? SESSION_SWEEP_MS : opts.sweepMs
  let timer: NodeJS.Timeout | null = null
  if (sweepMs !== null) {
    timer = setInterval(() => {
      const n = store.sweep()
      if (n > 0) deps.logger.debug({ swept: n }, 'mcp-session-sweep')
    }, sweepMs)
    timer.unref?.()
  }
  return {
    name: 'mcp',
    sessions: store,
    /** Mount on `/p/:slug/mcp` (no other guards: bearer auth and the 1 MB cap are inside). */
    routes: mcpRoutes(deps, {
      store,
      services: {
        requests: new RequestLog(deps.db, deps.logger),
        ...services,
        logger: deps.logger,
      },
    }),
    /** Stop the sweep and close every session (shutdown). */
    close() {
      if (timer) clearInterval(timer)
      timer = null
      store.closeAll()
    },
  }
}

export type McpModule = ReturnType<typeof createMcpModule>
