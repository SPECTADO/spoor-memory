import { describe, expect, it } from 'vitest'
import { MissLimiter } from './limiter.js'

const MIN = 60_000

describe('MissLimiter', () => {
  it('locks a key on the 5th miss within 10 minutes, for 10 minutes', () => {
    let now = 0
    const l = new MissLimiter({ now: () => now })
    for (let i = 0; i < 4; i++) {
      expect(l.miss('u1')).toBe(false)
      now += MIN
    }
    expect(l.lockedFor('u1')).toBe(0)
    expect(l.miss('u1')).toBe(true)
    expect(l.lockedFor('u1')).toBe(10 * MIN)
    expect(l.lockedFor('u2')).toBe(0)
    now += 10 * MIN - 1
    expect(l.lockedFor('u1')).toBe(1)
    now += 1
    expect(l.lockedFor('u1')).toBe(0)
    // the misses before the lock do not carry over
    expect(l.miss('u1')).toBe(false)
  })

  it('forgets misses older than the window', () => {
    let now = 0
    const l = new MissLimiter({ now: () => now })
    for (let i = 0; i < 4; i++) l.miss('u')
    now += 10 * MIN + 1
    for (let i = 0; i < 4; i++) expect(l.miss('u')).toBe(false)
    expect(l.lockedFor('u')).toBe(0)
  })

  it('stays bounded in memory', () => {
    let now = 0
    const l = new MissLimiter({ now: () => now, maxKeys: 100 })
    for (let i = 0; i < 1000; i++) {
      l.miss(`k${i}`)
      now += 1
    }
    expect(l.size).toBeLessThanOrEqual(100)
  })
})
