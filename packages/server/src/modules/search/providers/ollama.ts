/**
 * Embeddings from an Ollama server over `fetch` (ADR-0026, docs/design/search-and-digest.md section 2).
 * Opt-in: the provider exists only when SPOOR_OLLAMA_URL is set. Chunk text goes to that host and nowhere
 * else; there is no key. Ollama applies no task prompt of its own, so the prefixes a model was trained with
 * are added here, as the local provider does for e5.
 */
import type { EmbeddingProvider } from '../../../ports.js'
import type { FetchFn } from './remote.js'
import { batches, fallbackCount, l2normalize, providerTag, remoteError } from './util.js'

const BATCH = 32
const REQUEST_TIMEOUT_MS = 20_000

interface ModelProfile {
  query: string
  passage: string
  maxInputTokens: number
}

/**
 * Prompts and input limits by model family (the name without registry path and `:tag`). A retrieval model
 * embedded without its prompts ranks clearly worse (embeddinggemma: body MRR 0.72 against 0.97 with them).
 * The chunker passes chunk text only, so embeddinggemma's document prompt carries `title: none`.
 */
const PROFILES: Record<string, ModelProfile> = {
  embeddinggemma: {
    query: 'task: search result | query: ',
    passage: 'title: none | text: ',
    maxInputTokens: 2048,
  },
  'nomic-embed-text': { query: 'search_query: ', passage: 'search_document: ', maxInputTokens: 2048 },
  'nomic-embed-text-v2-moe': { query: 'search_query: ', passage: 'search_document: ', maxInputTokens: 512 },
}

/** Any other model: no prompt, and the smallest window common among embedding models. */
const UNKNOWN: ModelProfile = { query: '', passage: '', maxInputTokens: 512 }

/** `hf.co/org/EmbeddingGemma:300m` -> `embeddinggemma` */
export function ollamaModelFamily(model: string): string {
  const last = model.slice(model.lastIndexOf('/') + 1)
  const colon = last.indexOf(':')
  return (colon === -1 ? last : last.slice(0, colon)).toLowerCase()
}

interface EmbedResponse {
  embeddings?: unknown
}

export class OllamaProvider implements EmbeddingProvider {
  readonly name = 'ollama' as const
  readonly variant = ''
  readonly model: string
  readonly dims: number
  readonly maxInputTokens: number
  readonly #baseUrl: string
  readonly #profile: ModelProfile
  readonly #fetch: FetchFn

  constructor(opts: { baseUrl: string; model: string; dims: number; fetch?: FetchFn }) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.model = opts.model
    this.dims = opts.dims
    this.#profile = PROFILES[ollamaModelFamily(opts.model)] ?? UNKNOWN
    this.maxInputTokens = this.#profile.maxInputTokens
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init))
  }

  get tag(): string {
    return providerTag(this.name, this.model, this.variant, this.dims)
  }

  /** No network call: Ollama loads a model on first use, and an outage only leaves embeddings pending. */
  async ready(): Promise<void> {}

  /**
   * Ollama exposes no tokenizer. Models with a 2048-token window get chars / 3 (a 400-token chunk is at most
   * 1200 UTF-16 units, so it fits even at one token per unit); smaller windows get the one-per-code-point
   * count that no subword tokenizer exceeds, because `truncate: false` turns an overlong input into an error.
   */
  countTokens(text: string): number {
    return this.maxInputTokens >= 2048 ? Math.ceil(text.length / 3) : fallbackCount(text)
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [v] = await this.#embed([this.#profile.query + text])
    return v as Float32Array
  }

  async embedPassages(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = []
    for (const b of batches(texts, BATCH)) {
      out.push(...(await this.#embed(b.map((t) => this.#profile.passage + t))))
    }
    return out
  }

  /** `POST /api/embed`; `truncate: false` so an input over the model's window fails instead of losing its tail. */
  async #embed(input: string[]): Promise<Float32Array[]> {
    const res = await this.#fetch(`${this.#baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input, truncate: false }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw remoteError('ollama', res.status)
    const rows = ((await res.json()) as EmbedResponse).embeddings
    if (!Array.isArray(rows) || rows.length !== input.length) {
      throw new Error(
        `ollama embeddings response has ${Array.isArray(rows) ? rows.length : 'no'} vectors, expected ${input.length}`,
      )
    }
    return rows.map((v: unknown) => {
      if (!Array.isArray(v) || v.length !== this.dims) {
        throw new Error(
          `ollama returned a vector of width ${Array.isArray(v) ? v.length : 'none'}, expected ${this.dims} (check SPOOR_OLLAMA_EMBED_DIMS)`,
        )
      }
      return l2normalize(Float32Array.from(v as number[]))
    })
  }
}
