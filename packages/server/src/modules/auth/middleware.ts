/**
 * Request guards of the cookie surface `/api/v1/*` (auth-and-security.md sections 1, 3, 4; api.md 0.1).
 * Order on `/api/v1`: rejectAuthorizationHeader → jsonBodyLimit → originCheck → sessionAuth, then routes.
 */
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Config } from '../../config.js'
import type { AuthContext, AuthUser } from '../../lib/auth-context.js'
import type { Db } from '../../lib/db.js'
import { ApiError, errorResponse } from '../../lib/errors.js'
import { JSON_BODY_LIMIT } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import { clearSessionCookie, loadSession, readSessionCookie } from './sessions.js'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Import uploads (multipart, own 50 MB cap): `POST /api/v1/projects/import`, `.../projects/:slug/import`. */
export const isImportUpload = (path: string) => /^\/api\/v1\/projects\/(?:[^/]+\/)?import$/.test(path)

/** CSP and friends on every response, including 503 `starting` and errors (section 4). */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next()
  try {
    c.res.headers.set(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    )
    c.res.headers.set('X-Content-Type-Options', 'nosniff')
    c.res.headers.set('Referrer-Policy', 'same-origin')
  } catch {
    // immutable headers (a proxied Response): leave them
  }
}

/** Cookie routes never take bearer tokens: an `Authorization` header is 400 (api.md 0.1). */
export const rejectAuthorizationHeader: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.header('authorization') !== undefined) {
    throw new ApiError('invalid_input', {
      message: 'The cookie API does not accept an Authorization header.',
      hint: 'Bearer tokens work only on /p/<slug>/api and /p/<slug>/mcp.',
    })
  }
  await next()
}

/** 1 MB on JSON bodies; the import upload enforces its own 50 MB cap. */
export const jsonBodyLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (isImportUpload(c.req.path)) return next()
  return bodyLimit({
    maxSize: JSON_BODY_LIMIT,
    onError: (ctx) =>
      errorResponse(ctx as Context<AppEnv>, 'payload_too_large', {
        message: 'The request body is larger than 1 MB.',
      }),
  })(c, next)
}

/** A body is present when Content-Length is non-zero or the body is chunked. */
function hasBody(c: Context): boolean {
  const len = c.req.header('content-length')
  if (len !== undefined) return len.trim() !== '0'
  return c.req.header('transfer-encoding') !== undefined
}

/**
 * Origin defence for every unsafe method on `/api/v1` (section 4), logged in or not:
 * 1. `Origin`, when present, must equal SPOOR_PUBLIC_URL's origin (never derived from Host);
 * 2. without `Origin`, `Sec-Fetch-Site` must be `same-origin`; 3. neither → 403 `forbidden_origin`;
 * 4. a request that carries a body must be `application/json` (multipart only for the import upload);
 *    bodyless unsafe requests (logout, item actions, DELETE) rely on 1 to 3 alone (deviation I28).
 */
export function originCheck(publicOrigin: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next()
    const origin = c.req.header('origin')
    const ok =
      origin !== undefined ? origin === publicOrigin : c.req.header('sec-fetch-site') === 'same-origin'
    if (!ok) {
      throw new ApiError('forbidden_origin', {
        message: 'Cross-origin request refused.',
        hint: 'Requests must come from the Spoor web UI at SPOOR_PUBLIC_URL.',
      })
    }
    if (hasBody(c)) {
      const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
      const allowed =
        type === 'application/json' || (type === 'multipart/form-data' && isImportUpload(c.req.path))
      if (!allowed) {
        throw new ApiError('invalid_input', { message: 'Content-Type must be application/json.' })
      }
    }
    return next()
  }
}

/** Resolve the session cookie into `auth`; an invalid or expired cookie is cleared and ignored. */
export function sessionAuth(db: Db, config: Pick<Config, 'cookieSecure'>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const sid = readSessionCookie(c, config)
    if (sid !== undefined) {
      const session = await loadSession(db, sid)
      if (session) {
        c.set('auth', { user: session.user, project: null, role: null, via: 'cookie', clientName: 'web' })
        c.set('sessionIdHash', session.idHash)
      } else {
        clearSessionCookie(c, config)
      }
    }
    await next()
  }
}

export type UserContext = AuthContext & { user: AuthUser }

/** The logged-in user of a cookie request, or 401 `unauthenticated`. */
export function requireUser(c: Context<AppEnv>): UserContext {
  const auth = c.get('auth')
  if (!auth?.user) throw new ApiError('unauthenticated', { message: 'Log in first.' })
  return auth as UserContext
}

/** Instance admins only: 401 without a session, 403 `forbidden` for everyone else. */
export function requireInstanceAdmin(c: Context<AppEnv>): UserContext {
  const auth = requireUser(c)
  if (!auth.user.isAdmin) throw new ApiError('forbidden', { message: 'Instance admins only.' })
  return auth
}
