import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/errors.js'
import {
  CURRENT_PARAMS,
  hashPassword,
  needsRehash,
  PasswordHasher,
  parseHash,
  verifyPassword,
} from './passwords.js'

const FAST = { logN: 10, r: 8, p: 1 }

describe('scrypt password hashes', () => {
  it('uses the documented format and parameters', async () => {
    const h = await hashPassword('correct horse battery staple')
    expect(h).toMatch(/^scrypt\$17\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/)
    const p = parseHash(h)
    expect(p).toMatchObject(CURRENT_PARAMS)
    expect(p?.salt).toHaveLength(16)
    expect(p?.hash).toHaveLength(32)
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true)
    expect(needsRehash(h)).toBe(false)
  })

  it('verifies with the stored parameters and flags outdated ones for rehash', async () => {
    const h = await hashPassword('password-one-two', FAST)
    expect(h.startsWith('scrypt$10$8$1$')).toBe(true)
    expect(await verifyPassword('password-one-two', h)).toBe(true)
    expect(await verifyPassword('password-one-twO', h)).toBe(false)
    expect(needsRehash(h)).toBe(true)
  })

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([
      hashPassword('same password!', FAST),
      hashPassword('same password!', FAST),
    ])
    expect(a).not.toBe(b)
  })

  it('normalises NFKC before hashing', async () => {
    const h = await hashPassword('ﬁ'.repeat(6), FAST) // fi ligature
    expect(await verifyPassword('fi'.repeat(6), h)).toBe(true)
  })

  it('rejects garbage stored values without throwing', async () => {
    expect(await verifyPassword('x', 'bcrypt$whatever')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$99$8$1$aa$bb')).toBe(false)
    expect(needsRehash('nonsense')).toBe(true)
  })
})

describe('PasswordHasher', () => {
  it('answers 503 busy when a hash waits longer than the queue timeout', async () => {
    const hasher = new PasswordHasher({ maxConcurrent: 1, queueTimeoutMs: 20 })
    const stored = await hashPassword('correct horse battery staple')
    const first = hasher.verify('correct horse battery staple', stored)
    const second = hasher.verify('correct horse battery staple', stored)
    await expect(second).rejects.toBeInstanceOf(ApiError)
    await expect(second).rejects.toMatchObject({ code: 'busy', status: 503 })
    expect(await first).toBe(true)
  })

  it('dummyVerify always returns false', async () => {
    expect(await new PasswordHasher().dummyVerify('anything at all')).toBe(false)
  })
})
