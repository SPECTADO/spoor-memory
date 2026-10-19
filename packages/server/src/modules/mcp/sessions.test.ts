import { describe, expect, it, vi } from 'vitest'
import { clientLabel, readCapped } from './routes.js'
import { type McpSession, SessionStore } from './sessions.js'

/** U+202E RIGHT-TO-LEFT OVERRIDE, built at runtime so the source holds no bidi control. */
const RLO = String.fromCharCode(0x202e)

function session(id: string, tokenId: string) {
  const close = vi.fn(async () => {})
  const s: McpSession = {
    id,
    mcp: { close },
    transport: { handleRequest: vi.fn() },
    tokenId,
    projectId: 'p',
    role: 'editor',
    client: null,
    lastSeenAt: 0,
  }
  return { s, close }
}

describe('SessionStore', () => {
  it('evicts the least recently used session of a token at the per-token cap', () => {
    let now = 0
    const store = new SessionStore({ perToken: 2, now: () => now })
    const a = session('a', 't1')
    const b = session('b', 't1')
    const c = session('c', 't1')
    const other = session('x', 't2')
    store.add(a.s)
    now = 1
    store.add(b.s)
    store.add(other.s)
    now = 2
    store.touch(a.s) // b is now the least recently used of t1
    store.add(c.s)
    expect(store.get('b')).toBeUndefined()
    expect(b.close).toHaveBeenCalledOnce()
    expect(store.get('a')).toBeDefined()
    expect(store.get('x')).toBeDefined()
    expect(store.countFor('t1')).toBe(2)
  })

  it('evicts the globally least recently used session at the total cap', () => {
    const store = new SessionStore({ total: 2 })
    const a = session('a', 't1')
    store.add(a.s)
    store.add(session('b', 't2').s)
    store.add(session('c', 't3').s)
    expect(store.size).toBe(2)
    expect(store.get('a')).toBeUndefined()
    expect(a.close).toHaveBeenCalledOnce()
  })

  it('expires idle sessions on lookup and in the sweep', () => {
    let now = 0
    const store = new SessionStore({ ttlMs: 100, now: () => now })
    const a = session('a', 't1')
    const b = session('b', 't1')
    store.add(a.s)
    store.add(b.s)
    now = 50
    store.touch(b.s)
    now = 120
    expect(store.get('a')).toBeUndefined()
    expect(store.get('b')).toBeDefined()
    now = 200
    expect(store.sweep()).toBe(1)
    expect(store.size).toBe(0)
    expect(b.close).toHaveBeenCalledOnce()
  })

  it('remove and closeAll are idempotent', () => {
    const store = new SessionStore()
    const a = session('a', 't1')
    store.add(a.s)
    store.remove('a')
    store.remove('a')
    store.closeAll()
    expect(a.close).toHaveBeenCalledOnce()
  })
})

describe('clientLabel', () => {
  it('name/version from initialize, cleaned and capped at 64', () => {
    expect(clientLabel({ name: 'claude-code', version: '2.1.303' }, 'curl/8')).toBe('claude-code/2.1.303')
    expect(clientLabel({ name: `evil${RLO}\nname`, version: '1' }, undefined)).toBe('evilname/1')
    expect(clientLabel({ name: 'x'.repeat(100), version: '1' }, undefined)).toHaveLength(64)
    expect(clientLabel({ name: 'cursor' }, undefined)).toBe('cursor')
  })

  it('falls back to ua:<User-Agent, 50 chars>, else null', () => {
    expect(clientLabel(undefined, 'Mozilla/5.0 '.repeat(10))).toBe(
      `ua:${'Mozilla/5.0 '.repeat(10).slice(0, 50).trim()}`,
    )
    expect(clientLabel({ name: '\u0007' }, undefined)).toBeNull()
    expect(clientLabel(undefined, undefined)).toBeNull()
  })
})

describe('readCapped', () => {
  it('reads a body within the limit and refuses one over it, declared or streamed', async () => {
    expect(await readCapped(new Request('http://x/', { method: 'POST', body: 'hello' }), 10)).toBe('hello')
    expect(
      await readCapped(new Request('http://x/', { method: 'POST', body: 'x'.repeat(11) }), 10),
    ).toBeNull()
    const declared = new Request('http://x/', {
      method: 'POST',
      body: 'x',
      headers: { 'content-length': '99' },
    })
    expect(await readCapped(declared, 10)).toBeNull()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(6))
        c.enqueue(new Uint8Array(6))
        c.close()
      },
    })
    const streamed = new Request('http://x/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    expect(await readCapped(streamed, 10)).toBeNull()
    expect(await readCapped(new Request('http://x/', { method: 'POST' }), 10)).toBe('')
  })
})
