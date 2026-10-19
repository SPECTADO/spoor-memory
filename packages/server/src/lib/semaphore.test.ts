import { describe, expect, it } from 'vitest'
import { Semaphore, SemaphoreTimeoutError } from './semaphore.js'

describe('Semaphore', () => {
  it('admits up to N holders and hands permits to waiters in order', async () => {
    const s = new Semaphore(2)
    await s.acquire(10)
    await s.acquire(10)
    const order: number[] = []
    const a = s.acquire(1000).then(() => order.push(1))
    const b = s.acquire(1000).then(() => order.push(2))
    expect(s.waiting).toBe(2)
    s.release()
    s.release()
    await Promise.all([a, b])
    expect(order).toEqual([1, 2])
  })

  it('times out a waiter and forgets it', async () => {
    const s = new Semaphore(1)
    await s.acquire(10)
    await expect(s.acquire(5)).rejects.toBeInstanceOf(SemaphoreTimeoutError)
    expect(s.waiting).toBe(0)
    s.release()
    await s.acquire(5) // the permit was not lost
  })

  it('run releases on error', async () => {
    const s = new Semaphore(1)
    await expect(s.run(10, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(await s.run(10, async () => 7)).toBe(7)
  })
})
