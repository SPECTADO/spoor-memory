/**
 * A worker thread that runs embedding inference, and the promise API over it (ADR-0029).
 *
 * onnxruntime-node's `InferenceSession.run` is synchronous: transformers.js calls it inside `setImmediate`, so a
 * batch of passages keeps the thread that called it busy for the whole inference. On the main thread that
 * stalled every request, timer and socket for the length of a batch (over a second for 8 full chunks), and a
 * new Postgres connection, which needs about a dozen turns of the event loop, ran into its 5 s timeout. The
 * model therefore lives in a worker, and the main thread only posts inputs and awaits vectors.
 *
 * Protocol (the worker script, `local-worker.ts` or a test fixture):
 * - on start it loads the model from `workerData`, then posts `{ type: 'ready' }` or `{ type: 'failed', message }`;
 * - request `{ id, input }` is answered by `{ type: 'result', id, data, dims }` (`data` transferred, row-major
 *   `rows x dims[last]`) or `{ type: 'error', id, message }`.
 */
import { Worker } from 'node:worker_threads'

export interface InferenceResult {
  data: Float32Array
  dims: number[]
}

type FromWorker =
  | { type: 'ready' }
  | { type: 'failed'; message: string }
  | { type: 'result'; id: number; data: Float32Array; dims: number[] }
  | { type: 'error'; id: number; message: string }

interface Pending {
  resolve: (r: InferenceResult) => void
  reject: (err: Error) => void
}

export class InferenceWorker<Input = unknown> {
  /** Resolves once the model is loaded; rejects when the load fails or the worker dies first. */
  readonly ready: Promise<void>
  readonly #worker: Worker
  readonly #pending = new Map<number, Pending>()
  #nextId = 1
  #closed: Error | undefined

  constructor(script: URL, workerData: unknown) {
    this.#worker = new Worker(script, { workerData })
    // an idle worker must not keep the process alive; `run` refs it while requests are in flight
    this.#worker.unref()
    let settle: { resolve: () => void; reject: (err: Error) => void } | undefined
    this.ready = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject }
    })
    this.ready.catch(() => undefined) // a failed load is reported to whoever awaits `ready`, not as unhandled
    this.#worker.ref() // until the load settles
    const loaded = (err?: Error) => {
      if (!settle) return
      const s = settle
      settle = undefined
      this.#idle()
      if (err) s.reject(err)
      else s.resolve()
    }
    const close = (err: Error) => {
      if (this.#closed) return
      this.#closed = err
      loaded(err)
      for (const p of this.#pending.values()) p.reject(err)
      this.#pending.clear()
    }
    this.#worker.on('message', (m: FromWorker) => {
      if (m.type === 'ready') return loaded()
      if (m.type === 'failed') {
        close(new Error(m.message))
        void this.#worker.terminate()
        return
      }
      const p = this.#pending.get(m.id)
      if (!p) return
      this.#pending.delete(m.id)
      this.#idle()
      if (m.type === 'result') p.resolve({ data: m.data, dims: m.dims })
      else p.reject(new Error(m.message))
    })
    this.#worker.on('error', (err) => close(err instanceof Error ? err : new Error(String(err))))
    this.#worker.on('exit', (code) => close(new Error(`embedding worker exited (code ${code})`)))
  }

  /** True once the worker failed to load, crashed or was terminated: make a new one. */
  get closed(): boolean {
    return this.#closed !== undefined
  }

  /**
   * Embed one batch. Requests are answered in the order they were posted, one at a time. Buffers listed in
   * `transfer` move to the worker and are unusable here afterwards.
   */
  run(input: Input, transfer: ArrayBuffer[] = []): Promise<InferenceResult> {
    if (this.#closed) return Promise.reject(this.#closed)
    const id = this.#nextId++
    return new Promise<InferenceResult>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#worker.ref()
      this.#worker.postMessage({ id, input }, transfer)
    })
  }

  async terminate(): Promise<void> {
    await this.#worker.terminate()
  }

  #idle() {
    if (this.#pending.size === 0) this.#worker.unref()
  }
}
