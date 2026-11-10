/**
 * Worker thread entry of the local embedding model (see inference-worker.ts for why and for the protocol).
 * Loads the ONNX model offline from `workerData.modelDir` and turns tokenized batches into mean-pooled,
 * normalised vectors. The steps after tokenization are those of transformers.js's feature-extraction
 * pipeline with `{ pooling: 'mean', normalize: true }`, so the vectors are bit-identical to the pipeline's.
 * Tokenization happens on the main thread (the chunker needs the tokenizer there, synchronously), so the
 * 17 MB tokenizer is loaded once per process, not once per thread.
 *
 * Keep this file free of imports from the server's own sources and of non-erasable TypeScript: under vitest
 * and `tsx` it is started as a `.ts` worker.
 */
import { parentPort, workerData } from 'node:worker_threads'

interface Init {
  modelDir: string
  threads: number
  model: string
  dtype: string
}

/** One tokenizer output tensor: int64 values and their shape `[batch, tokens]`. */
interface WireTensor {
  data: BigInt64Array
  dims: number[]
}

const port = parentPort
if (!port) throw new Error('local-worker.ts must be started as a worker thread')
const init = workerData as Init

type Lib = typeof import('@huggingface/transformers')
let lib: Lib | undefined
let model: Awaited<ReturnType<Lib['AutoModel']['from_pretrained']>> | undefined
try {
  lib = await import('@huggingface/transformers')
  lib.env.allowRemoteModels = false
  lib.env.allowLocalModels = true
  lib.env.localModelPath = init.modelDir.endsWith('/') ? init.modelDir : `${init.modelDir}/`
  lib.env.cacheDir = null
  // onnxruntime's SessionOptions field is camelCase `intraOpNumThreads` (a snake_case key is ignored)
  model = await lib.AutoModel.from_pretrained(init.model, {
    dtype: init.dtype as 'q8',
    session_options: { intraOpNumThreads: init.threads },
  })
  port.postMessage({ type: 'ready' })
} catch (err) {
  port.postMessage({ type: 'failed', message: err instanceof Error ? err.message : String(err) })
}

port.on('message', async (m: { id: number; input: Record<string, WireTensor> }) => {
  try {
    if (!lib || !model) throw new Error('local embedding model is not loaded')
    const { Tensor, mean_pooling } = lib
    const inputs = Object.fromEntries(
      Object.entries(m.input).map(([name, t]) => [name, new Tensor('int64', t.data, t.dims)]),
    )
    const attention = inputs.attention_mask
    if (!attention) throw new Error('attention_mask is missing from the tokenized batch')
    const outputs = await model(inputs)
    const hidden = outputs.last_hidden_state ?? outputs.logits ?? outputs.token_embeddings
    const pooled = mean_pooling(hidden, attention).normalize(2, -1)
    const data = Float32Array.from(pooled.data as Float32Array)
    port.postMessage({ type: 'result', id: m.id, data, dims: pooled.dims }, [data.buffer])
  } catch (err) {
    port.postMessage({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) })
  }
})
