/**
 * The one fetch wrapper of the SPA (docs/design/web-ui.md §3). Every call goes to `/api/v1` on the same
 * origin with the session cookie; every non-2xx answer becomes an `ApiError` carrying the flat error body of
 * docs/design/api.md §0.4.
 */
import type { ApiErrorBody, ErrorCode } from '@spoor/shared'

export type { ApiErrorBody, ErrorCode }

export const API_PREFIX = '/api/v1'

/** One issue of a 400 `invalid_input` (`details.issues`). */
export interface ApiIssue {
  path: string
  message: string
}

/** Thrown for every non-2xx response (and for network failures, with status 0 and code `network`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | null,
  ) {
    super(
      body?.message ?? body?.error ?? (status === 0 ? 'The server could not be reached.' : `HTTP ${status}`),
    )
    this.name = 'ApiError'
  }
  /** Stable machine code (`revision_conflict`, …); `network` when no response arrived. */
  get code(): ErrorCode | 'network' | 'unknown' {
    if (this.status === 0) return 'network'
    return this.body?.error ?? 'unknown'
  }
  get hint(): string | undefined {
    return this.body?.hint
  }
  get details(): Record<string, unknown> | undefined {
    return this.body?.details
  }
  get requestId(): string | undefined {
    return this.body?.request_id
  }
  /** `details.issues` of a 400 `invalid_input`, or an empty list. */
  get issues(): ApiIssue[] {
    const raw = this.body?.details?.issues
    return Array.isArray(raw)
      ? raw.filter((i): i is ApiIssue => typeof i?.path === 'string' && typeof i?.message === 'string')
      : []
  }
}

export const isApiError = (e: unknown, code?: string): e is ApiError =>
  e instanceof ApiError && (code === undefined || e.code === code)

export type QueryValue = string | number | boolean | null | undefined
export type QueryParams = Record<string, QueryValue | readonly QueryValue[]>

/** `?a=1&tag=x&tag=y`; `undefined`, `null` and `''` are left out, arrays repeat the key. */
export function toQueryString(params?: QueryParams): string {
  if (!params) return ''
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    const values = Array.isArray(v) ? v : [v]
    for (const x of values as QueryValue[]) {
      if (x === undefined || x === null || x === '') continue
      sp.append(k, String(x))
    }
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

/** Encode one path segment (slugs, refs, ids). */
export const seg = (s: string | number): string => encodeURIComponent(String(s))

/** Only same-origin relative paths: an absolute URL would send the session cookie elsewhere. */
export function apiUrl(path: string, query?: QueryParams): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(`api path must be a relative path starting with a single "/": ${path}`)
  }
  return `${API_PREFIX}${path}${toQueryString(query)}`
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** JSON-encoded unless it is `FormData` (multipart: the browser sets the boundary). */
  body?: unknown
  query?: QueryParams
  signal?: AbortSignal
}

export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const init: RequestInit = {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers,
    signal: opts.signal,
  }
  if (opts.body instanceof FormData) {
    init.body = opts.body
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(opts.body)
  }
  let res: Response
  try {
    res = await fetch(apiUrl(path, opts.query), init)
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e
    throw new ApiError(0, null)
  }
  if (!res.ok) {
    let body: ApiErrorBody | null = null
    try {
      body = (await res.json()) as ApiErrorBody
    } catch {
      body = null
    }
    throw new ApiError(res.status, body)
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T
  return (await res.json()) as T
}
