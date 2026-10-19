import { ERROR_STATUS, type ErrorCode } from '@spoor/shared'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { z } from 'zod'
import type { AppEnv } from '../types.js'

/** Optional parts of the flat error body (api.md section 0.4). `error` and `request_id` are always set. */
export interface ErrorExtra {
  message?: string
  hint?: string
  details?: Record<string, unknown>
}

/**
 * Throw from any service or route; `app.onError` turns it into the api.md error body with the status of
 * `ERROR_STATUS[code]`. Never put tokens, SQL, stack traces or other users' emails into it.
 */
export class ApiError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly hint?: string
  readonly details?: Record<string, unknown>

  constructor(code: ErrorCode, extra: ErrorExtra = {}) {
    super(extra.message ?? code)
    this.name = 'ApiError'
    this.code = code
    this.status = ERROR_STATUS[code]
    this.hint = extra.hint
    this.details = extra.details
  }

  /** The `message` to send: only an explicitly given one (the default `code` is not repeated). */
  get publicMessage(): string | undefined {
    return this.message === this.code ? undefined : this.message
  }
}

/** Zod issues as `details.issues = [{path:"tags.0", message}]`. */
export function zodIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }))
}

export function invalidInput(error: z.ZodError, message = 'Invalid input.'): ApiError {
  return new ApiError('invalid_input', { message, details: { issues: zodIssues(error) } })
}

/** Flat error body of api.md section 0.4. */
export function errorResponse(c: Context<AppEnv>, code: ErrorCode, extra: ErrorExtra = {}) {
  const status = ERROR_STATUS[code] as ContentfulStatusCode
  const body: Record<string, unknown> = { error: code }
  if (extra.message !== undefined) body.message = extra.message
  if (extra.hint !== undefined) body.hint = extra.hint
  if (extra.details !== undefined) body.details = extra.details
  body.request_id = c.get('requestId')
  return c.json(body, status)
}

export function apiErrorResponse(c: Context<AppEnv>, err: ApiError) {
  return errorResponse(c, err.code, { message: err.publicMessage, hint: err.hint, details: err.details })
}

/** What to log for an unexpected error: never query parameters (they can carry hashes or user text). */
export function loggableError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { value: String(err) }
  // frames only: the stack's first line repeats the message, which for a query error holds the params
  const frames = (err.stack ?? '').split('\n').filter((l) => /^\s+at /.test(l))
  const out: Record<string, unknown> = { name: err.name, stack: frames.slice(0, 8).join('\n') }
  const q = (err as { query?: unknown }).query
  if (typeof q === 'string') out.query = q
  else out.message = err.message
  const cause = (err as { cause?: unknown }).cause
  if (cause instanceof Error) {
    out.cause = { name: cause.name, message: cause.message, code: (cause as { code?: unknown }).code }
  }
  return out
}
