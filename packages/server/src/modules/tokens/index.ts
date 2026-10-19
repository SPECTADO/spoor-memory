/**
 * Tokens module: user and service API tokens of a project (create, list, revoke), `mintToken` for the
 * device flow, and the bearer `whoami`. The bearer authentication itself lives in the auth module
 * (`bearerApiGuards`). Design: api.md 4.3 and 7.2, auth-and-security.md 5.
 */
import type { ServerDeps } from '../../lib/deps.js'
import { tokenBearerRoutes, tokenRoutes } from './routes.js'
import { TokenService } from './service.js'

export { type MintTokenInput, mintToken, TokenService, tokenJson } from './service.js'

export function createTokensModule(deps: ServerDeps) {
  const tokens = new TokenService(deps)
  return {
    name: 'tokens',
    tokens,
    routes: tokenRoutes(deps, tokens),
    /** Routes of `/p/:slug/api` (mount after `auth.bearerApiGuards`). */
    bearerRoutes: tokenBearerRoutes(tokens),
  }
}

export type TokensModule = ReturnType<typeof createTokensModule>
