import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LOCAL_TAG, LocalE5Provider } from './local.js'
import { OllamaProvider, ollamaModelFamily } from './ollama.js'
import { createEmbeddingRegistry, providerForSettings } from './registry.js'
import { type FetchFn, OpenAIProvider, VoyageProvider } from './remote.js'
import {
  assertSafeTag,
  batchesByLength,
  dimsOfTag,
  fallbackCount,
  l2normalize,
  SerialQueue,
  withTimeout,
} from './util.js'

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
  SPOOR_OLLAMA_URL: undefined,
  SPOOR_OLLAMA_EMBED_MODEL: 'embeddinggemma',
  SPOOR_OLLAMA_EMBED_DIMS: 768,
}

/** Ollama's `/api/embed` shape: `{embeddings: number[][]}` in input order. */
function fakeOllama(dims: number, status = 200) {
  const calls: {
    url: string
    init: RequestInit
    body: { model: string; input: string[]; truncate: boolean }
  }[] = []
  const fn: FetchFn = async (url, init) => {
    const body = JSON.parse(String(init.body)) as { model: string; input: string[]; truncate: boolean }
    calls.push({ url, init, body })
    if (status !== 200) return new Response('{"error":"model \\"x\\" not found"}', { status })
    const embeddings = body.input.map((_, i) =>
      Array.from({ length: dims }, (_, d) => (d === i % dims ? 3 : 0)),
    )
    return new Response(JSON.stringify({ model: body.model, embeddings }), { status: 200 })
  }
  return { fn, calls }
}

