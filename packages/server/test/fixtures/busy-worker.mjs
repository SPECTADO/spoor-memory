// A stand-in for local-worker.ts that speaks the same protocol (inference-worker.ts) without a model.
// Like onnxruntime-node's `run`, it answers a request by keeping its own thread busy for `blockMs`.
import { parentPort, workerData } from 'node:worker_threads'

const { blockMs = 0, failLoad = false, dims = 4 } = workerData ?? {}
if (failLoad) {
  parentPort.postMessage({ type: 'failed', message: 'model files are missing' })
} else {
  parentPort.postMessage({ type: 'ready' })
}

parentPort.on('message', ({ id, input: texts }) => {
  if (texts.includes('crash')) process.exit(3)
  if (texts.includes('throw')) {
    parentPort.postMessage({ type: 'error', id, message: 'inference failed' })
    return
  }
  const end = Date.now() + blockMs
  while (Date.now() < end) {}
  // row i is filled with the length of text i
  const data = new Float32Array(texts.length * dims)
  for (const [i, t] of texts.entries()) data.fill(t.length, i * dims, (i + 1) * dims)
  parentPort.postMessage({ type: 'result', id, data, dims: [texts.length, dims] }, [data.buffer])
})
