import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BREAKER_MS, createClient, NetworkError, OfflineError, offlineUntil } from './http.js'

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

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

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
})
