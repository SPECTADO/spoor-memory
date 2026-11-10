/**
 * Back-pressure for `spoor adr import` / `spoor docs import`: batch and size limits, per-request timeouts, which
 * failures are retried, exponential backoff with jitter that honours `Retry-After`, and pacing between requests
 * while the server signals pressure. All waiting goes through the runtime's `sleep`, so tests are instant.
 */

/** At most this many ADR files per `POST /api/adr/import` (the server treats more than 10 as an old CLI). */
export const IMPORT_BATCH_FILES = 10
/** At most this many bytes per ADR batch, counted as bytes(content) + bytes(path) + 64 per file. */
export const IMPORT_BATCH_BYTES = 128 * 1024
/** Server-side limits of one import file (zod `.max` counts UTF-16 units like String.length). */
export const IMPORT_CONTENT_MAX = 400_000
export const IMPORT_PATH_MAX = 256
/** The server's 1 MiB body cap, less a margin for the JSON around one file. */
export const IMPORT_BODY_MAX = 1024 * 1024 - 4096

export const MAX_CONSECUTIVE_FAILURES = 5
/** Total backoff wait per run (pacing not counted). */
export const MAX_TOTAL_WAIT_MS = 300_000
/** After a timeout the server may still be working on the request: wait at least this long before re-sending. */
export const TIMEOUT_COOLDOWN_MS = 15_000
export const RETRY_AFTER_MAX_MS = 60_000
const BACKOFF_BASE_MS = 2000
const BACKOFF_CAP_MS = 60_000
const PACE_STEPS = [0, 1000, 2000, 4000] as const
const PACE_DOWN_AFTER = 5
/** A file answered `internal` is sent at most this many times in all in one run (so 2 re-sends). */
export const FILE_ATTEMPTS = 3

export const IMPORT_LOCK_STALE_MS = 10 * 60 * 1000
export const IMPORT_QUEUE_TTL_MS = 7 * 24 * 3600 * 1000

/** Request headers of the import (wire contract section 1); old servers ignore them. */
export const DEFER_EMBEDDING_HEADER = 'Spoor-Defer-Embedding'
export const IMPORT_EDGES_HEADER = 'Spoor-Import-Edges'
export const DEFER_EMBEDDING: Record<string, string> = { [DEFER_EMBEDDING_HEADER]: '1' }
export const DEFER_EDGES: Record<string, string> = { [IMPORT_EDGES_HEADER]: 'defer' }

export const TIMEOUT_CODES = new Set([
  'timeout',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
])

/**
 * Per-request timeout of an import request carrying `bytes`: 30 s plus 250 ms per KiB, at most 120 s. A valid
 * `SPOOR_IMPORT_TIMEOUT_MS` (integer 100..600000) replaces it (slow servers, tests).
 */
export function importTimeoutMs(bytes: number, env: NodeJS.ProcessEnv = {}): number {
  const raw = env.SPOOR_IMPORT_TIMEOUT_MS
  if (typeof raw === 'string' && /^\d{1,6}$/.test(raw)) {
    const v = Number(raw)
    if (v >= 100 && v <= 600_000) return v
  }
  return Math.min(120_000, 30_000 + Math.ceil(bytes / 1024) * 250)
}

/** Size of one file in a batch, as `importBatches` counts it. */
export const importFileBytes = (f: { source_path: string; content: string }) =>
  Buffer.byteLength(f.content) + Buffer.byteLength(f.source_path) + 64

export interface RetryInfo {
  code: string
  status?: number
  retryAfterMs?: number
  apiCode?: string
}

export type RetryClass = 'rate' | 'busy' | 'timeout' | 'server'

/**
 * Gateway answers of a reverse proxy in front of the server (bad gateway, gateway timeout, Cloudflare's 524): the
 * upstream request is most likely still running, so they wait like a timeout before the batch is sent again.
 */
const GATEWAY_STATUSES = new Set([502, 504, 524])

/** Which failures are worth waiting for; undefined (refused, DNS, certificates, other 4xx) fails fast. */
export function retryClass(i: RetryInfo): RetryClass | undefined {
  if (i.status === 429) return 'rate'
  if (i.status === 503 && (i.apiCode === 'busy' || i.apiCode === 'starting')) return 'busy'
  if (TIMEOUT_CODES.has(i.code)) return 'timeout'
  if (i.status !== undefined && GATEWAY_STATUSES.has(i.status)) return 'timeout'
  if (i.status !== undefined && i.status >= 500) return 'server'
  return undefined
}

const WHAT: Record<RetryClass, string> = {
  rate: 'server busy',
  busy: 'server busy',
  timeout: 'request timed out',
  server: 'server error',
}

/** One import run's view of the server's health: consecutive failures, total wait, pacing and batch size. */
export class Backpressure {
  failures = 0
  waitedMs = 0
  paceMs = 0
  okStreak = 0
  maxFiles = IMPORT_BATCH_FILES

  constructor(private readonly rt: { sleep: (ms: number) => Promise<void>; err: (s: string) => void }) {}

  /** Before a request: wait `paceMs` while the server has signalled pressure. */
  async pace(): Promise<void> {
    if (this.paceMs > 0) await this.rt.sleep(this.paceMs)
  }

  /** An answer from the server (not a failure). After 5 in a row without pressure, pacing goes one step down. */
  ok(): void {
    this.failures = 0
    this.okStreak++
    if (this.okStreak >= PACE_DOWN_AFTER) {
      this.paceMs = step(this.paceMs, -1)
      this.okStreak = 0
    }
  }

  /** The server signalled pressure (a failure, 429/busy, or a per-file `internal`): pacing goes one step up. */
  pressure(): void {
    this.paceMs = step(this.paceMs, 1)
    this.okStreak = 0
  }

  /** Wait before sending the same request again; false means give up (too many failures or waited too long). */
  async retry(i: RetryInfo, cls: RetryClass, batchLen: number): Promise<boolean> {
    this.failures++
    this.pressure()
    if (this.failures >= MAX_CONSECUTIVE_FAILURES) return false
    const full = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (this.failures - 1))
    let delay = full / 2 + (Math.random() * full) / 2
    if (i.retryAfterMs !== undefined) delay = Math.max(delay, Math.min(i.retryAfterMs, RETRY_AFTER_MAX_MS))
    // the server may still be working on the timed-out request: wait, then re-send (it answers `unchanged`)
    if (cls === 'timeout') delay = Math.max(delay, TIMEOUT_COOLDOWN_MS)
    delay = Math.round(delay)
    if (this.waitedMs + delay > MAX_TOTAL_WAIT_MS) return false
    if ((cls === 'timeout' || cls === 'server') && batchLen > 1)
      this.maxFiles = Math.max(1, Math.floor(batchLen / 2))
    this.rt.err(
      `spoor: ${WHAT[cls]} (${i.code}); waiting ${Math.ceil(delay / 1000)} s before trying again (${this.failures} of ${MAX_CONSECUTIVE_FAILURES})\n`,
    )
    await this.rt.sleep(delay)
    this.waitedMs += delay
    return true
  }
}

function step(pace: number, dir: 1 | -1): number {
  const i = PACE_STEPS.indexOf(pace as (typeof PACE_STEPS)[number])
  const at = i < 0 ? 0 : i
  return PACE_STEPS[Math.max(0, Math.min(PACE_STEPS.length - 1, at + dir))] as number
}
