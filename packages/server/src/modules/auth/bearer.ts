/**
 * Bearer-token authentication for `/p/:slug/api/*` (and, later, `/p/:slug/mcp`): mcp.md section 2 steps 1
 * to 5, auth-and-security.md section 5. Cookies are never read here. Every step runs on every request, so a
 * revoked token, a removed membership or a demotion takes effect on the next call (no caching).
 */
import { cleanLine, looksLikeToken } from '@spoor/shared'
import { and, eq, sql } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { memberships, projects, tokens, users } from '../../db/schema.js'
import { type AuthContext, capRole, effectiveRole } from '../../lib/auth-context.js'
import { sha256 } from '../../lib/crypto.js'
import type { DbOrTx } from '../../lib/db.js'
import { ApiError, errorResponse } from '../../lib/errors.js'
import { JSON_BODY_LIMIT } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'

const CLIENT_NAME_MAX = 64

/** `spoor-cli/0.1.0` from the User-Agent, control and bidi characters stripped, at most 64 characters. */
export function clientNameFromUserAgent(ua: string | undefined): string | undefined {
  if (ua === undefined) return undefined
  const clean = [...cleanLine(ua)].slice(0, CLIENT_NAME_MAX).join('').trim()
  return clean === '' ? undefined : clean
}

function invalidToken(slug: string): ApiError {
  return new ApiError('invalid_token', {
    message: 'Missing, unknown, revoked or expired token.',
    hint: `Run \`spoor login\`, or follow /p/${encodeURIComponent(slug)}/install.md.`,
  })
}

/** `Authorization: Bearer <token>` → the token, or undefined. The scheme is case-insensitive (RFC 6750). */
export function bearerTokenOf(header: string | undefined): string | undefined {
  const m = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header ?? '')
  return m?.[1]
}

/**
 * Resolve a bearer token for the project `slug` into an AuthContext, or throw:
 * 401 `invalid_token` (missing, unknown, revoked, expired, disabled user, user no longer a member), then
 * 403 `token_project_mismatch` (a valid token of another project). The slug is checked only after the
 * token, so an invalid token gets 401 whether or not the slug exists. Bumps `last_used_at` at most once a
 * minute.
 */
export async function authenticateBearer(
  db: DbOrTx,
  authorization: string | undefined,
  slug: string,
  userAgent?: string,
): Promise<AuthContext> {
  const secret = bearerTokenOf(authorization)
  if (secret === undefined || !looksLikeToken(secret)) throw invalidToken(slug)

  const [row] = await db
    .select({
      id: tokens.id,
      kind: tokens.kind,
      name: tokens.name,
      prefix: tokens.prefix,
      cap: tokens.role,
      revoked: sql<boolean>`${tokens.revokedAt} IS NOT NULL`,
      expired: sql<boolean>`${tokens.expiresAt} IS NOT NULL AND ${tokens.expiresAt} <= now()`,
      usedRecently: sql<boolean>`${tokens.lastUsedAt} IS NOT NULL AND ${tokens.lastUsedAt} > now() - interval '1 minute'`,
      project: { id: projects.id, slug: projects.slug, name: projects.name, kind: projects.kind },
      userId: users.id,
      email: users.email,
      userName: users.name,
      isAdmin: users.isAdmin,
      sharedEditor: users.sharedEditor,
      disabled: sql<boolean>`${users.disabledAt} IS NOT NULL`,
      membership: memberships.role,
    })
    .from(tokens)
    .innerJoin(projects, eq(projects.id, tokens.projectId))
    .leftJoin(users, eq(users.id, tokens.userId))
    .leftJoin(
      memberships,
      and(eq(memberships.projectId, tokens.projectId), eq(memberships.userId, tokens.userId)),
    )
    .where(eq(tokens.tokenHash, sha256(secret)))
    .limit(1)

  // tokens never target the shared project (data-model.md section 2); such a row is treated as unknown
  if (!row || row.revoked || row.expired || row.project.kind !== 'project') throw invalidToken(slug)

  let ctx: AuthContext
  if (row.kind === 'service') {
    if (row.cap === null) throw invalidToken(slug) // excluded by tokens_kind_shape_check
    ctx = { user: null, project: row.project, role: row.cap, via: 'bearer' }
  } else {
    if (row.userId === null || row.email === null || row.disabled) throw invalidToken(slug)
    const isAdmin = row.isAdmin === true
    const role = capRole(effectiveRole(isAdmin, row.membership), row.cap)
    if (role === null) throw invalidToken(slug) // no membership and not an instance admin
    ctx = {
      user: {
        id: row.userId,
        email: row.email,
        name: row.userName ?? '',
        isAdmin,
        sharedEditor: row.sharedEditor === true,
      },
      project: row.project,
      role,
      via: 'bearer',
    }
  }

  if (row.project.slug !== slug) {
    throw new ApiError('token_project_mismatch', {
      message: 'This token belongs to another project.',
      hint: 'Use the token created for this project, or run `spoor login` in this repository.',
    })
  }

  if (!row.usedRecently) {
    await db
      .update(tokens)
      .set({ lastUsedAt: sql`now()` })
      .where(
        and(
          eq(tokens.id, row.id),
          sql`(${tokens.lastUsedAt} IS NULL OR ${tokens.lastUsedAt} < now() - interval '1 minute')`,
        ),
      )
  }

  return {
    ...ctx,
    tokenId: row.id,
    tokenName: row.name,
    tokenKind: row.kind,
    tokenPrefix: row.prefix,
    clientName: clientNameFromUserAgent(userAgent),
  }
}

/** 1 MB on JSON bodies of the bearer API (api.md section 0.1). */
const bearerBodyLimit: MiddlewareHandler<AppEnv> = bodyLimit({
  maxSize: JSON_BODY_LIMIT,
  onError: (ctx) =>
    errorResponse(ctx as Context<AppEnv>, 'payload_too_large', {
      message: 'The request body is larger than 1 MB.',
    }),
})

/** Sets `auth` for `/p/:slug/api/*`; failures carry `WWW-Authenticate: Bearer realm="spoor"` on 401. */
export function bearerAuth(db: DbOrTx): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const slug = c.req.param('slug') ?? ''
    try {
      c.set(
        'auth',
        await authenticateBearer(db, c.req.header('authorization'), slug, c.req.header('user-agent')),
      )
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_token') {
        c.header('WWW-Authenticate', 'Bearer realm="spoor"')
      }
      throw err
    }
    await next()
  }
}

/** The guard chain of `/p/:slug/api/*`: token first (401 beats 413 for strangers), then the body cap. */
export function bearerApiGuards(db: DbOrTx): MiddlewareHandler<AppEnv>[] {
  return [bearerAuth(db), bearerBodyLimit]
}

/** The AuthContext of a bearer route (set by `bearerAuth`); a programming error if missing. */
export function requireBearer(
  c: Context<AppEnv>,
): AuthContext & { project: NonNullable<AuthContext['project']> } {
  const auth = c.get('auth')
  if (auth?.via !== 'bearer' || !auth.project) throw new ApiError('invalid_token')
  return auth as AuthContext & { project: NonNullable<AuthContext['project']> }
}
