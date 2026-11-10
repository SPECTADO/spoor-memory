/**
 * Admission control of the write-heavy bearer routes (`POST /p/:slug/api/push`, `adr/push`, `docs/push`,
 * `adr/import`): one in-process limiter per server, at most `maxPerProject` requests in flight per project
 * and `maxTotal` over all projects. An excess request is answered at once with 503 `busy` and
 * `Retry-After: 5` (503, not 429: CLI <= 0.5.1 stops on a 5xx but carries on at once after a 4xx). A
 * request stays in flight until its handler returns, also when the client has gone away.
 *
 * The request headers the CLI's import sends (old servers ignore them; the bodies are strict objects, so the
 * flags cannot be body fields):
 * - `Spoor-Defer-Embedding: 1`: store chunks with pending (NULL) embeddings, the embed-pending job fills them;
 * - `Spoor-Import-Edges: defer` (adr/import only): pass 1 only, files with edge work get `edges_deferred`.
 */
import type { Context } from 'hono'
import { ApiError } from '../../lib/errors.js'
import type { AppEnv } from '../../types.js'

export const DEFER_EMBEDDING_HEADER = 'Spoor-Defer-Embedding'
export const IMPORT_EDGES_HEADER = 'Spoor-Import-Edges'
export const PUSH_RETRY_AFTER_S = 5

export class PushAdmission {
  readonly #perProject = new Map<string, number>()
  #total = 0

  constructor(
    readonly maxPerProject: number,
    readonly maxTotal: number,
  ) {}

  /** Requests in flight (for one project, or over all). */
  inFlight(projectId?: string): number {
    return projectId === undefined ? this.#total : (this.#perProject.get(projectId) ?? 0)
  }

  /** Projects with a request in flight (the map holds no entry for an idle project). */
  get activeProjects(): number {
    return this.#perProject.size
  }

  /** A slot, or `undefined` when a limit is reached. The release function is idempotent. */
  tryEnter(projectId: string): (() => void) | undefined {
    const mine = this.#perProject.get(projectId) ?? 0
    if (mine >= this.maxPerProject || this.#total >= this.maxTotal) return undefined
    this.#perProject.set(projectId, mine + 1)
    this.#total++
    let released = false
    return () => {
      if (released) return
      released = true
      this.#total--
      const n = (this.#perProject.get(projectId) ?? 1) - 1
      if (n <= 0) this.#perProject.delete(projectId)
      else this.#perProject.set(projectId, n)
    }
  }
}

/** The import flags of a push request (on only for the exact values). */
export const pushFlags = (c: Context<AppEnv>) => ({
  deferEmbedding: c.req.header(DEFER_EMBEDDING_HEADER) === '1',
  deferEdges: c.req.header(IMPORT_EDGES_HEADER) === 'defer',
})

/**
 * Run `fn` holding a slot of `admission`, or answer 503 `busy` with `Retry-After`. Call after the token and
 * role checks (401 / 403 win) and before reading the body (a refused request is busy even when its body is
 * invalid).
 */
export async function admitted<T>(
  c: Context<AppEnv>,
  admission: PushAdmission,
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = admission.tryEnter(projectId)
  if (!release) {
    // drain the body (at most 1 MiB after the bearer body limit), so the answer reaches a client that is
    // still uploading instead of a connection reset
    await c.req.text().catch(() => '')
    c.header('Retry-After', String(PUSH_RETRY_AFTER_S))
    throw new ApiError('busy', {
      message: 'Too many pushes are running; try again shortly.',
      hint: `Retry after ${PUSH_RETRY_AFTER_S} seconds.`,
    })
  }
  try {
    return await fn()
  } finally {
    release()
  }
}
