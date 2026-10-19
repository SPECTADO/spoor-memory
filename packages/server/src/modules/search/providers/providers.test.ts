import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOCAL_TAG, LocalE5Provider } from './local.js'
import { createEmbeddingRegistry, providerForSettings } from './registry.js'
import { type FetchFn, OpenAIProvider, VoyageProvider } from './remote.js'
import { assertSafeTag, dimsOfTag, fallbackCount, l2normalize, SerialQueue, withTimeout } from './util.js'

function fakeFetch(dims: number) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = []
  const fn: FetchFn = async (url, init) => {
    const body = JSON.parse(String(init.body)) as { input: string[] }
    calls.push({ url, init, body })
    // answer in reverse order to prove re-ordering by `index`
    const data = body.input
      .map((_, i) => ({
        index: i,
        embedding: Array.from({ length: dims }, (_, d) => (d === i % dims ? 3 : 0)),
      }))
      .reverse()
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { fn, calls }
}

const baseConfig = {
  SPOOR_MODEL_DIR: '/nonexistent',
  SPOOR_EMBED_THREADS: 2,
  SPOOR_EMBEDDING_DEFAULT: 'local' as const,
  SPOOR_OPENAI_API_KEY: undefined,
  SPOOR_OPENAI_EMBED_MODEL: 'text-embedding-3-small',
  SPOOR_OPENAI_EMBED_DIMS: 1536,
  SPOOR_VOYAGE_API_KEY: undefined,
  SPOOR_VOYAGE_EMBED_MODEL: undefined,
  SPOOR_VOYAGE_EMBED_DIMS: undefined,
}

describe('OpenAIProvider', () => {
  it('posts model, input and dimensions with the key as bearer; normalises and keeps input order', async () => {
    const f = fakeFetch(4)
    const p = new OpenAIProvider({
      apiKey: 'sk-secret',
      model: 'text-embedding-3-small',
      dims: 4,
      fetch: f.fn,
    })
    expect(p.tag).toBe('openai:text-embedding-3-small/4')
    const vs = await p.embedPassages(['a', 'b', 'c'])
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]?.url).toBe('https://api.openai.com/v1/embeddings')
    expect(f.calls[0]?.body).toEqual({
      model: 'text-embedding-3-small',
      input: ['a', 'b', 'c'],
      encoding_format: 'float',
      dimensions: 4,
    })
    const headers = (f.calls[0] as { init: RequestInit }).init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-secret')
    expect(Array.from(vs[0] as Float32Array)).toEqual([1, 0, 0, 0])
    expect(Array.from(vs[2] as Float32Array)).toEqual([0, 0, 1, 0])
  })
  it('batches passages by 64', async () => {
    const f = fakeFetch(2)
    const p = new OpenAIProvider({ apiKey: 'k', model: 'text-embedding-3-small', dims: 2, fetch: f.fn })
    const vs = await p.embedPassages(Array.from({ length: 130 }, (_, i) => `t${i}`))
    expect(vs).toHaveLength(130)
    expect(f.calls.map((c) => (c.body.input as string[]).length)).toEqual([64, 64, 2])
  })
  it('errors carry the status only, never the key or body', async () => {
    const p = new OpenAIProvider({
      apiKey: 'sk-very-secret',
      model: 'text-embedding-3-small',
      dims: 2,
      fetch: async () => new Response('{"error":"bad key sk-very-secret"}', { status: 401 }),
    })
    await expect(p.embedQuery('x')).rejects.toThrow(/^openai embeddings request failed with HTTP 401$/)
  })
  it('rejects vectors of the wrong width', async () => {
    const p = new OpenAIProvider({
      apiKey: 'k',
      model: 'text-embedding-3-small',
      dims: 8,
      fetch: fakeFetch(4).fn,
    })
    await expect(p.embedQuery('x')).rejects.toThrow(/width 4, expected 8/)
  })
  it('counts tokens as chars / 3', () => {
    expect(new OpenAIProvider({ apiKey: 'k', model: 'm', dims: 2 }).countTokens('abcdefg')).toBe(3)
  })
})

describe('VoyageProvider', () => {
  it('sends input_type query/document and output_dimension', async () => {
    const f = fakeFetch(3)
    const p = new VoyageProvider({ apiKey: 'pa-key', model: 'voyage-3.5', dims: 3, fetch: f.fn })
    expect(p.tag).toBe('voyage:voyage-3.5/3')
    await p.embedQuery('q')
    await p.embedPassages(['d'])
    expect(f.calls[0]?.url).toBe('https://api.voyageai.com/v1/embeddings')
    expect(f.calls[0]?.body).toEqual({
      model: 'voyage-3.5',
      input: ['q'],
      input_type: 'query',
      output_dimension: 3,
    })
    expect(f.calls[1]?.body.input_type).toBe('document')
  })
})

