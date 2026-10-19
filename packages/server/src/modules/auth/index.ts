/**
 * Auth module: passwords, sessions, the cookie-surface guards, login/logout/me, invites (incl. password
 * reset) and instance-admin user management. Design: docs/design/auth-and-security.md, api.md 1 and 2.
 *
 * Public surface for other modules: the guards (`requireUser`, `requireInstanceAdmin`), the bearer-token
 * authentication of `/p/:slug/api` and `/p/:slug/mcp` (`bearerApiGuards`, `authenticateBearer`), the
 * permission matrix (`can`, `assertCan`), the AuthContext helpers in src/lib/auth-context.ts, and
 * `bootstrapAdmin` for startup.
 */
import type { MiddlewareHandler } from 'hono'
import type { ServerDeps } from '../../lib/deps.js'
import type { AppEnv } from '../../types.js'
import { bearerApiGuards } from './bearer.js'
import { InviteService } from './invites.js'
import { jsonBodyLimit, originCheck, rejectAuthorizationHeader, sessionAuth } from './middleware.js'
import { PasswordHasher } from './passwords.js'
import { authRoutes } from './routes.js'
import { AuthService, UserService } from './service.js'

export {
  authenticateBearer,
  bearerApiGuards,
  bearerAuth,
  bearerTokenOf,
  clientNameFromUserAgent,
  requireBearer,
} from './bearer.js'
export { type BootstrapResult, bootstrapAdmin } from './bootstrap.js'
export { revokeUnbackedInvites } from './invites.js'
export { requireInstanceAdmin, requireUser, securityHeaders, type UserContext } from './middleware.js'
export { PasswordHasher } from './passwords.js'
export {
  ACTIONS,
  type Action,
  assertCan,
  type BearerPrincipal,
  bearerPrincipal,
  can,
  type Principal,
  type Surface,
  type Target,
  type WebPrincipal,
  webPrincipal,
} from './permissions.js'
export { sessionCookieName } from './sessions.js'

export function createAuthModule(deps: ServerDeps) {
  const hasher = new PasswordHasher()
  const auth = new AuthService(deps, hasher)
  const invites = new InviteService(deps, hasher)
  const users = new UserService(deps)

  /** Guards every `/api/v1/*` request goes through before any module's routes. */
  const cookieApiGuards: MiddlewareHandler<AppEnv>[] = [
    rejectAuthorizationHeader,
    jsonBodyLimit,
    originCheck(deps.config.publicOrigin),
    sessionAuth(deps.db, deps.config),
  ]

  return {
    name: 'auth',
    hasher,
    auth,
    invites,
    users,
    cookieApiGuards,
    /** Guards of `/p/:slug/api/*`: bearer token (cookies ignored), then the 1 MB body cap. */
    bearerApiGuards: bearerApiGuards(deps.db),
    routes: authRoutes(deps, { auth, invites, users }),
  }
}

export type AuthModule = ReturnType<typeof createAuthModule>
