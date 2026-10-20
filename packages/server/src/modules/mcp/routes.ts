/**
 * `POST|GET|DELETE /p/:slug/mcp` (docs/design/mcp.md sections 1 to 3): Streamable HTTP through the SDK's
 * web-standard transport, session-managed. Order per request:
 * 1. bearer token (the auth module's `bearerAuth`: 401 `invalid_token` + `WWW-Authenticate`, 403
 *    `token_project_mismatch`, effective role, `last_used_at` bump) on EVERY request;
 * 2. 405 for anything but POST and DELETE (Spoor sends no server-initiated messages, so no GET stream);
 * 3. 413 for a body over 1 MB, before the transport sees it;
 * 4. the session: an `initialize` without `Mcp-Session-Id` creates one (new McpServer for the role), a known
 *    id bound to the same token is served, anything else is 404 `Session not found` (the client
 *    re-initializes; a foreign token never learns that the session exists).
 */
import { randomUUID } from 'node:crypto'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { cleanLine } from '@spoor/shared'
import { eq } from 'drizzle-orm'
import { Hono, type MiddlewareHandler } from 'hono'
import { projects } from '../../db/schema.js'
import type { AuthContext } from '../../lib/auth-context.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError, apiErrorResponse, errorResponse, loggableError } from '../../lib/errors.js'
import { JSON_BODY_LIMIT } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import { bearerAuth, requireBearer } from '../auth/index.js'
import { resolveSettings } from '../projects/index.js'
import { buildAuthExtra, type McpServices } from './handlers.js'
import { buildMcpServer } from './server.js'
import type { McpSession, SessionStore } from './sessions.js'

const CLIENT_MAX = 64
const UA_MAX = 50

/** `claude-code/2.1.303` from initialize's clientInfo, else `ua:<User-Agent>`; cleaned, capped; null if neither. */
export function clientLabel(
  info: { name?: string; version?: string } | undefined,
  userAgent: string | undefined,
): string | null {
  if (info?.name) {
    const raw = info.version ? `${info.name}/${info.version}` : info.name
    const clean = [...cleanLine(raw)].slice(0, CLIENT_MAX).join('').trim()
    if (clean !== '') return clean
  }
  if (userAgent) {
    const ua = [...cleanLine(userAgent)].slice(0, UA_MAX).join('').trim()
    if (ua !== '') return `ua:${ua}`
  }
  return null
}

/** A JSON-RPC error body without an id, the shape the SDK transport uses for its HTTP-level errors. */
function rpcError(status: number, code: number, message: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

/** The body as text, or `null` when it is over `limit` bytes (declared or streamed). */
export async function readCapped(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limit) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    parts.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(parts))
}

const isInitialize = (body: unknown) =>
  Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body)

export interface McpRouteOptions {
  store: SessionStore
  services: McpServices
}

/** The id of `_shared` (for `authInfo.extra`); cached once found, it never changes. */
function sharedProjectIdLookup(deps: ServerDeps) {
  let cached: string | null = null
  return async (): Promise<string | null> => {
    if (cached) return cached
    const [row] = await deps.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.kind, 'shared'))
      .limit(1)
    cached = row?.id ?? null
    return cached
  }
}

/** The project's `memory.exclusive` setting, read when a session starts (ADR-0015). */
async function memoryExclusive(deps: ServerDeps, projectId: string): Promise<boolean> {
  const [row] = await deps.db
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  return resolveSettings(row?.settings).memory.exclusive
}

/** A request id and logger even when mounted outside app.ts's middleware (tests). */
const ensureRequestContext =
  (deps: ServerDeps): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (!c.get('requestId')) {
      const id = randomUUID()
      c.set('requestId', id)
      c.header('X-Request-Id', id)
    }
    if (!c.get('log')) c.set('log', deps.logger.child({ request_id: c.get('requestId') }))
    await next()
  }

export function mcpRoutes(deps: ServerDeps, { store, services }: McpRouteOptions) {
  const sharedProjectId = sharedProjectIdLookup(deps)

  const authInfoOf = (
    auth: AuthContext & { project: NonNullable<AuthContext['project']> },
    sharedId: string | null,
    requestId: string,
  ): AuthInfo => ({
    token: '<redacted>',
    clientId: auth.user?.id ?? `service:${auth.tokenId}`,
    scopes: auth.role ? [auth.role] : [],
    extra: { ...buildAuthExtra(auth, sharedId, requestId) },
  })

  const app = new Hono<AppEnv>()
  app.onError((err, c) => {
    if (err instanceof ApiError) return apiErrorResponse(c, err)
    c.get('log')?.error({ err: loggableError(err) }, 'mcp request failed')
    return errorResponse(c, 'internal', { message: 'Internal error.' })
  })
  app.use('*', ensureRequestContext(deps))
  app.use('*', bearerAuth(deps.db))

  app.all('/', async (c) => {
    const auth = requireBearer(c)
    const method = c.req.method
    if (method !== 'POST' && method !== 'DELETE') {
      return rpcError(405, -32000, 'Method not allowed.', { Allow: 'POST, DELETE' })
    }

    let parsedBody: unknown
    if (method === 'POST') {
      const text = await readCapped(c.req.raw, JSON_BODY_LIMIT)
      if (text === null) {
        return errorResponse(c, 'payload_too_large', { message: 'The request body is larger than 1 MB.' })
      }
      try {
        parsedBody = JSON.parse(text)
      } catch {
        return rpcError(400, -32700, 'Parse error: Invalid JSON')
      }
    }

    const requestId = c.get('requestId')
    const userAgent = c.req.header('user-agent')
    const sharedId = await sharedProjectId()
    const sessionId = c.req.header('mcp-session-id')

    if (sessionId) {
      const s = store.get(sessionId)
      // bound to the token that created it: any other token gets the same 404 as an unknown id
      if (!s || s.tokenId !== auth.tokenId || s.projectId !== auth.project.id) {
        return rpcError(404, -32001, 'Session not found')
      }
      store.touch(s)
      s.role = auth.role
      const ctx = { ...auth, clientName: s.client ?? clientLabel(undefined, userAgent) ?? undefined }
      return s.transport.handleRequest(c.req.raw, {
        authInfo: authInfoOf(ctx, sharedId, requestId),
        parsedBody,
      })
    }

    if (method === 'DELETE' || !isInitialize(parsedBody)) {
      return rpcError(400, -32000, 'Bad Request: Mcp-Session-Id header is required')
    }

    // a new session: its own server, with the tools of the role at initialize
    const mcp = buildMcpServer(services, auth.role, await memoryExclusive(deps, auth.project.id))
    let session: McpSession | undefined
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        session = {
          id,
          mcp,
          transport,
          tokenId: auth.tokenId as string,
          projectId: auth.project.id,
          role: auth.role,
          client: null,
          lastSeenAt: store.now(),
        }
        store.add(session)
      },
      onsessionclosed: (id) => store.remove(id),
    })
    await mcp.connect(transport)
    const res = await transport.handleRequest(c.req.raw, {
      authInfo: authInfoOf(auth, sharedId, requestId),
      parsedBody,
    })
    if (session) {
      session.client = clientLabel(mcp.server.getClientVersion(), userAgent)
    } else {
      await mcp.close().catch(() => {})
    }
    return res
  })

  return app
}
