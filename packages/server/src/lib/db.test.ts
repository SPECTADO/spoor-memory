import { describe, expect, it } from 'vitest'
import { isDbUnavailable, isTransientPgError, retryTransient } from './db.js'
import { ApiError } from './errors.js'

const pgErr = (code: string) => Object.assign(new Error(`pg ${code}`), { code })
/** drizzle wraps the driver error: the code sits on `cause`. */
const wrapped = (code: string) => new Error('Failed query', { cause: pgErr(code) })

function failing(errors: unknown[], value = 'ok') {
  let calls = 0
  const fn = async () => {
    const err = errors[calls++]
    if (err !== undefined) throw err
    return value
  }
  return { fn, calls: () => calls }
}

const recordSleep = () => {
  const delays: number[] = []
  return { delays, sleep: async (ms: number) => void delays.push(ms) }
}

describe('isTransientPgError', () => {
  it('is 40P01 and 40001, on the error or its cause', () => {
    expect(isTransientPgError(pgErr('40P01'))).toBe(true)
    expect(isTransientPgError(wrapped('40001'))).toBe(true)
    expect(isTransientPgError(pgErr('23505'))).toBe(false)
    expect(isTransientPgError(new Error('boom'))).toBe(false)
    expect(isTransientPgError(undefined)).toBe(false)
  })
})

describe('retryTransient', () => {
  it('retries a deadlock and a serialization failure, also when the code sits on cause', async () => {
    const { sleep } = recordSleep()
    const f = failing([pgErr('40P01'), wrapped('40001'), wrapped('40P01')])
    await expect(retryTransient(f.fn, { sleep })).resolves.toBe('ok')
    expect(f.calls()).toBe(4)
  })

  it('stops after 3 retries and rethrows the last error unchanged', async () => {
    const { sleep } = recordSleep()
    const last = wrapped('40P01')
    const f = failing([pgErr('40P01'), pgErr('40P01'), pgErr('40001'), last, pgErr('40P01')])
    await expect(retryTransient(f.fn, { sleep })).rejects.toBe(last)
    expect(f.calls()).toBe(4)
  })

  it('does not retry a unique violation or an ApiError', async () => {
    const { sleep, delays } = recordSleep()
    const unique = wrapped('23505')
    const u = failing([unique])
    await expect(retryTransient(u.fn, { sleep })).rejects.toBe(unique)
    expect(u.calls()).toBe(1)
    const api = new ApiError('not_found')
    const a = failing([api])
    await expect(retryTransient(a.fn, { sleep })).rejects.toBe(api)
    expect(a.calls()).toBe(1)
    expect(delays).toEqual([])
  })

  it('sleeps through the injected sleep, inside the documented ranges', async () => {
    const { sleep, delays } = recordSleep()
    const f = failing([pgErr('40P01'), pgErr('40P01'), pgErr('40P01')])
    await retryTransient(f.fn, { sleep })
    expect(delays).toHaveLength(3)
    const [d1, d2, d3] = delays as [number, number, number]
    expect(d1).toBeGreaterThanOrEqual(25)
    expect(d1).toBeLessThan(50)
    expect(d2).toBeGreaterThanOrEqual(50)
    expect(d2).toBeLessThan(100)
    expect(d3).toBeGreaterThanOrEqual(100)
    expect(d3).toBeLessThan(200)
    // a custom base and retry count
    const c = recordSleep()
    const g = failing([pgErr('40001'), pgErr('40001')])
    await expect(retryTransient(g.fn, { sleep: c.sleep, retries: 1, baseMs: 10 })).rejects.toMatchObject({
      code: '40001',
    })
    expect(c.delays).toHaveLength(1)
    expect(c.delays[0]).toBeGreaterThanOrEqual(10)
    expect(c.delays[0]).toBeLessThan(20)
  })
})

describe('isDbUnavailable', () => {
  it('is true when no connection could be had, also under a drizzle wrapper', () => {
    // the two errors of the 2026-11-10 production log: pushUpdate's transaction and loadSession's query
    const connectTimeout = new Error('Connection terminated due to connection timeout', {
      cause: new Error('Connection terminated unexpectedly'),
    })
    expect(isDbUnavailable(connectTimeout)).toBe(true)
    expect(
      isDbUnavailable(
        Object.assign(new Error('Failed query: select 1'), {
          cause: new Error('Connection terminated due to connection timeout'),
        }),
      ),
    ).toBe(true)
    expect(isDbUnavailable(new Error('timeout exceeded when trying to connect'))).toBe(true)
    expect(isDbUnavailable(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(
      true,
    )
    expect(
      isDbUnavailable(Object.assign(new Error('the database system is starting up'), { code: '57P03' })),
    ).toBe(true)
    expect(isDbUnavailable(Object.assign(new Error('too many clients'), { code: '53300' }))).toBe(true)
  })

  it('is false for a connection lost mid-statement and for ordinary errors', () => {
    expect(isDbUnavailable(new Error('Connection terminated unexpectedly'))).toBe(false)
    expect(isDbUnavailable(Object.assign(new Error('deadlock detected'), { code: '40P01' }))).toBe(false)
    expect(isDbUnavailable(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe(false)
    expect(isDbUnavailable(new ApiError('not_found'))).toBe(false)
    expect(isDbUnavailable(new Error('boom'))).toBe(false)
    expect(isDbUnavailable(undefined)).toBe(false)
  })
})
