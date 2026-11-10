import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const BREAKER_MS = 5 * 60 * 1000

export class OfflineError extends Error {
  constructor(public until: number) {
    super('server marked offline by circuit breaker')
  }
}

export interface NetworkErrorExtra {
  /** HTTP status of a 5xx answer (absent for a transport failure). */
  status?: number
  /** `Retry-After` of a 5xx answer, in ms. */
  retryAfterMs?: number
  /** `error` of a 5xx answer's JSON body (`busy`, `starting`, ...). */
  apiCode?: string
}

export class NetworkError extends Error {
  status?: number
  retryAfterMs?: number
  apiCode?: string
  constructor(
    message: string,
    public code: string,
    extra: NetworkErrorExtra = {},
  ) {
    super(message)
    if (extra.status !== undefined) this.status = extra.status
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs
    if (extra.apiCode !== undefined) this.apiCode = extra.apiCode
  }
}

/** `Retry-After` as integer seconds (`^\d{1,4}$`) in ms; an HTTP date or anything else counts as absent. */
export function parseRetryAfter(v: string | null | undefined): number | undefined {
  if (typeof v !== 'string' || !/^\d{1,4}$/.test(v)) return undefined
  return Number(v) * 1000
}

/** Headers a caller's extra `headers` never replace. */
const RESERVED_HEADERS = new Set(['accept', 'authorization', 'content-type', 'user-agent'])

/** `ECONNREFUSED`, `ENOTFOUND`, `timeout`, ... from a fetch rejection. */
export function errorCode(e: unknown): string {
  if (!(e instanceof Error)) return 'error'
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'timeout'
  const cause = (e as { cause?: unknown }).cause
  if (cause && typeof cause === 'object') {
    const c = cause as { code?: unknown; name?: unknown; errors?: unknown }
    if (typeof c.code === 'string') return c.code
    const first = Array.isArray(c.errors) ? (c.errors[0] as { code?: unknown } | undefined) : undefined
    if (typeof first?.code === 'string') return first.code
    if (c.name === 'TimeoutError' || c.name === 'AbortError') return 'timeout'
  }
  return e.name
}

export interface BreakerDeps {
  repoRoot: string
  now: () => number
}

const file = (repoRoot: string) => join(repoRoot, '.spoor', 'offline-until')

/** Epoch ms until which the network must be skipped, or 0 when the breaker is closed. */
export function offlineUntil(d: BreakerDeps): number {
  try {
    const until = Number(readFileSync(file(d.repoRoot), 'utf8').trim())
    return Number.isFinite(until) && until > d.now() ? until : 0
  } catch {
    return 0
  }
}

export function tripBreaker(d: BreakerDeps): number {
  const until = d.now() + BREAKER_MS
  try {
    mkdirSync(join(d.repoRoot, '.spoor'), { recursive: true })
    writeFileSync(file(d.repoRoot), String(until))
  } catch {
    // best effort: a read-only repo must not break a hook
  }
  return until
}

export interface ClientOptions extends BreakerDeps {
  server: string
  token?: string
  timeoutMs?: number
  fetch?: typeof fetch
  /** Sent as `User-Agent`; the server records it as the client name of CLI writes (api.md section 7.2). */
  userAgent?: string
  /**
   * `check` (default, hooks): skip the network while the breaker is open and trip it on failure.
   * `trip`: never skip (a human or agent ran the command on purpose) but still trip it on failure.
   * `off`: neither (login, init, whoami).
   */
  breaker?: 'check' | 'trip' | 'off'
}

export interface Response<T = unknown> {
  status: number
  ok: boolean
  body: T
  headers?: Headers
}

export interface RequestOpts {
  body?: unknown
  timeoutMs?: number
  /** Extra request headers; they never override accept, authorization, content-type or user-agent. */
  headers?: Record<string, string>
}

export interface Client {
  request<T = unknown>(method: string, path: string, opts?: RequestOpts): Promise<Response<T>>
}

export function createClient(o: ClientOptions): Client {
  const doFetch = o.fetch ?? fetch
  return {
    async request<T>(method: string, path: string, opts: RequestOpts = {}) {
      const mode = o.breaker ?? 'check'
      if (mode === 'check') {
        const until = offlineUntil(o)
        if (until) throw new OfflineError(until)
      }
      const trip = () => {
        if (mode !== 'off') tripBreaker(o)
      }
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(opts.headers ?? {})) {
        const name = k.toLowerCase()
        if (!RESERVED_HEADERS.has(name)) headers[name] = v
      }
      headers.accept = 'application/json'
      if (o.token) headers.authorization = `Bearer ${o.token}`
      if (o.userAgent) headers['user-agent'] = o.userAgent
      const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? o.timeoutMs ?? 6000),
      }
      if (opts.body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(opts.body)
      }
      let res: globalThis.Response
      try {
        res = await doFetch(o.server + path, init)
      } catch (e) {
        trip()
        const code = errorCode(e)
        throw new NetworkError(`network failure (${code}) for ${o.server}`, code)
      }
      if (res.status >= 500) {
        const extra: NetworkErrorExtra = { status: res.status }
        try {
          const b = JSON.parse(await res.text()) as unknown
          const code = b && typeof b === 'object' ? (b as { error?: unknown }).error : undefined
          if (typeof code === 'string') extra.apiCode = code
        } catch {
          // no JSON body: no apiCode
        }
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'))
        if (retryAfterMs !== undefined) extra.retryAfterMs = retryAfterMs
        // back-pressure is not an outage: a busy answer must not silence the hooks for 5 minutes
        if (!(res.status === 503 && extra.apiCode === 'busy')) trip()
        throw new NetworkError(`server error ${res.status} from ${o.server}`, String(res.status), extra)
      }
      let text: string
      try {
        text = await res.text()
      } catch (e) {
        trip()
        const code = errorCode(e)
        throw new NetworkError(`network failure (${code}) for ${o.server}`, code)
      }
      let body: unknown = text
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        // keep raw text
      }
      return { status: res.status, ok: res.ok, body: body as T, headers: res.headers }
    },
  }
}
