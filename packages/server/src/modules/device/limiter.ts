/**
 * The device-code miss lock (auth-and-security.md section 6 step 3): 5 wrong codes per user within 10
 * minutes lock lookup, approve and deny for that user for 10 minutes, across sessions. In memory, per
 * process: a bounded resource, not a rate limit (section 11). A restart forgets it.
 */
export interface MissLimiterOptions {
  maxMisses?: number
  windowMs?: number
  lockMs?: number
  /** Most users tracked at once; the oldest entries are dropped beyond it (memory bound). */
  maxKeys?: number
  now?: () => number
}

interface Entry {
  /** Miss timestamps inside the window, oldest first. */
  misses: number[]
  lockedUntil: number
}

export class MissLimiter {
  private readonly entries = new Map<string, Entry>()
  private readonly maxMisses: number
  private readonly windowMs: number
  private readonly lockMs: number
  private readonly maxKeys: number
  private readonly now: () => number

  constructor(opts: MissLimiterOptions = {}) {
    this.maxMisses = opts.maxMisses ?? 5
    this.windowMs = opts.windowMs ?? 10 * 60_000
    this.lockMs = opts.lockMs ?? 10 * 60_000
    this.maxKeys = opts.maxKeys ?? 50_000
    this.now = opts.now ?? Date.now
  }

  /** Remaining lock in ms (0 = not locked). */
  lockedFor(key: string): number {
    const e = this.entries.get(key)
    if (!e) return 0
    const left = e.lockedUntil - this.now()
    return left > 0 ? left : 0
  }

  /** Record one miss; returns true when this miss locked the key. */
  miss(key: string): boolean {
    const now = this.now()
    let e = this.entries.get(key)
    if (!e) {
      if (this.entries.size >= this.maxKeys) this.prune(now)
      e = { misses: [], lockedUntil: 0 }
      this.entries.set(key, e)
    }
    e.misses = e.misses.filter((t) => t > now - this.windowMs)
    e.misses.push(now)
    if (e.misses.length >= this.maxMisses && e.lockedUntil <= now) {
      e.lockedUntil = now + this.lockMs
      e.misses = []
      return true
    }
    return false
  }

  /** Tracked keys (tests). */
  get size(): number {
    return this.entries.size
  }

  private prune(now: number): void {
    for (const [k, e] of this.entries) {
      if (e.lockedUntil <= now && e.misses.every((t) => t <= now - this.windowMs)) this.entries.delete(k)
    }
    // still full: drop the oldest insertions (Map keeps insertion order)
    for (const k of this.entries.keys()) {
      if (this.entries.size < this.maxKeys) break
      this.entries.delete(k)
    }
  }
}
