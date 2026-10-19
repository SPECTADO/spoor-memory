/**
 * Password hashing (auth-and-security.md section 2): node:crypto scrypt N=2^17, r=8, p=1, keylen 32,
 * maxmem 256 MiB, 16-byte salt, stored as `scrypt$17$8$1$<salt b64url>$<hash b64url>`, compared in
 * constant time. At most 2 hashes run at once (~128 MiB each); a caller waiting more than 5 s gets 503 `busy`.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { ApiError } from '../../lib/errors.js'
import { Semaphore, SemaphoreTimeoutError } from '../../lib/semaphore.js'

export interface ScryptParams {
  logN: number
  r: number
  p: number
}

export const CURRENT_PARAMS: ScryptParams = { logN: 17, r: 8, p: 1 }
const KEYLEN = 32
const SALT_BYTES = 16
const MAXMEM = 256 * 1024 * 1024

interface Parsed extends ScryptParams {
  salt: Buffer
  hash: Buffer
}

export function parseHash(stored: string): Parsed | null {
  const m = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored)
  if (!m) return null
  const [logN, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (logN < 1 || logN > 20 || r < 1 || p < 1) return null
  return {
    logN,
    r,
    p,
    salt: Buffer.from(m[4] as string, 'base64url'),
    hash: Buffer.from(m[5] as string, 'base64url'),
  }
}

function derive(password: string, salt: Buffer, params: ScryptParams, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      keylen,
      { N: 2 ** params.logN, r: params.r, p: params.p, maxmem: MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    )
  })
}

export async function hashPassword(password: string, params: ScryptParams = CURRENT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await derive(password, salt, params, KEYLEN)
  return `scrypt$${params.logN}$${params.r}$${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

/** False for a wrong password and for an unparseable stored value. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored)
  if (!parsed || parsed.hash.length === 0) return false
  const key = await derive(password, parsed.salt, parsed, parsed.hash.length)
  return timingSafeEqual(key, parsed.hash)
}

/** A login with outdated parameters is re-hashed. */
export function needsRehash(stored: string, params: ScryptParams = CURRENT_PARAMS): boolean {
  const p = parseHash(stored)
  return !p || p.logN !== params.logN || p.r !== params.r || p.p !== params.p || p.hash.length !== KEYLEN
}

/** The bounded hasher every request path goes through. */
export class PasswordHasher {
  readonly #sem: Semaphore
  readonly #queueTimeoutMs: number
  #dummy: Promise<string> | undefined

  constructor(opts: { maxConcurrent?: number; queueTimeoutMs?: number } = {}) {
    this.#sem = new Semaphore(opts.maxConcurrent ?? 2)
    this.#queueTimeoutMs = opts.queueTimeoutMs ?? 5000
  }

  async #bounded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await this.#sem.run(this.#queueTimeoutMs, fn)
    } catch (err) {
      if (err instanceof SemaphoreTimeoutError) {
        throw new ApiError('busy', { message: 'The server is busy.', hint: 'Retry in a few seconds.' })
      }
      throw err
    }
  }

  hash(password: string): Promise<string> {
    return this.#bounded(() => hashPassword(password))
  }

  verify(password: string, stored: string): Promise<boolean> {
    return this.#bounded(() => verifyPassword(password, stored))
  }

  /** Same cost as a real check, for unknown emails and disabled users (no timing oracle). */
  async dummyVerify(password: string): Promise<false> {
    this.#dummy ??= hashPassword(randomBytes(16).toString('hex'))
    const dummy = await this.#dummy
    await this.verify(password, dummy)
    return false
  }
}
