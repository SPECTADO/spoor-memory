import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BREAKER_MS,
  createClient,
  NetworkError,
  OfflineError,
  offlineUntil,
  parseRetryAfter,
} from './http.js'

function setup(fetchImpl: typeof fetch) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'spoor-http-'))
  const clock = { t: 1_000_000 }
  const calls = { n: 0 }
  const f = ((...a: Parameters<typeof fetch>) => {
    calls.n++
    return fetchImpl(...a)
  }) as typeof fetch
  const client = createClient({
    repoRoot,
    now: () => clock.t,
    server: 'https://s.example',
    token: 'spr_t',
    fetch: f,
  })
  return { repoRoot, clock, calls, client }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })

async function rejection(p: Promise<unknown>): Promise<NetworkError> {
  try {
    await p
  } catch (e) {
    if (e instanceof NetworkError) return e
    throw e
  }
  throw new Error('expected a NetworkError')
}

describe('http client', () => {
  it('sends bearer token and parses json', async () => {
    let seen: Request | undefined
    const { client } = setup(async (url, init) => {
      seen = new Request(url as string, init)
      return json(200, { ok: 1 })
    })
    const r = await client.request('GET', '/x')
    expect(r.body).toEqual({ ok: 1 })
    expect(seen?.headers.get('authorization')).toBe('Bearer spr_t')
  })

  it('does not trip the breaker on 4xx', async () => {
    const { client, repoRoot } = setup(async () => json(401, { error: 'no' }))
    expect((await client.request('GET', '/x')).status).toBe(401)
    expect(existsSync(join(repoRoot, '.spoor', 'offline-until'))).toBe(false)
  })

  it('trips on network failure, skips the network for 5 minutes, then retries', async () => {
    let fail = true
    const { client, clock, calls, repoRoot } = setup(async () => {
      if (fail) throw new TypeError('fetch failed')
      return json(200, {})
    })
    await expect(client.request('GET', '/x')).rejects.toBeInstanceOf(NetworkError)
    expect(calls.n).toBe(1)
    expect(Number(readFileSync(join(repoRoot, '.spoor', 'offline-until'), 'utf8'))).toBe(clock.t + BREAKER_MS)

    clock.t += BREAKER_MS - 1
    await expect(client.request('GET', '/x')).rejects.toBeInstanceOf(OfflineError)
    expect(calls.n).toBe(1)

    clock.t += 1
    fail = false
    expect((await client.request('GET', '/x')).ok).toBe(true)
    expect(calls.n).toBe(2)
    expect(offlineUntil({ repoRoot, now: () => clock.t })).toBe(0)
  })

  it('trips on 5xx', async () => {
    const { client, repoRoot, clock } = setup(async () => json(503, {}))
    await expect(client.request('GET', '/x')).rejects.toBeInstanceOf(NetworkError)
    expect(offlineUntil({ repoRoot, now: () => clock.t })).toBe(clock.t + BREAKER_MS)
  })

  it('times out via AbortSignal', async () => {
    const { client } = setup(
      (_u, init) =>
        new Promise((_r, rej) => {
          init?.signal?.addEventListener('abort', () => rej(init.signal?.reason))
        }),
    )
    await expect(client.request('GET', '/x', { timeoutMs: 20 })).rejects.toBeInstanceOf(NetworkError)
  })

  it('503 busy carries status, Retry-After and the code, and does not trip the breaker', async () => {
    const { client, repoRoot } = setup(async () =>
      json(503, { error: 'busy', message: 'Too many pushes' }, { 'retry-after': '7' }),
    )
    const e = await rejection(client.request('POST', '/x'))
    expect(e).toMatchObject({ code: '503', status: 503, retryAfterMs: 7000, apiCode: 'busy' })
    expect(existsSync(join(repoRoot, '.spoor', 'offline-until'))).toBe(false)
  })

  it('503 starting, 503 with an HTML body and 500 still trip the breaker', async () => {
    const answers = [
      () => json(503, { error: 'starting' }, { 'retry-after': '5' }),
      () =>
        new Response('<html>Bad gateway</html>', { status: 503, headers: { 'content-type': 'text/html' } }),
      () => json(500, { error: 'internal' }),
    ]
    for (const answer of answers) {
      const { client, repoRoot, clock } = setup(async () => answer())
      const e = await rejection(client.request('GET', '/x'))
      expect(e.status).toBeGreaterThanOrEqual(500)
      expect(e.apiCode).not.toBe('busy')
      expect(offlineUntil({ repoRoot, now: () => clock.t })).toBe(clock.t + BREAKER_MS)
    }
  })

  it('parseRetryAfter reads integer seconds only', () => {
    expect(parseRetryAfter('7')).toBe(7000)
    expect(parseRetryAfter('0')).toBe(0)
    expect(parseRetryAfter('9999')).toBe(9_999_000)
    for (const v of ['10000', '-1', '1.5', ' 7', 'Wed, 21 Oct 2026 07:28:00 GMT', '', null, undefined])
      expect(parseRetryAfter(v)).toBeUndefined()
  })

  it('sends extra headers, which cannot replace the built-in ones', async () => {
    let seen: Request | undefined
    const { client } = setup(async (url, init) => {
      seen = new Request(url as string, init)
      return json(200, {})
    })
    await client.request('POST', '/x', {
      body: { a: 1 },
      headers: {
        'Spoor-Defer-Embedding': '1',
        Authorization: 'Bearer evil',
        'content-type': 'text/plain',
        accept: 'text/html',
        'User-Agent': 'x',
      },
    })
    expect(seen?.headers.get('spoor-defer-embedding')).toBe('1')
    expect(seen?.headers.get('authorization')).toBe('Bearer spr_t')
    expect(seen?.headers.get('content-type')).toBe('application/json')
    expect(seen?.headers.get('accept')).toBe('application/json')
    expect(seen?.headers.get('user-agent')).not.toBe('x')
  })
})
