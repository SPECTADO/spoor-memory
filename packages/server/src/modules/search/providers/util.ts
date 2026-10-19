/** Small helpers shared by the embedding providers. */

/** L2-normalise in place (a zero vector stays zero). */
export function l2normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (const x of v) sum += x * x
  const n = Math.sqrt(sum)
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / n
  return v
}

export function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Runs tasks one at a time, in order (one inference at a time keeps the HTTP server responsive). */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(task, task)
    this.#tail = next.catch(() => undefined)
    return next
  }
}

export class EmbeddingTimeoutError extends Error {
  constructor(ms: number) {
    super(`embedding timed out after ${ms} ms`)
    this.name = 'EmbeddingTimeoutError'
  }
}

/** Reject after `ms` (the underlying work is not cancelled; its result is ignored). */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EmbeddingTimeoutError(ms)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/** `${name}:${model}${variant ? '@' + variant : ''}/${dims}` */
export function providerTag(name: string, model: string, variant: string, dims: number): string {
  return `${name}:${model}${variant ? `@${variant}` : ''}/${dims}`
}

/** Model tags and dims are inlined into vector SQL; both must pass these checks (auth-and-security.md 10). */
export const TAG_RE = /^[A-Za-z0-9:/@._-]+$/

export function assertSafeTag(tag: string): string {
  if (!TAG_RE.test(tag) || tag.length > 200) throw new Error(`unsafe model tag ${JSON.stringify(tag)}`)
  return tag
}

export function assertSafeDims(dims: number): number {
  if (!Number.isInteger(dims) || dims < 1 || dims > 2000) throw new Error(`unsafe dims ${dims}`)
  return dims
}

/** The dims encoded at the end of a tag (`…/384`), or null. */
export function dimsOfTag(tag: string): number | null {
  const m = /\/(\d{1,4})$/.exec(tag)
  return m ? Number.parseInt(m[1] as string, 10) : null
}

/**
 * A conservative counter for when no tokenizer is available (provider not loaded, or a tag no provider in
 * this image serves): one token per BMP code point, two above, plus special tokens and the prefix. No real
 * subword tokenizer produces more, so chunks cut with it always fit the model later.
 */
export function fallbackCount(text: string): number {
  let n = 8
  for (const ch of text) n += (ch.codePointAt(0) as number) > 0xffff ? 2 : 1
  return n
}

/** A message safe for logs and `job_runs`: the status and type, never a key or a response body. */
export function remoteError(provider: string, status: number): Error {
  return new Error(`${provider} embeddings request failed with HTTP ${status}`)
}
