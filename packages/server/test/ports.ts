/**
 * In-memory ports for tests (never shipped in dist/): deterministic fake embeddings, a static registry, a
 * jobs port that only remembers nudges, and `stubPorts()` bundling them with the src placeholder
 * `NoopSearchPort`. The real ones are bound in src/runtime.ts.
 */
import type { EmbeddingProvider, EmbeddingRegistry, JobName, JobsPort, Ports } from '../src/ports.js'
import { NoopSearchPort } from '../src/ports.js'

function l2normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (const x of v) sum += x * x
  const n = Math.sqrt(sum) || 1
  for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / n
  return v
}

/** FNV-1a, for the deterministic fake vectors. */
function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Deterministic bag-of-words embedder: same words give the same vector, more shared words give a higher
 * cosine. No model, no network; for tests of anything that stores or compares vectors.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local' as const
  readonly model: string
  readonly variant = 'fake'
  readonly dims: number
  readonly tag: string
  readonly maxInputTokens = 512
  readonly calls: { kind: 'query' | 'passages'; count: number }[] = []
  failNext = false

  constructor(opts: { dims?: number; model?: string } = {}) {
    this.dims = opts.dims ?? 384
    this.model = opts.model ?? 'fake/bag-of-words'
    this.tag = `local:${this.model}@fake/${this.dims}`
  }

  async ready(): Promise<void> {}

  countTokens(text: string): number {
    return Math.ceil(text.length / 4) + 2
  }

  vector(text: string): Float32Array {
    const v = new Float32Array(this.dims)
    for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      const i = hash32(w) % this.dims
      v[i] = (v[i] as number) + 1
    }
    return l2normalize(v)
  }

  #maybeFail() {
    if (this.failNext) {
      this.failNext = false
      throw new Error('fake embedding failure')
    }
  }

  async embedQuery(text: string): Promise<Float32Array> {
    this.calls.push({ kind: 'query', count: 1 })
    this.#maybeFail()
    return this.vector(text)
  }

  async embedPassages(texts: string[]): Promise<Float32Array[]> {
    this.calls.push({ kind: 'passages', count: texts.length })
    this.#maybeFail()
    return texts.map((t) => this.vector(t))
  }
}

export class StaticEmbeddingRegistry implements EmbeddingRegistry {
  readonly #providers: EmbeddingProvider[]
  constructor(
    readonly defaultProvider: EmbeddingProvider,
    others: EmbeddingProvider[] = [],
  ) {
    this.#providers = [defaultProvider, ...others]
  }
  byName(name: string) {
    return this.#providers.find((p) => p.name === name)
  }
  byTag(tag: string) {
    return this.#providers.find((p) => p.tag === tag)
  }
  list() {
    return [...this.#providers]
  }
}

/** Indexes nothing and never finds duplicates; records what it was asked to do. */
/** Remembers every nudge; runs nothing. */
export class MemoryJobsPort implements JobsPort {
  readonly enqueued: { name: JobName; projectId?: string }[] = []
  enqueue(name: JobName, opts: { projectId?: string } = {}): void {
    this.enqueued.push({ name, ...opts })
  }
}

/** No-op ports for tests and for modules wired before the real ones exist. */
export function stubPorts(overrides: Partial<Ports> = {}): Ports {
  return {
    embeddings: new StaticEmbeddingRegistry(new FakeEmbeddingProvider()),
    search: new NoopSearchPort(),
    jobs: new MemoryJobsPort(),
    ...overrides,
  }
}
