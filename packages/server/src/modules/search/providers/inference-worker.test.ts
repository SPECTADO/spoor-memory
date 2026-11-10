// InferenceWorker (ADR-0029): inference off the main thread. The fixture worker blocks its own thread the way
// onnxruntime-node's synchronous `run` does; these tests pin that the main thread's event loop keeps turning.
import { describe, expect, it } from 'vitest'
import { InferenceWorker } from './inference-worker.js'

const FIXTURE = new URL('../../../../test/fixtures/busy-worker.mjs', import.meta.url)
const BLOCK_MS = 150
const BATCHES = 4

/** Turns of the event loop (timers phase) while `work` runs. */
async function turnsDuring(work: () => Promise<unknown>): Promise<number> {
  let turns = 0
  const timer = setInterval(() => {
    turns++
  }, 5)
  try {
    await work()
  } finally {
    clearInterval(timer)
  }
  return turns
}

/** What transformers.js does on the calling thread: `setImmediate(() => resolve(session.run(...)))`. */
const blockingRun = () =>
  new Promise<void>((resolve) =>
    setImmediate(() => {
      const end = Date.now() + BLOCK_MS
      while (Date.now() < end) {}
      resolve()
    }),
  )

describe('InferenceWorker', () => {
  it('keeps the event loop turning while batches run (in-thread inference stalls it)', async () => {
    // the bug: back-to-back synchronous batches leave the loop about one turn per batch
    const stalled = await turnsDuring(async () => {
      for (let i = 0; i < BATCHES; i++) await blockingRun()
    })
    expect(stalled).toBeLessThanOrEqual(BATCHES + 2)

    const w = new InferenceWorker(FIXTURE, { blockMs: BLOCK_MS })
    try {
      await w.ready
      const free = await turnsDuring(async () => {
        for (let i = 0; i < BATCHES; i++) await w.run(['x'])
      })
      // 600 ms of inference at a 5 ms interval is about 120 turns; a loaded CI machine still gives dozens
      expect(free).toBeGreaterThan(stalled * 5)
      expect(free).toBeGreaterThan(30)
    } finally {
      await w.terminate()
    }
  })

  it('answers each request with its own rows, in order', async () => {
    const w = new InferenceWorker(FIXTURE, { dims: 3 })
    try {
      await w.ready
      const [a, b] = await Promise.all([w.run(['a', 'bbb']), w.run(['cc'])])
      expect(a?.dims).toEqual([2, 3])
      expect(Array.from(a?.data ?? [])).toEqual([1, 1, 1, 3, 3, 3])
      expect(Array.from(b?.data ?? [])).toEqual([2, 2, 2])
      expect(w.closed).toBe(false)
    } finally {
      await w.terminate()
    }
  })

  it('a failed request rejects alone; the worker keeps serving', async () => {
    const w = new InferenceWorker(FIXTURE, {})
    try {
      await w.ready
      await expect(w.run(['throw'])).rejects.toThrow('inference failed')
      expect((await w.run(['ok'])).dims).toEqual([1, 4])
    } finally {
      await w.terminate()
    }
  })

  it('a model that fails to load rejects ready and every later run', async () => {
    const w = new InferenceWorker(FIXTURE, { failLoad: true })
    await expect(w.ready).rejects.toThrow('model files are missing')
    expect(w.closed).toBe(true)
    await expect(w.run(['x'])).rejects.toThrow('model files are missing')
  })

  it('a worker that dies rejects what was in flight and reports closed', async () => {
    const w = new InferenceWorker(FIXTURE, {})
    await w.ready
    const inFlight = [w.run(['crash']), w.run(['never answered'])]
    for (const p of inFlight) await expect(p).rejects.toThrow(/exited \(code 3\)/)
    expect(w.closed).toBe(true)
    await expect(w.run(['x'])).rejects.toThrow(/exited/)
  })
})