describe('registry', () => {
  it('local always; remote providers only with keys; default from SPOOR_EMBEDDING_DEFAULT', () => {
    const r1 = createEmbeddingRegistry(baseConfig)
    expect(r1.list().map((p) => p.name)).toEqual(['local'])
    expect(r1.defaultProvider.tag).toBe(LOCAL_TAG)
    expect(LOCAL_TAG).toBe('local:Xenova/multilingual-e5-small@q8/384')

    const r2 = createEmbeddingRegistry({
      ...baseConfig,
      SPOOR_EMBEDDING_DEFAULT: 'openai',
      SPOOR_OPENAI_API_KEY: 'k',
      SPOOR_VOYAGE_API_KEY: 'v',
      SPOOR_VOYAGE_EMBED_MODEL: 'voyage-3.5',
      SPOOR_VOYAGE_EMBED_DIMS: 1024,
    })
    expect(r2.list().map((p) => p.name)).toEqual(['local', 'openai', 'voyage'])
    expect(r2.defaultProvider.name).toBe('openai')
    expect(r2.byTag('voyage:voyage-3.5/1024')?.name).toBe('voyage')
    expect(r2.byTag('nope')).toBeUndefined()
    expect(providerForSettings(r2, { embedding: { provider: 'voyage' } }).name).toBe('voyage')
    expect(providerForSettings(r2, {}).name).toBe('local') // settings default
    expect(providerForSettings(r1, { embedding: { provider: 'openai' } }).name).toBe('local') // not enabled
  })
})

describe('util', () => {
  it('l2normalize, dimsOfTag, assertSafeTag, fallbackCount', () => {
    expect(Array.from(l2normalize(Float32Array.from([3, 4])))).toEqual([
      0.6000000238418579, 0.800000011920929,
    ])
    expect(dimsOfTag(LOCAL_TAG)).toBe(384)
    expect(dimsOfTag('x')).toBeNull()
    expect(() => assertSafeTag("x'; DROP TABLE chunks; --")).toThrow()
    expect(assertSafeTag(LOCAL_TAG)).toBe(LOCAL_TAG)
    expect(fallbackCount('abc')).toBe(11)
    expect(fallbackCount('🚀')).toBe(10)
  })
  it('SerialQueue runs one task at a time, in order, surviving failures', async () => {
    const q = new SerialQueue()
    const log: string[] = []
    let running = 0
    const task = (name: string, fail = false) =>
      q.run(async () => {
        running++
        expect(running).toBe(1)
        await new Promise((r) => setTimeout(r, 2))
        log.push(name)
        running--
        if (fail) throw new Error(name)
        return name
      })
    const results = await Promise.allSettled([task('a'), task('b', true), task('c')])
    expect(log).toEqual(['a', 'b', 'c'])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
  })
  it('withTimeout rejects slow work', async () => {
    await expect(withTimeout(new Promise((r) => setTimeout(r, 200)), 10)).rejects.toThrow(/timed out/)
  })
})

describe('LocalE5Provider', () => {
  it('countTokens needs ready() first', () => {
    const p = new LocalE5Provider({ modelDir: '/nonexistent', threads: 1 })
    expect(p.loaded).toBe(false)
    expect(() => p.countTokens('x')).toThrow(/not loaded/)
  })

  // Runs only when the baked model is present: SPOOR_MODEL_DIR=/path/with/Xenova/multilingual-e5-small
  const modelDir = process.env.SPOOR_MODEL_DIR
  const hasModel = !!modelDir && existsSync(join(modelDir, 'Xenova/multilingual-e5-small/config.json'))
  it.skipIf(!hasModel)(
    'real model: 384-dim unit vectors, prefixes, offline load',
    { timeout: 60_000 },
    async () => {
      const p = new LocalE5Provider({ modelDir: modelDir as string, threads: 2 })
      await p.ready()
      const [a, b, c] = await p.embedPassages([
        'Sessions are stored in Postgres.',
        'Session data lives in the database.',
        'Bananas are yellow.',
      ])
      expect(a).toHaveLength(384)
      const dot = (x: Float32Array, y: Float32Array) => x.reduce((s, v, i) => s + v * (y[i] as number), 0)
      expect(dot(a as Float32Array, a as Float32Array)).toBeCloseTo(1, 3)
      expect(dot(a as Float32Array, b as Float32Array)).toBeGreaterThan(
        dot(a as Float32Array, c as Float32Array),
      )
      expect(p.countTokens('hello')).toBeGreaterThan(3) // special tokens + `passage: ` prefix
    },
  )
})
