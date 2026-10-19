/** A counting semaphore whose waiters give up after a timeout (bounds concurrent password hashes). */
export class SemaphoreTimeoutError extends Error {
  constructor() {
    super('semaphore wait timed out')
    this.name = 'SemaphoreTimeoutError'
  }
}

export class Semaphore {
  #free: number
  readonly #queue: { resolve: () => void; timer: NodeJS.Timeout }[] = []

  constructor(permits: number) {
    this.#free = permits
  }

  get waiting(): number {
    return this.#queue.length
  }

  /** Resolves when a permit is held; rejects with SemaphoreTimeoutError after `timeoutMs` in the queue. */
  acquire(timeoutMs: number): Promise<void> {
    if (this.#free > 0) {
      this.#free--
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        timer: setTimeout(() => {
          const i = this.#queue.indexOf(entry)
          if (i >= 0) this.#queue.splice(i, 1)
          reject(new SemaphoreTimeoutError())
        }, timeoutMs),
      }
      this.#queue.push(entry)
    })
  }

  release(): void {
    const next = this.#queue.shift()
    if (next) {
      clearTimeout(next.timer)
      next.resolve() // the permit passes straight to the next waiter
    } else {
      this.#free++
    }
  }

  async run<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    await this.acquire(timeoutMs)
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}
