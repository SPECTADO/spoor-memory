/**
 * The maintenance gate of a full restore (ADR-0039, api.md section 13): while it is on, every route except
 * `GET /healthz` (registered before this middleware, so it never gets here) and
 * `GET /api/v1/backups/restore-status` answers 503 `maintenance` with `Retry-After: 5`, JSON on API routes and
 * text elsewhere. Requests in flight are counted so the restore can wait for them (`drain`).
 *
 * While the gate is on, restore-status is answered here, before the `/api/v1` guards: the session lookup would
 * read the database that is being replaced, and every session ends with the restore anyway. That answer is the
 * redacted one (no backup ids, no error text) for every caller.
 */
import type { RestoreStatusJson } from '@spoor/shared'
import type { MiddlewareHandler } from 'hono'
import { errorResponse } from '../../lib/errors.js'
import type { AppEnv } from '../../types.js'

export const RESTORE_STATUS_PATH = '/api/v1/backups/restore-status'
export const MAINTENANCE_RETRY_AFTER_S = 5

/** What anyone may see of a running restore (no ids, no error text). */
export function redactRestoreStatus(s: RestoreStatusJson): RestoreStatusJson {
  return { ...s, backup_id: null, pre_restore_backup_id: null, error: null }
}

export class MaintenanceGate {
  #on = false
  #inFlight = 0
  #waiters: (() => void)[] = []

  get on(): boolean {
    return this.#on
  }

  /** Requests being handled right now (restore-status and /healthz are not counted). */
  get inFlight(): number {
    return this.#inFlight
  }

  enable(): void {
    this.#on = true
  }

  disable(): void {
    this.#on = false
  }

  /**
   * Wait until no request is in flight, at most `timeoutMs`. Resolves true when drained, false on timeout (the
   * restore goes on: its `lock_timeout` then fails it cleanly if a straggler still holds a lock).
   */
  drain(timeoutMs: number): Promise<boolean> {
    if (this.#inFlight === 0) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== done)
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
      this.#waiters.push(done)
    })
  }

  #leave(): void {
    this.#inFlight--
    if (this.#inFlight === 0) {
      const waiters = this.#waiters
      this.#waiters = []
      for (const w of waiters) w()
    }
  }

  /** The app-wide middleware; `status` gives the restore status for the redacted restore-status answer. */
  middleware(status: () => Promise<RestoreStatusJson>): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
      const isStatus = c.req.path === RESTORE_STATUS_PATH && c.req.method === 'GET'
      if (this.#on) {
        if (isStatus) {
          c.header('Cache-Control', 'no-store')
          return c.json(redactRestoreStatus(await status()))
        }
        c.header('Retry-After', String(MAINTENANCE_RETRY_AFTER_S))
        if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/p/')) {
          return errorResponse(c, 'maintenance', {
            message: 'A full restore is running; Spoor is back in a few minutes.',
            hint: `Retry after ${MAINTENANCE_RETRY_AFTER_S} seconds. Everyone logs in again afterwards.`,
          })
        }
        return c.text('maintenance', 503)
      }
      if (isStatus) return next()
      this.#inFlight++
      try {
        await next()
      } finally {
        this.#leave()
      }
    }
  }
}
