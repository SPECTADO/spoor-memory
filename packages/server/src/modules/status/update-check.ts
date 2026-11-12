/**
 * The update check (operations.md "Update check"): the only outbound call this server makes on its own. It reads
 * `deploy/latest-release.json` from the repository's main branch (`SPOOR_UPDATE_URL`), which the release workflow
 * writes once a release is on npm and GHCR, and tells instance admins when a newer release exists.
 *
 * - A plain GET with a generic User-Agent: no version, host name, instance id or any other identifying data.
 * - At most one request in flight, 3 s timeout, at most 8 KiB of body read, 6 h cache after an answer, 1 h after a
 *   failure.
 * - Fail silent: a network error, a bad status or a file that does not validate keeps the last good answer (or
 *   none) and logs at debug. `current()` never waits on the network, so no request ever blocks or fails on it.
 * - `SPOOR_UPDATE_CHECK=off` turns it off: nothing is fetched and `current()` is null.
 */
import { isNewerRelease, isStableRelease, RELEASE_URL_PREFIX } from '@spoor/shared'
import { z } from 'zod'
import type { UpdateInfo, UpdatePort } from '../../ports.js'

export const UPDATE_TIMEOUT_MS = 3000
export const UPDATE_TTL_MS = 6 * 60 * 60_000
export const UPDATE_FAILURE_TTL_MS = 60 * 60_000
/** The file is a few hundred bytes; anything much larger is not it, and no more than this is ever read. */
export const MAX_BODY_BYTES = 8192

/**
 * The body as text, read no further than `max` bytes: a `content-length` above it is refused before reading,
 * and a body that grows past it (no or a wrong length) is cancelled at that point, never buffered whole.
 */
async function readCapped(res: Response, max: number): Promise<string> {
  const length = Number(res.headers.get('content-length'))
  if (Number.isFinite(length) && length > max) {
    await res.body?.cancel().catch(() => undefined)
    throw new Error('response too large')
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      throw new Error('response too large')
    }
    parts.push(value)
  }
  const buf = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    buf.set(p, at)
    at += p.byteLength
  }
  return new TextDecoder().decode(buf)
}

const isReleaseNotesUrl = (u: string) => {
  try {
    const url = new URL(u)
    return (
      u.startsWith(RELEASE_URL_PREFIX) &&
      url.protocol === 'https:' &&
      url.host === 'github.com' &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}

const stable = z.string().max(40).refine(isStableRelease, 'must be a stable x.y.z release')

/** `deploy/latest-release.json`, schema 1 (written by deploy/latest-release.mjs). Unknown fields are ignored. */
export const latestReleaseFile = z
  .object({
    schema: z.literal(1),
    version: stable,
    npm: stable,
    image: stable,
    released_at: z.string().max(40),
    url: z.string().max(300).refine(isReleaseNotesUrl, `must be on ${RELEASE_URL_PREFIX}`),
  })
  .refine((f) => f.npm === f.version && f.image === f.version, 'npm and image must equal version')

export interface UpdateCheckerOptions {
  enabled: boolean
  url: string
  /** This server's version; `0.0.0` (a source build) is never behind. */
  currentVersion: string
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
  logger?: { debug: (obj: object, msg: string) => void }
}

export interface UpdateChecker extends UpdatePort {
  /** Fetch now (one at a time); resolves to the cached result afterwards and never rejects. */
  refresh(): Promise<UpdateInfo | null>
}

export function createUpdateChecker(o: UpdateCheckerOptions): UpdateChecker {
  const doFetch = o.fetch ?? globalThis.fetch
  const now = o.now ?? Date.now
  const timeoutMs = o.timeoutMs ?? UPDATE_TIMEOUT_MS
  let info: UpdateInfo | null = null
  let until = 0
  let inFlight: Promise<UpdateInfo | null> | null = null

  async function load(): Promise<UpdateInfo> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
    timer.unref?.()
    try {
      const res = await doFetch(o.url, {
        signal: ctrl.signal,
        headers: { accept: 'application/json', 'user-agent': 'spoor' },
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const text = await readCapped(res, MAX_BODY_BYTES)
      const file = latestReleaseFile.parse(JSON.parse(text))
      return {
        latest: file.version,
        available: isNewerRelease(file.version, o.currentVersion),
        url: file.url,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  function refresh(): Promise<UpdateInfo | null> {
    if (!o.enabled) return Promise.resolve(null)
    inFlight ??= load()
      .then((fresh) => {
        info = fresh
        until = now() + UPDATE_TTL_MS
        return info
      })
      .catch((err: unknown) => {
        until = now() + UPDATE_FAILURE_TTL_MS
        o.logger?.debug({ err: (err as Error)?.message ?? String(err) }, 'update check failed')
        return info
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  return {
    enabled: o.enabled,
    refresh,
    current() {
      if (!o.enabled) return null
      if (now() >= until) void refresh()
      return info
    },
  }
}