describe('OllamaProvider', () => {
  it('posts to /api/embed without a key or truncation, adds the embeddinggemma prompts, normalises', async () => {
    const f = fakeOllama(4)
    const p = new OllamaProvider({
      baseUrl: 'http://ollama:11434/',
      model: 'embeddinggemma',
      dims: 4,
      fetch: f.fn,
    })
    expect(p.tag).toBe('ollama:embeddinggemma/4')
    expect(assertSafeTag(p.tag)).toBe(p.tag)
    expect(p.maxInputTokens).toBe(2048)
    await p.ready()

    const vs = await p.embedPassages(['a', 'b'])
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]?.url).toBe('http://ollama:11434/api/embed')
    expect(f.calls[0]?.body).toEqual({
      model: 'embeddinggemma',
      input: ['title: none | text: a', 'title: none | text: b'],
      truncate: false,
    })
    const headers = (f.calls[0] as { init: RequestInit }).init.headers as Record<string, string>
    expect(headers).toEqual({ 'content-type': 'application/json' })
    expect(Array.from(vs[0] as Float32Array)).toEqual([1, 0, 0, 0])
    expect(Array.from(vs[1] as Float32Array)).toEqual([0, 1, 0, 0])

    await p.embedQuery('q')
    expect(f.calls[1]?.body.input).toEqual(['task: search result | query: q'])
  })

  it('picks prompts and limits by model family; an unknown model gets none and the safe counter', async () => {
    expect(ollamaModelFamily('embeddinggemma:300m')).toBe('embeddinggemma')
    expect(ollamaModelFamily('hf.co/org/EmbeddingGemma:300m')).toBe('embeddinggemma')
    expect(ollamaModelFamily('nomic-embed-text')).toBe('nomic-embed-text')

    const f = fakeOllama(4)
    const nomic = new OllamaProvider({
      baseUrl: 'http://o',
      model: 'nomic-embed-text:v1.5',
      dims: 4,
      fetch: f.fn,
    })
    expect(nomic.tag).toBe('ollama:nomic-embed-text:v1.5/4')
    await nomic.embedQuery('q')
    await nomic.embedPassages(['d'])
    expect(f.calls.map((c) => c.body.input[0])).toEqual(['search_query: q', 'search_document: d'])
    expect(nomic.countTokens('abcdefg')).toBe(3) // chars / 3 with a 2048 window

    const other = new OllamaProvider({ baseUrl: 'http://o', model: 'bge-m3', dims: 4, fetch: f.fn })
    await other.embedPassages(['d'])
    expect(f.calls[2]?.body.input).toEqual(['d'])
    expect(other.maxInputTokens).toBe(512)
    expect(other.countTokens('abc')).toBe(fallbackCount('abc'))
    const moe = new OllamaProvider({ baseUrl: 'http://o', model: 'nomic-embed-text-v2-moe', dims: 4 })
    expect(moe.maxInputTokens).toBe(512)
  })

  it('batches passages by 32, keeping order', async () => {
    const f = fakeOllama(8)
    const p = new OllamaProvider({ baseUrl: 'http://o', model: 'embeddinggemma', dims: 8, fetch: f.fn })
    const vs = await p.embedPassages(Array.from({ length: 70 }, (_, i) => `t${i}`))
    expect(f.calls.map((c) => c.body.input.length)).toEqual([32, 32, 6])
    expect(vs).toHaveLength(70)
    expect(f.calls[2]?.body.input[0]).toBe('title: none | text: t64')
  })

  it('errors carry the status only; a wrong width or count is refused', async () => {
    const missing = new OllamaProvider({
      baseUrl: 'http://o',
      model: 'embeddinggemma',
      dims: 4,
      fetch: fakeOllama(4, 404).fn,
    })
    await expect(missing.embedQuery('x')).rejects.toThrow('ollama embeddings request failed with HTTP 404')

    const wide = new OllamaProvider({
      baseUrl: 'http://o',
      model: 'embeddinggemma',
      dims: 4,
      fetch: fakeOllama(5).fn,
    })
    await expect(wide.embedQuery('x')).rejects.toThrow(/width 5, expected 4/)

    const empty = new OllamaProvider({
      baseUrl: 'http://o',
      model: 'embeddinggemma',
      dims: 4,
      fetch: async () => new Response('{}', { status: 200 }),
    })
    await expect(empty.embedQuery('x')).rejects.toThrow(/no vectors, expected 1/)
  })
})

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

  it('ollama only with SPOOR_OLLAMA_URL; it can be the default', () => {
    const r = createEmbeddingRegistry({
      ...baseConfig,
      SPOOR_EMBEDDING_DEFAULT: 'ollama',
      SPOOR_OLLAMA_URL: 'http://ollama:11434',
    })
    expect(r.list().map((p) => p.name)).toEqual(['local', 'ollama'])
    expect(r.defaultProvider.tag).toBe('ollama:embeddinggemma/768')
    expect(providerForSettings(r, { embedding: { provider: 'ollama' } }).dims).toBe(768)
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
  it("batchesByLength groups similar lengths, shortest first, and keeps each text's index", () => {
    const texts = ['dddd', 'a', 'ccc', 'bb', 'eeeee', 'a2']
    const got = batchesByLength(texts, 2, (t) => t.length)
    expect(got.map((b) => b.map((e) => e.text))).toEqual([
      ['a', 'bb'],
      ['a2', 'ccc'],
      ['dddd', 'eeeee'],
    ])
    for (const e of got.flat()) expect(texts[e.index]).toBe(e.text)
    expect(got.flat().map((e) => e.index)).toEqual([1, 3, 5, 2, 0, 4]) // equal lengths keep input order
    // one batch or less: nothing to group, so nothing is measured and the order stays
    const length = vi.fn((t: string) => t.length)
    expect(batchesByLength(['ccc', 'a'], 2, length).map((b) => b.map((e) => e.index))).toEqual([[0, 1]])
    expect(batchesByLength([], 8, length)).toEqual([])
    expect(length).not.toHaveBeenCalled()
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

  // batches are grouped by length, so a run of more than 8 texts is embedded out of order
  it.skipIf(!hasModel)(
    'real model: vectors come back in input order when lengths are mixed across batches',
    { timeout: 120_000 },
    async () => {
      const p = new LocalE5Provider({ modelDir: modelDir as string, threads: 2 })
      await p.ready()
      const topics = [
        'Postgres sessions',
        'yellow bananas',
        'tram timetables',
        'invoice rounding',
        'chess openings',
      ]
      const texts = Array.from({ length: 20 }, (_, i) => {
        const topic = `${topics[i % topics.length]} number ${i}`
        return i % 2 === 0 ? `${topic}. ${`More about ${topic}. `.repeat(40)}` : topic
      })
      const together = await p.embedPassages(texts)
      expect(together).toHaveLength(texts.length)
      const dot = (x: Float32Array, y: Float32Array) => x.reduce((s, v, i) => s + v * (y[i] as number), 0)
      for (const [i, text] of texts.entries()) {
        const [alone] = await p.embedPassages([text])
        const sims = together.map((v) => dot(v, alone as Float32Array))
        expect(sims.indexOf(Math.max(...sims))).toBe(i)
        expect(sims[i]).toBeGreaterThan(0.98)
      }
    },
  )

  // ADR-0029: the worker writes out the pipeline's steps; they must stay equal to the pipeline's own output
  it.skipIf(!hasModel)(
    'real model: worker vectors are bit-identical to the feature-extraction pipeline, and the loop keeps turning',
    { timeout: 120_000 },
    async () => {
      const t = await import('@huggingface/transformers')
      t.env.allowRemoteModels = false
      t.env.allowLocalModels = true
      t.env.localModelPath = `${modelDir}/`
      t.env.cacheDir = null
      const pipe = await t.pipeline('feature-extraction', 'Xenova/multilingual-e5-small', {
        dtype: 'q8',
        session_options: { intraOpNumThreads: 2 },
      })
      const texts = [
        'Sessions are stored in Postgres.',
        'Session data lives in the database, and it expires after fourteen days without activity.',
        'Žluťoučký kůň úpěl ďábelské ódy.',
        'x'.repeat(900),
      ]
      const ref = await pipe(
        texts.map((x) => `passage: ${x}`),
        { pooling: 'mean', normalize: true },
      )
      const p = new LocalE5Provider({ modelDir: modelDir as string, threads: 2 })
      await p.ready()
      const got = await p.embedPassages(texts)
      const data = ref.data as Float32Array
      for (const [i, v] of got.entries()) {
        const row = l2normalize(Float32Array.from(data.subarray(i * 384, (i + 1) * 384)))
        expect(Array.from(v)).toEqual(Array.from(row))
      }
      expect(p.countTokens(texts[1] as string)).toBe(pipe.tokenizer.encode(`passage: ${texts[1]}`).length)

      // 16 full chunks: with inference on this thread the loop turned about once per batch
      let turns = 0
      const timer = setInterval(() => {
        turns++
      }, 5)
      await p.embedPassages(
        Array.from({ length: 16 }, (_, i) => `chunk ${i} ${'stored in Postgres '.repeat(90)}`),
      )
      clearInterval(timer)
      expect(turns).toBeGreaterThan(20)
      await pipe.dispose()
    },
  )
})
