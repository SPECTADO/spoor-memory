import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createUpdateChecker,
  MAX_BODY_BYTES,
  UPDATE_FAILURE_TTL_MS,
  UPDATE_TTL_MS,
  type UpdateCheckerOptions,
} from './update-check.js'

const URL_ = 'https://raw.githubusercontent.com/SPECTADO/spoor-memory/main/deploy/latest-release.json'
const file = (version = '0.7.0', over: Record<string, unknown> = {}) => ({
  schema: 1,
  version,
  npm: version,
  image: version,
  released_at: '2026-11-12T10:00:00Z',
  url: `https://github.com/SPECTADO/spoor-memory/releases/tag/v${version}`,
  ...over,
})
const reply = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

function setup(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  over: Partial<UpdateCheckerOptions> = {},
) {
  let t = 1_000_000
  const fetch = vi.fn(fetchImpl)
  const checker = createUpdateChecker({
    enabled: true,
    url: URL_,
    currentVersion: '0.6.1',
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => t,
    ...over,
  })
  return { checker, fetch, advance: (ms: number) => (t += ms) }
}

afterEach(() => vi.useRealTimers())

describe('update check', () => {
  it('reads the file, reports a newer release, and sends no identifying data', async () => {
    const { checker, fetch } = setup(async () => reply(file('0.7.0')))
    expect(checker.current()).toBeNull() // first call starts the fetch and does not wait
    await vi.waitFor(() => expect(checker.current()).not.toBeNull())
    expect(checker.current()).toEqual({
      latest: '0.7.0',
      available: true,
      url: 'https://github.com/SPECTADO/spoor-memory/releases/tag/v0.7.0',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(URL_)
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.body).toBeUndefined()
    const headers = init.headers as Record<string, string>
    expect(headers['user-agent']).toBe('spoor')
    expect(JSON.stringify(headers)).not.toContain('0.6.1')
  })

  it('says not available when the server runs the latest release or a newer one', async () => {
    const same = setup(async () => reply(file('0.6.1')))
    expect(await same.checker.refresh()).toMatchObject({ latest: '0.6.1', available: false })
    const ahead = setup(async () => reply(file('0.6.1')), { currentVersion: '0.7.0-rc.1' })
    expect(await ahead.checker.refresh()).toMatchObject({ available: false })
    const source = setup(async () => reply(file('0.7.0')), { currentVersion: '0.0.0' })
    expect(await source.checker.refresh()).toMatchObject({ latest: '0.7.0', available: false })
    const rc = setup(async () => reply(file('0.7.0')), { currentVersion: '0.7.0-rc.2' })
    expect(await rc.checker.refresh()).toMatchObject({ available: true })
  })

  it('does nothing at all when switched off', async () => {
    const { checker, fetch } = setup(async () => reply(file()), { enabled: false })
    expect(checker.enabled).toBe(false)
    expect(checker.current()).toBeNull()
    expect(await checker.refresh()).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails silent on a network error, a bad status or bad JSON', async () => {
    for (const impl of [
      async () => {
        throw new TypeError('fetch failed')
      },
      async () => reply('nope', 404),
      async () => reply('{not json'),
      async () => reply('x'.repeat(10_000)),
    ]) {
      const { checker } = setup(impl)
      expect(await checker.refresh()).toBeNull()
      expect(checker.current()).toBeNull()
    }
  })

  it('never reads more than the size limit: a large length is refused unread, a long stream is cancelled', async () => {
    let pulled = 0
    let cancelled = false
    const long = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          // 1 MiB in 1 KiB chunks (bounded, so a regression fails instead of filling memory)
          pull(c) {
            pulled++
            c.enqueue(new Uint8Array(1024).fill(0x20))
            if (pulled === 1024) c.close()
          },
          cancel() {
            cancelled = true
          },
        }),
      )
    const { checker } = setup(async () => long())
    expect(await checker.refresh()).toBeNull()
    expect(pulled).toBeLessThanOrEqual(MAX_BODY_BYTES / 1024 + 2)
    expect(cancelled).toBe(true)

    let bodyRead = false
    const big = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(c) {
            bodyRead = true
            c.enqueue(new TextEncoder().encode(JSON.stringify(file())))
            c.close()
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { 'content-length': String(MAX_BODY_BYTES + 1) } },
    )
    const sized = setup(async () => big)
    expect(await sized.checker.refresh()).toBeNull()
    expect(bodyRead).toBe(false)
    // a file of the right size still reads
    expect(await setup(async () => reply(file('0.7.0'))).checker.refresh()).toMatchObject({ latest: '0.7.0' })
  })

  it('rejects a file that does not match the schema', async () => {
    for (const bad of [
      file('0.8.0-rc.1'),
      file('0.0.0'),
      file('0.7.0', { schema: 2 }),
      file('0.7.0', { npm: '0.6.1' }),
      file('0.7.0', { image: undefined }),
      file('0.7.0', { url: 'https://evil.example/SPECTADO/' }),
      file('0.7.0', { url: 'https://github.com/someone-else/spoor-memory/releases' }),
      file('0.7.0', { url: 'http://github.com/SPECTADO/spoor-memory/releases/tag/v0.7.0' }),
      file('0.7.0', { url: 'https://github.com.evil.example/SPECTADO/x' }),
      { version: '0.7.0' },
      [],
    ]) {
      const { checker } = setup(async () => reply(bad))
      expect(await checker.refresh(), JSON.stringify(bad)).toBeNull()
    }
  })

  it('gives up after the timeout', async () => {
    const { checker } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }),
      { timeoutMs: 20 },
    )
    const started = Date.now()
    expect(await checker.refresh()).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('uses the default 3 s timeout', async () => {
    vi.useFakeTimers()
    let aborted = false
    const { checker } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        }),
    )
    const p = checker.refresh()
    await vi.advanceTimersByTimeAsync(2999)
    expect(aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(aborted).toBe(true)
    expect(await p).toBeNull()
  })

  it('caches an answer for 6 hours and keeps one request in flight', async () => {
    const { checker, fetch, advance } = setup(async () => reply(file('0.7.0')))
    checker.current()
    checker.current()
    await vi.waitFor(() => expect(checker.current()).not.toBeNull())
    expect(fetch).toHaveBeenCalledTimes(1)
    advance(UPDATE_TTL_MS - 1)
    checker.current()
    expect(fetch).toHaveBeenCalledTimes(1)
    advance(1)
    // stale: the old answer is served while one refresh runs
    expect(checker.current()).toMatchObject({ latest: '0.7.0' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retries a failure after 1 hour and keeps the last good answer meanwhile', async () => {
    let fail = false
    const { checker, fetch, advance } = setup(async () => {
      if (fail) throw new Error('offline')
      return reply(file('0.7.0'))
    })
    await checker.refresh()
    fail = true
    advance(UPDATE_TTL_MS)
    expect(await checker.refresh()).toMatchObject({ latest: '0.7.0' })
    expect(fetch).toHaveBeenCalledTimes(2)
    advance(UPDATE_FAILURE_TTL_MS - 1)
    checker.current()
    expect(fetch).toHaveBeenCalledTimes(2)
    advance(1)
    fail = false
    checker.current()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('never throws out of current(), whatever fetch does', () => {
    const { checker } = setup(() => {
      throw new Error('sync throw')
    })
    expect(() => checker.current()).not.toThrow()
  })
})
