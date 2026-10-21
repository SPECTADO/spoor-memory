import type { Logger } from 'pino'
import type { AuthContext } from './lib/auth-context.js'
import type { RequestNote } from './modules/requests/log.js'

export type AppEnv = {
  Variables: {
    requestId: string
    log: Logger
    /** Set by the session middleware (cookie) or the bearer middleware; undefined = anonymous. */
    auth: AuthContext | undefined
    /** sha256 of the session cookie of this request, when one is valid (password change keeps it). */
    sessionIdHash: Buffer | undefined
    /** Bearer REST: the request-log row of this call, which a route may enrich (ADR-0018). */
    requestNote: RequestNote | undefined
  }
}

/** Startup progress, flipped by index.ts; read by /healthz and the 503 `starting` gate. */
export interface ReadyState {
  db: 'loading' | 'ok' | 'failed'
  migrations: 'loading' | 'ok' | 'failed'
  embedding: 'loading' | 'ok' | 'failed'
  /** Set once every check has passed once; afterwards only the DB is re-checked. */
  ready: boolean
}

export const newReadyState = (): ReadyState => ({
  db: 'loading',
  migrations: 'loading',
  embedding: 'loading',
  ready: false,
})
