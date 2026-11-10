import { afterEach, describe, expect, it, vi } from 'vitest'
import { Backpressure, IMPORT_BATCH_FILES, importTimeoutMs, type RetryClass, retryClass } from './backoff.js'

function recorder() {
  const sleeps: number[] = []
  let err = ''
  const rt = {
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
    err: (s: string) => {
      err += s
    },
  }
  return { rt, sleeps, err: () => err }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('retryClass', () => {
  it('sorts failures into rate, busy, timeout, server or fail-fast', () => {
    const table: [Parameters<typeof retryClass>[0], RetryClass | undefined][] = [
      [{ code: 'rate_limited', status: 429 }, 'rate'],
      [{ code: '503', status: 503, apiCode: 'busy' }, 'busy'],
      [{ code: '503', status: 503, apiCode: 'starting' }, 'busy'],
      [{ code: '503', status: 503 }, 'server'],
      [{ code: '500', status: 500, apiCode: 'internal' }, 'server'],
      // a proxy's gateway answer: the upstream request is likely still running, so it waits like a timeout
      [{ code: '502', status: 502 }, 'timeout'],
      [{ code: '504', status: 504 }, 'timeout'],
      [{ code: '524', status: 524 }, 'timeout'],
      [{ code: '501', status: 501 }, 'server'],
      [{ code: 'timeout' }, 'timeout'],
      [{ code: 'ECONNRESET' }, 'timeout'],
      [{ code: 'EPIPE' }, 'timeout'],
      [{ code: 'ETIMEDOUT' }, 'timeout'],
      [{ code: 'UND_ERR_SOCKET' }, 'timeout'],
      [{ code: 'UND_ERR_HEADERS_TIMEOUT' }, 'timeout'],
      [{ code: 'UND_ERR_BODY_TIMEOUT' }, 'timeout'],
      [{ code: 'UND_ERR_CONNECT_TIMEOUT' }, 'timeout'],
      [{ code: 'ECONNREFUSED' }, undefined],
      [{ code: 'ENOTFOUND' }, undefined],
      [{ code: 'CERT_HAS_EXPIRED' }, undefined],
      [{ code: 'forbidden', status: 403 }, undefined],
    ]
    for (const [info, cls] of table) expect(retryClass(info), JSON.stringify(info)).toBe(cls)
  })
})

describe('importTimeoutMs', () => {
  it('scales with the size, capped at 120 s; a valid SPOOR_IMPORT_TIMEOUT_MS replaces it', () => {
    expect(importTimeoutMs(0)).toBe(30_000)
    expect(importTimeoutMs(1)).toBe(30_250)
    expect(importTimeoutMs(128 * 1024)).toBe(62_000)
    expect(importTimeoutMs(10 * 1024 * 1024)).toBe(120_000)
    expect(importTimeoutMs(1, { SPOOR_IMPORT_TIMEOUT_MS: '200' })).toBe(200)
    expect(importTimeoutMs(1, { SPOOR_IMPORT_TIMEOUT_MS: '600000' })).toBe(600_000)
    for (const v of ['99', '600001', 'abc', '1e3', '', '-5'])
      expect(importTimeoutMs(1, { SPOOR_IMPORT_TIMEOUT_MS: v })).toBe(30_250)
  })
})

describe('Backpressure', () => {
  it('backs off within 1-2 s, 2-4 s, 4-8 s, 8-16 s and gives up at the 5th consecutive failure', async () => {
    for (const r of [0, 0.5, 0.999]) {
      vi.spyOn(Math, 'random').mockReturnValue(r)
      const { rt, sleeps, err } = recorder()
      const bp = new Backpressure(rt)
      const results: boolean[] = []
      for (let i = 0; i < 5; i++) results.push(await bp.retry({ code: '500', status: 500 }, 'server', 1))
      expect(results).toEqual([true, true, true, true, false])
      const ranges = [
        [1000, 2000],
        [2000, 4000],
        [4000, 8000],
        [8000, 16000],
      ]
      sleeps.forEach((ms, i) => {
        expect(ms).toBeGreaterThanOrEqual(ranges[i]?.[0] as number)
        expect(ms).toBeLessThanOrEqual(ranges[i]?.[1] as number)
      })
      expect(err()).toContain('spoor: server error (500); waiting ')
      expect(err()).toContain('before trying again (4 of 5)')
      vi.restoreAllMocks()
    }
  })

  it('an ok answer resets the consecutive failures', async () => {
    const { rt } = recorder()
    const bp = new Backpressure(rt)
    for (let i = 0; i < 4; i++) expect(await bp.retry({ code: '500', status: 500 }, 'server', 1)).toBe(true)
    bp.ok()
    expect(await bp.retry({ code: '500', status: 500 }, 'server', 1)).toBe(true)
  })

  it('Retry-After and the timeout cool-down are lower bounds; Retry-After is capped at 60 s', async () => {
    const { rt, sleeps, err } = recorder()
    const bp = new Backpressure(rt)
    await bp.retry({ code: '503', status: 503, apiCode: 'busy', retryAfterMs: 7000 }, 'busy', 1)
    expect(sleeps[0]).toBe(7000)
    expect(err()).toContain('spoor: server busy (503); waiting 7 s before trying again (1 of 5)')
    bp.ok()
    await bp.retry({ code: 'rate_limited', status: 429, retryAfterMs: 3_600_000 }, 'rate', 1)
    expect(sleeps[1]).toBe(60_000)
    bp.ok()
    await bp.retry({ code: 'timeout' }, 'timeout', 1)
    expect(sleeps[2]).toBe(15_000)
    expect(err()).toContain('spoor: request timed out (timeout); waiting 15 s')
  })

  it('stops when the total wait would pass 300 s', async () => {
    const { rt, sleeps } = recorder()
    const bp = new Backpressure(rt)
    let n = 0
    while (await bp.retry({ code: '503', status: 503, apiCode: 'busy', retryAfterMs: 60_000 }, 'busy', 1)) {
      bp.ok() // never 5 consecutive failures: only the total wait stops it
      n++
    }
    expect(n).toBe(5)
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(300_000)
  })

  it('halves the batch only after a timeout or a server error', async () => {
    const { rt } = recorder()
    const bp = new Backpressure(rt)
    await bp.retry({ code: 'rate_limited', status: 429 }, 'rate', 10)
    await bp.retry({ code: '503', status: 503, apiCode: 'busy' }, 'busy', 10)
    expect(bp.maxFiles).toBe(IMPORT_BATCH_FILES)
    bp.ok()
    await bp.retry({ code: 'timeout' }, 'timeout', 10)
    expect(bp.maxFiles).toBe(5)
    await bp.retry({ code: '500', status: 500 }, 'server', 5)
    expect(bp.maxFiles).toBe(2)
    await bp.retry({ code: '500', status: 500 }, 'server', 1)
    expect(bp.maxFiles).toBe(2)
  })

  it('pacing goes up under pressure and one step down after 5 ok answers in a row', async () => {
    const { rt, sleeps } = recorder()
    const bp = new Backpressure(rt)
    await bp.pace()
    expect(sleeps).toEqual([])
    bp.pressure()
    expect(bp.paceMs).toBe(1000)
    bp.pressure()
    bp.pressure()
    bp.pressure()
    expect(bp.paceMs).toBe(4000)
    await bp.pace()
    expect(sleeps).toEqual([4000])
    for (let i = 0; i < 4; i++) bp.ok()
    expect(bp.paceMs).toBe(4000)
    bp.pressure() // resets the streak
    for (let i = 0; i < 4; i++) bp.ok()
    expect(bp.paceMs).toBe(4000)
    bp.ok()
    expect(bp.paceMs).toBe(2000)
    for (let i = 0; i < 10; i++) bp.ok()
    expect(bp.paceMs).toBe(0)
  })
})
