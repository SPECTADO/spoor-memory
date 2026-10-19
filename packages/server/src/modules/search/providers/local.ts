/**
 * The default provider: `Xenova/multilingual-e5-small`, dtype q8, in process via @huggingface/transformers
 * (docs/design/search-and-digest.md section 2, docs/research/embeddings-node.md).
 *
 * - Offline only: `env.localModelPath = SPOOR_MODEL_DIR`, `allowRemoteModels = false`, `cacheDir = null`;
 *   the weights are baked into the image by scripts/fetch-model.mjs.
 * - Lazy singleton: the pipeline loads on the first `ready()` (shared per model dir and thread count, so
 *   several registries in one process load it once).
 * - `query: ` / `passage: ` prefixes are added here only; mean pooling + L2 normalisation.
 * - One inference at a time (SerialQueue), passages in batches of 8, `intra_op_num_threads` from
 *   SPOOR_EMBED_THREADS.
 */
import type { EmbeddingProvider } from '../../../ports.js'
import { batches, l2normalize, providerTag, SerialQueue } from './util.js'

export const LOCAL_MODEL = 'Xenova/multilingual-e5-small'
export const LOCAL_DTYPE = 'q8'
export const LOCAL_DIMS = 384
export const LOCAL_TAG = providerTag('local', LOCAL_MODEL, LOCAL_DTYPE, LOCAL_DIMS)
const BATCH = 8

/** The slice of the transformers.js feature-extraction pipeline this provider uses. */
interface Extractor {
  (
    texts: string[],
    opts: { pooling: 'mean'; normalize: boolean },
  ): Promise<{ data: ArrayLike<number>; dims: number[] }>
  tokenizer: { encode(text: string): number[] }
  dispose(): Promise<void>
}

const loaded = new Map<string, Promise<Extractor>>()

async function loadExtractor(modelDir: string, threads: number): Promise<Extractor> {
  const key = `${modelDir}\0${threads}`
  let p = loaded.get(key)
  if (!p) {
    p = (async () => {
      const t = await import('@huggingface/transformers')
      t.env.allowRemoteModels = false
      t.env.allowLocalModels = true
      t.env.localModelPath = modelDir.endsWith('/') ? modelDir : `${modelDir}/`
      t.env.cacheDir = null
      // onnxruntime's SessionOptions field is camelCase `intraOpNumThreads` (a snake_case key is ignored)
      const pipe = await t.pipeline('feature-extraction', LOCAL_MODEL, {
        dtype: LOCAL_DTYPE,
        session_options: { intraOpNumThreads: threads },
      })
      // the pipeline's declared call type is a large union; this provider uses the narrow shape above
      return pipe as unknown as Extractor
    })()
    loaded.set(key, p)
    p.catch(() => loaded.delete(key)) // a failed load can be retried
  }
  return p
}

export class LocalE5Provider implements EmbeddingProvider {
  readonly name = 'local' as const
  readonly model = LOCAL_MODEL
  readonly variant = LOCAL_DTYPE
  readonly dims = LOCAL_DIMS
  readonly tag = LOCAL_TAG
  readonly maxInputTokens = 512
  readonly #queue = new SerialQueue()
  #extractor: Extractor | undefined

  constructor(private readonly opts: { modelDir: string; threads: number }) {}

  /** Whether the model is loaded (countTokens works only then). */
  get loaded(): boolean {
    return this.#extractor !== undefined
  }

  async ready(): Promise<void> {
    if (this.#extractor) return
    this.#extractor = await loadExtractor(this.opts.modelDir, this.opts.threads)
  }

  #require(): Extractor {
    if (!this.#extractor) throw new Error('local embedding model is not loaded; await ready() first')
    return this.#extractor
  }

  /** e5 tokens of the text as embedded: incl. the special tokens and the 3-token `passage: ` prefix. */
  countTokens(text: string): number {
    return this.#require().tokenizer.encode(`passage: ${text}`).length
  }

  async #embed(texts: string[]): Promise<Float32Array[]> {
    await this.ready()
    const ex = this.#require()
    const out: Float32Array[] = []
    for (const batch of batches(texts, BATCH)) {
      const res = await this.#queue.run(() => ex(batch, { pooling: 'mean', normalize: true }))
      const dims = res.dims[res.dims.length - 1] ?? this.dims
      for (let i = 0; i < batch.length; i++) {
        out.push(
          l2normalize(Float32Array.from(Array.prototype.slice.call(res.data, i * dims, (i + 1) * dims))),
        )
      }
    }
    return out
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [v] = await this.#embed([`query: ${text}`])
    return v as Float32Array
  }

  embedPassages(texts: string[]): Promise<Float32Array[]> {
    return this.#embed(texts.map((t) => `passage: ${t}`))
  }
}
