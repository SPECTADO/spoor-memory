/**
 * Cross-module interfaces. Modules code against these, never against each other's internals, so each can
 * be built and tested alone: the item service calls SearchPort without knowing the chunker, the search
 * module calls EmbeddingProvider without knowing ONNX, everything that wants a job run calls JobsPort.
 *
 * The real implementations live in their modules (embeddings, search, jobs) and are bound in src/runtime.ts.
 * `NoopSearchPort` at the bottom is the placeholder runtime.ts starts with; the in-memory fakes for tests
 * (`FakeEmbeddingProvider`, `StaticEmbeddingRegistry`, `MemoryJobsPort`, `stubPorts`) live in test/ports.ts
 * and never ship. Design: docs/design/search-and-digest.md sections 1 to 5, cleanup-and-jobs.md.
 */
import type { SPACES } from './db/schema.js'
import type { DbOrTx, Tx } from './lib/db.js'

export type Space = (typeof SPACES)[number]

// ---- embeddings (search-and-digest.md section 2) ------------------------------------------------------

export interface EmbeddingProvider {
  readonly name: 'local' | 'openai' | 'voyage'
  /** e.g. 'Xenova/multilingual-e5-small' */
  readonly model: string
  /** dtype for local ('q8'), '' for remote */
  readonly variant: string
  readonly dims: number
  /** `${name}:${model}${variant ? '@' + variant : ''}/${dims}`; stored in `chunks.model`. */
  readonly tag: string
  /** 512 for e5; the chunker keeps every chunk at most `maxInputTokens - 16`. */
  readonly maxInputTokens: number
  /** Load the model / check the key; the readiness gate of /healthz for the default provider. */
  ready(): Promise<void>
  /** Chunker only. */
  countTokens(text: string): number
  /** L2-normalised. The provider adds any model-specific prefix (`query: `) itself. */
  embedQuery(text: string): Promise<Float32Array>
  /** L2-normalised, same order as the input. The provider adds `passage: ` itself. */
  embedPassages(texts: string[]): Promise<Float32Array[]>
}

/** Providers built once from env; projects name theirs in `settings.embedding.provider`. */
export interface EmbeddingRegistry {
  readonly defaultProvider: EmbeddingProvider
  byName(name: string): EmbeddingProvider | undefined
  /** `undefined` for a tag no provider in this image serves (default-model upgrade: FTS-only). */
  byTag(tag: string): EmbeddingProvider | undefined
  list(): EmbeddingProvider[]
}

// ---- search (search-and-digest.md sections 1, 3, 5) ---------------------------------------------------

/** The text an item is chunked from: title, tags line, body (frontmatter is never embedded). */
export interface ChunkSource {
  projectId: string
  space: Space
  title: string
  tags: string[]
  body: string
}

export interface PreparedChunk {
  model: string
  dims: number
  ordinal: number
  text: string
  /** `null` = embedding pending (provider failed or timed out); the embed-pending job fills it in. */
  embedding: Float32Array | null
}

/**
 * Chunks built and embedded BEFORE the write transaction (embedding takes time; the transaction must not
 * wait on it). `models` is the model set read when preparing; `indexItemChunks` re-reads it under
 * `FOR SHARE` and stores NULL-embedding chunks for any model missing here.
 */
export interface PreparedChunks {
  source: ChunkSource
  models: string[]
  chunks: PreparedChunk[]
  /** true when any chunk has no embedding. */
  pending: boolean
}

export interface DedupeQuery {
  projectId: string
  space: Space
  /** Candidate memory type; non-observations never match observations. `null` outside memories. */
  type: string | null
  /** The `supersedes` target, never reported as a duplicate. */
  excludeItemId?: string | null
  /** Chunk 0 of `prepared` is the probe vector. */
  prepared: PreparedChunks
}

export interface DedupeCandidate {
  id: string
  number: number
  adrNumber: number | null
  space: Space
  title: string
  type: string | null
  revision: number
  lifecycle: string
  cos: number
  /** Same title and body as the probe, ignoring case and runs of whitespace: the only refused duplicate. */
  sameText: boolean
  /** Values (numbers, identifiers, ...) each chunk 0 states and the other lacks; non-null = a different claim. */
  values: { new: string[]; existing: string[] } | null
}

export interface DedupeResult {
  /**
   * Best first, at most 5; a hit is the first with `cos >= threshold` and `values === null` (the caller applies
   * the setting).
   */
  candidates: DedupeCandidate[]
  /** true when no probe vector exists (embedding pending, FTS-only project): `note: duplicate check skipped`. */
  skipped: boolean
}

/** Related-item candidates (ADR-0022): nearest unlinked items by best-chunk cosine, nothing stored. */
export interface RelatedQuery {
  /** The probe item's project: its active model, its items, and `_shared` when `includeShared`. */
  projectId: string
  /** The probe item: never a candidate, nor any item joined to it by an edge in either direction. */
  itemId: string
  /** Probe vectors (e.g. just prepared by a write); omitted = the item's stored chunks of the active model. */
  chunks?: PreparedChunk[]
  /** Add `_shared` items when `_shared`'s active model equals the project's (ignored for `_shared` itself). */
  includeShared: boolean
  /** Further items never suggested (e.g. linked in the same call). */
  excludeIds?: string[]
  /** Floor (inclusive) on the best-chunk cosine. */
  minCos: number
  limit: number
}

