/**
 * Time and timers for the scheduler, injectable so tests can drive the tick loop without waiting.
 * SQL-side time (lease expiry, predicates) always comes from the database's `now()`; this clock only
 * schedules ticks and measures handler budgets.
 */

export interface Clock {
  now(): number
}

export type TimerHandle = { readonly id: number } | ReturnType<typeof setTimeout>

export interface Timers {
  /** Like `setTimeout`, but the real implementation `unref()`s the timer so it never keeps the process alive. */
  setTimeout(fn: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

export const systemClock: Clock = { now: () => Date.now() }

export const systemTimers: Timers = {
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms)
    t.unref()
    return t
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

/** A manual clock with manual timers: `advance(ms)` moves time and fires every timer that came due, in order. */
export class FakeClock implements Clock, Timers {
  #now: number
  #seq = 0
  #timers = new Map<number, { at: number; fn: () => void }>()

  constructor(start = Date.UTC(2026, 9, 19, 12, 0, 0)) {
    this.#now = start
  }

  now(): number {
    return this.#now
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.#seq
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), fn })
    return { id }
  }

  clearTimeout(handle: TimerHandle): void {
    if (typeof handle === 'object' && handle !== null && 'id' in handle && typeof handle.id === 'number') {
      this.#timers.delete(handle.id)
    }
  }

  /** Pending timers, soonest first (for assertions). */
  pending(): number[] {
    return [...this.#timers.values()].map((t) => t.at - this.#now).sort((a, b) => a - b)
  }

  /** Move time forward, firing due timers one by one (timers they schedule fire too if due). */
  advance(ms: number): void {
    const end = this.#now + ms
    for (;;) {
      let nextId: number | undefined
      let next: { at: number; fn: () => void } | undefined
      for (const [id, t] of this.#timers) {
        if (t.at <= end && (next === undefined || t.at < next.at)) {
          nextId = id
          next = t
        }
      }
      if (next === undefined || nextId === undefined) break
      this.#timers.delete(nextId)
      this.#now = next.at
      next.fn()
    }
    this.#now = end
  }

  /** Jump to an absolute time without firing timers. */
  set(ms: number): void {
    this.#now = ms
  }
}
