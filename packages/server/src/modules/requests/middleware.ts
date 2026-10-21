/**
 * Logs every call of the bearer REST API (`/p/:slug/api/*`, the spoor CLI and its hooks) to the request log
 * (ADR-0018). Mounted after the bearer guards, so only authenticated calls are logged. A route may enrich its
 * row through `c.get('requestNote')`. `GET /whoami` is a login check, not a memory access, and is skipped.
 */
import type { RequestKind } from '@spoor/shared'
import type { MiddlewareHandler } from 'hono'
import { ApiError } from '../../lib/errors.js'
import type { AppEnv } from '../../types.js'
import { requireBearer } from '../auth/index.js'
import type { RequestLog, RequestNote } from './log.js'

const SKIP = new Set(['GET /whoami'])

/** The space a push route writes, from its path. */
const PATH_SPACE: Record<string, string> = {
  '/adr/push': 'decisions',
  '/adr/import': 'decisions',
  '/docs/push': 'docs',
}

/** `/p/acme/api/context` → `/context`. */
export function bearerSubpath(path: string): string {
  const m = /^\/p\/[^/]+\/api(\/.*)?$/.exec(path)
  return m?.[1] ?? path
}

export function bearerRequestLog(log: RequestLog): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const sub = bearerSubpath(c.req.path)
    const operation = `${c.req.method} ${sub}`
    if (SKIP.has(operation)) return next()
    const auth = requireBearer(c)
    const note: RequestNote = { space: PATH_SPACE[sub] ?? null }
    c.set('requestNote', note)
    const kind: RequestKind = c.req.method === 'GET' ? 'read' : 'write'
    const start = performance.now()
    let outcome = 'ok'
    let status: number | undefined
    try {
      await next()
      // a route's error is turned into the response by the app's onError before this resumes; `c.error` keeps it
      status = c.res.status
      if (c.error instanceof ApiError) outcome = c.error.code
      else if (status >= 400) outcome = c.error ? 'internal' : `http_${status}`
    } catch (err) {
      outcome = err instanceof ApiError ? err.code : 'internal'
      throw err
    } finally {
      await log.record({
        auth,
        kind,
        surface: 'cli',
        operation,
        note: { ...note, data: { ...note.data, status } },
        outcome,
        durationMs: performance.now() - start,
      })
    }
  }
}