export interface RelatedCandidate {
  id: string
  cos: number
}

export interface RelatedResult {
  /** Best first (cos desc, then updated_at desc), at most `limit`. */
  candidates: RelatedCandidate[]
  /** true when no probe vector exists (embedding pending, unknown model dims). */
  pending: boolean
}

export interface IndexedItem {
  id: string
  projectId: string
  space: Space
  revision: number
}

export interface SearchPort {
  /** Chunk + embed outside any transaction (20 s timeout per design; failure gives NULL embeddings). */
  prepareChunks(source: ChunkSource): Promise<PreparedChunks>
  /** Near-duplicate candidates within (project, space), search-and-digest.md section 5. */
  dedupeCandidates(db: DbOrTx, query: DedupeQuery): Promise<DedupeResult>
  /**
   * Inside the item write transaction: lock the project's model set `FOR SHARE`, replace the item's chunks
   * for the active (and target) model at `item.revision`. Returns whether any embedding is pending.
   */
  indexItemChunks(tx: Tx, item: IndexedItem, prepared: PreparedChunks): Promise<{ embeddingPending: boolean }>
  /** Related unlinked items by embedding similarity (ADR-0022), for `GET …/related` and the MCP replies. */
  relatedCandidates(db: DbOrTx, query: RelatedQuery): Promise<RelatedResult>
}

// ---- jobs (cleanup-and-jobs.md section 4) ---------------------------------------------------------------

export const JOB_NAMES = ['cleanup', 'embed-pending', 'reembed', 'purge-ephemeral'] as const
export type JobName = (typeof JOB_NAMES)[number]

export interface JobsPort {
  /**
   * Ask for a run soon (e.g. `reembed` after a provider change, `embed-pending` after a write with NULL
   * embeddings). A nudge, not a queue: the job still takes its DB lease, and a no-op when jobs are off.
   */
  enqueue(name: JobName, opts?: { projectId?: string }): void
}

/** `job_runs.stats`: small counters, never secrets or item text. */
export type JobStats = Record<string, unknown>

/**
 * What a long-running job function needs from the scheduler, the ONE context shape both modules use (the
 * jobs module's `JobContext` extends it; the search module's job functions take it directly, review C7).
 * Contract: check `signal` between batches and stop when aborted; stop starting batches after `deadline`;
 * call `renewLease()` after each batch (it throws `LeaseLostError` when another holder took the lease).
 */
export interface BatchContext {
  /** Aborted at shutdown or when the lease is lost. */
  readonly signal: AbortSignal
  /** Wall-clock budget end (ms since epoch); `Infinity` when the job has none. */
  readonly deadline: number
  renewLease(): Promise<void>
}

export class LeaseLostError extends Error {
  constructor(name: string) {
    super(`lease of job ${name} was lost`)
    this.name = 'LeaseLostError'
  }
}

/** A handler failure that still carries the stats gathered so far (an abort, a lost lease, a failing project). */
export class JobError extends Error {
  constructor(
    message: string,
    readonly stats: JobStats,
  ) {
    super(message)
    this.name = 'JobError'
  }
}

/**
 * The search module's background work as the scheduler runs it (search-and-digest.md section 3). Every write
 * is idempotent (`AND embedding IS NULL`, re-checked cut-over), so a re-run after a crash is safe. A stop by
 * deadline returns the stats; an abort or a lost lease throws `JobError` with them.
 */
export interface SearchJobs {
  /** Fill `chunks.embedding IS NULL`, 64 per batch. Stats: `{embedded, ...}`. */
  embedPending(ctx: BatchContext): Promise<JobStats>
  /** Re-embed projects with an `embedding_target` and cut over. */
  reembed(ctx: BatchContext): Promise<JobStats>
  /** Re-chunk items missing chunks for the active model at their revision (at most 200 per run). */
  chunkSweep(ctx: BatchContext): Promise<{ rechunked: number }>
}

export interface Ports {
  embeddings: EmbeddingRegistry
  search: SearchPort
  jobs: JobsPort
}

// ---- placeholder ----------------------------------------------------------------------------------------

/** No chunks, no dedupe: the SearchPort before the search module is bound (src/runtime.ts) and in tests. */
export class NoopSearchPort implements SearchPort {
  readonly indexed: IndexedItem[] = []

  async prepareChunks(source: ChunkSource): Promise<PreparedChunks> {
    return { source, models: [], chunks: [], pending: false }
  }

  async dedupeCandidates(): Promise<DedupeResult> {
    return { candidates: [], skipped: true }
  }

  async indexItemChunks(_tx: Tx, item: IndexedItem): Promise<{ embeddingPending: boolean }> {
    this.indexed.push(item)
    return { embeddingPending: false }
  }

  async relatedCandidates(): Promise<RelatedResult> {
    return { candidates: [], pending: true }
  }
}
