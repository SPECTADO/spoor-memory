import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const BREAKER_MS = 5 * 60 * 1000

export class OfflineError extends Error {
  constructor(public until: number) {
    super('server marked offline by circuit breaker')
  }
}

export class NetworkError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message)
  }
}

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
}

export interface Client {
  request<T = unknown>(
    method: string,
    path: string,
    opts?: { body?: unknown; timeoutMs?: number },
  ): Promise<Response<T>>
}

export function createClient(o: ClientOptions): Client {
  const doFetch = o.fetch ?? fetch
  return {
    async request<T>(method: string, path: string, opts: { body?: unknown; timeoutMs?: number } = {}) {
      const mode = o.breaker ?? 'check'
      if (mode === 'check') {
        const until = offlineUntil(o)
        if (until) throw new OfflineError(until)
      }
      const trip = () => {
        if (mode !== 'off') tripBreaker(o)
      }
      const headers: Record<string, string> = { accept: 'application/json' }
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
        trip()
        throw new NetworkError(`server error ${res.status} from ${o.server}`, String(res.status))
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
      return { status: res.status, ok: res.ok, body: body as T }
    },
  }
}
