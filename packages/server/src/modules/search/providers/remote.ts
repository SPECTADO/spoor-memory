/**
 * Remote embedding providers over `fetch`, no SDKs (docs/design/search-and-digest.md section 2).
 * Keys come from env only (SPOOR_OPENAI_API_KEY, SPOOR_VOYAGE_API_KEY) and never appear in errors or logs.
 * Remote providers send chunk text off the instance; the settings UI says so before an admin selects one.
 */
import type { EmbeddingProvider } from '../../../ports.js'
import { batches, l2normalize, providerTag, remoteError } from './util.js'

const BATCH = 64
const REQUEST_TIMEOUT_MS = 20_000

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>

interface EmbeddingsResponse {
  data?: { index?: number; embedding?: number[] }[]
}

/** Parse `{data:[{index, embedding}]}` (both vendors) into vectors in input order, checking the width. */
async function parseVectors(
  provider: string,
  res: Response,
  n: number,
  dims: number,
): Promise<Float32Array[]> {
  if (!res.ok) throw remoteError(provider, res.status)
  const body = (await res.json()) as EmbeddingsResponse
  const rows = body.data ?? []
  if (rows.length !== n)
    throw new Error(`${provider} embeddings response has ${rows.length} vectors, expected ${n}`)
  const out: Float32Array[] = new Array(n)
  rows.forEach((row, i) => {
    const idx = typeof row.index === 'number' ? row.index : i
    const v = row.embedding
    if (!Array.isArray(v) || v.length !== dims) {
      throw new Error(
        `${provider} returned a vector of width ${Array.isArray(v) ? v.length : 'none'}, expected ${dims}`,
      )
    }
    out[idx] = l2normalize(Float32Array.from(v))
  })
  if (out.some((v) => v === undefined)) throw new Error(`${provider} embeddings response has gaps`)
  return out
}

abstract class RemoteProvider implements EmbeddingProvider {
  abstract readonly name: 'openai' | 'voyage'
  readonly variant = ''
  abstract readonly maxInputTokens: number
  readonly model: string
  readonly dims: number
  protected readonly apiKey: string
  protected readonly fetchFn: FetchFn

  constructor(opts: { apiKey: string; model: string; dims: number; fetch?: FetchFn }) {
    this.apiKey = opts.apiKey
    this.model = opts.model
    this.dims = opts.dims
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init))
  }

  get tag(): string {
    return providerTag(this.name, this.model, this.variant, this.dims)
  }

  /** No network call: a key is configured (the provider exists only when it is). */
  async ready(): Promise<void> {
    if (!this.apiKey) throw new Error(`${this.name} embedding provider has no API key`)
  }

  /** chars / 3, rounded up: conservative for the remote models' large input limits. */
  countTokens(text: string): number {
    return Math.ceil(text.length / 3)
  }

  protected abstract request(texts: string[], kind: 'query' | 'document'): Promise<Float32Array[]>

  protected post(url: string, payload: unknown): Promise<Response> {
    return this.fetchFn(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [v] = await this.request([text], 'query')
    return v as Float32Array
  }

  async embedPassages(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = []
    for (const b of batches(texts, BATCH)) out.push(...(await this.request(b, 'document')))
    return out
  }
}

/** OpenAI `POST /v1/embeddings`; `dimensions` is sent for the text-embedding-3 family. */
export class OpenAIProvider extends RemoteProvider {
  readonly name = 'openai' as const
  readonly maxInputTokens = 8191
  readonly #baseUrl: string

  constructor(opts: { apiKey: string; model: string; dims: number; fetch?: FetchFn; baseUrl?: string }) {
    super(opts)
    this.#baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1'
  }

  protected async request(texts: string[]): Promise<Float32Array[]> {
    const payload: Record<string, unknown> = { model: this.model, input: texts, encoding_format: 'float' }
    if (this.model.startsWith('text-embedding-3')) payload.dimensions = this.dims
    const res = await this.post(`${this.#baseUrl}/embeddings`, payload)
    return parseVectors('openai', res, texts.length, this.dims)
  }
}

/** Voyage `POST /v1/embeddings` with `input_type` query/document and `output_dimension`. */
export class VoyageProvider extends RemoteProvider {
  readonly name = 'voyage' as const
  readonly maxInputTokens = 32000
  readonly #baseUrl: string

  constructor(opts: { apiKey: string; model: string; dims: number; fetch?: FetchFn; baseUrl?: string }) {
    super(opts)
    this.#baseUrl = opts.baseUrl ?? 'https://api.voyageai.com/v1'
  }

  protected async request(texts: string[], kind: 'query' | 'document'): Promise<Float32Array[]> {
    const res = await this.post(`${this.#baseUrl}/embeddings`, {
      model: this.model,
      input: texts,
      input_type: kind,
      output_dimension: this.dims,
    })
    return parseVectors('voyage', res, texts.length, this.dims)
  }
}
