/**
 * The default provider: `Xenova/multilingual-e5-small`, dtype q8, in process via @huggingface/transformers
 * (docs/design/search-and-digest.md section 2, docs/research/embeddings-node.md).
 *
 * - Offline only: `env.localModelPath = SPOOR_MODEL_DIR`, `allowRemoteModels = false`, `cacheDir = null`;
 *   the weights are baked into the image by scripts/fetch-model.mjs.
 * - Lazy singleton: the model loads on the first `ready()` (shared per model dir and thread count, so
 *   several registries in one process load it once).
 * - Inference runs in a worker thread (inference-worker.ts, ADR-0029): onnxruntime's `run` is synchronous and
 *   would stall the server's event loop for the length of every batch. The tokenizer is on the main thread
 *   (the chunker counts tokens synchronously), which tokenizes each batch and sends the tensors over.
 * - `query: ` / `passage: ` prefixes are added here only; mean pooling + L2 normalisation.
 * - One inference at a time (SerialQueue), passages in batches of 8, `intra_op_num_threads` from
 *   SPOOR_EMBED_THREADS.
 */
import type { EmbeddingProvider } from '../../../ports.js'
import { InferenceWorker } from './inference-worker.js'
import { batches, l2normalize, providerTag, SerialQueue } from './util.js'

export const LOCAL_MODEL = 'Xenova/multilingual-e5-small'
export const LOCAL_DTYPE = 'q8'
export const LOCAL_DIMS = 384
export const LOCAL_TAG = providerTag('local', LOCAL_MODEL, LOCAL_DTYPE, LOCAL_DIMS)
const BATCH = 8

/** One tokenizer output tensor (`input_ids`, `attention_mask`, ...): int64 values, shape `[batch, tokens]`. */
interface TokenTensor {
  data: BigInt64Array
  dims: number[]
}

/**
 * The tokenizer lives on the main thread only: the chunker counts tokens synchronously, and batches are
 * tokenized here and sent to the worker as tensors, so the 17 MB tokenizer is in memory once.
 */
interface Tokenizer {
  (texts: string[], opts: { padding: true; truncation: true }): Record<string, TokenTensor>
  encode(text: string): number[]
}

interface Loaded {
  tokenizer: Tokenizer
  worker: InferenceWorker<Record<string, TokenTensor>>
}

/** `.ts` when the server runs from source (vitest, tsx), `.js` in the build. */
const WORKER_SCRIPT = new URL(
  import.meta.url.endsWith('.ts') ? './local-worker.ts' : './local-worker.js',
  import.meta.url,
)

const loaded = new Map<string, Promise<Loaded>>()

async function loadTokenizer(modelDir: string): Promise<Tokenizer> {
  const t = await import('@huggingface/transformers')
  t.env.allowRemoteModels = false
  t.env.allowLocalModels = true
  t.env.localModelPath = modelDir.endsWith('/') ? modelDir : `${modelDir}/`
  t.env.cacheDir = null
  return (await t.AutoTokenizer.from_pretrained(LOCAL_MODEL)) as unknown as Tokenizer
}

/**
 * The tokenizer (main thread) and the model's worker, shared per model dir and thread count. A failed load
 * and a worker that has died are dropped, so the next call starts again.
 */
async function load(modelDir: string, threads: number): Promise<Loaded> {
  const key = `${modelDir}\0${threads}`
  const cached = loaded.get(key)
  if (cached) {
    const l = await cached.catch(() => undefined)
    if (l && !l.worker.closed) return l
    if (loaded.get(key) === cached) loaded.delete(key)
  }
  let p = loaded.get(key) // another caller may have started the reload while this one awaited
  if (!p) {
    p = (async () => {
      const tokenizer = await loadTokenizer(modelDir)
      const worker = new InferenceWorker<Record<string, TokenTensor>>(WORKER_SCRIPT, {
        modelDir,
        threads,
        model: LOCAL_MODEL,
        dtype: LOCAL_DTYPE,
      })
      await worker.ready
      return { tokenizer, worker }
    })()
    loaded.set(key, p)
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
  #loaded: Loaded | undefined

  constructor(private readonly opts: { modelDir: string; threads: number }) {}

  /** Whether the model is loaded (countTokens works only then). */
  get loaded(): boolean {
    return this.#loaded !== undefined
  }

  /** Loads the tokenizer and starts the model's worker; after a worker crash, starts a new one. */
  async ready(): Promise<void> {
    if (this.#loaded && !this.#loaded.worker.closed) return
    this.#loaded = await load(this.opts.modelDir, this.opts.threads)
  }

  #require(): Loaded {
    if (!this.#loaded) throw new Error('local embedding model is not loaded; await ready() first')
    return this.#loaded
  }

  /** e5 tokens of the text as embedded: incl. the special tokens and the 3-token `passage: ` prefix. */
  countTokens(text: string): number {
    return this.#require().tokenizer.encode(`passage: ${text}`).length
  }

  async #embed(texts: string[]): Promise<Float32Array[]> {
    await this.ready()
    const { tokenizer, worker } = this.#require()
    const out: Float32Array[] = []
    for (const batch of batches(texts, BATCH)) {
      // tokenize exactly as transformers.js's feature-extraction pipeline does; the worker does the rest
      const encoded = tokenizer(batch, { padding: true, truncation: true })
      const input: Record<string, TokenTensor> = {}
      for (const [name, t] of Object.entries(encoded)) input[name] = { data: t.data, dims: t.dims }
      const buffers = Object.values(input).map((t) => t.data.buffer as ArrayBuffer)
      const res = await this.#queue.run(() => worker.run(input, buffers))
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
