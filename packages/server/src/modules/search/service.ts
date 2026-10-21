/**
 * The search module's SearchPort implementation plus hybrid search (docs/design/search-and-digest.md
 * sections 1 to 5):
 * - prepareChunks: chunk + embed OUTSIDE any transaction, per model of the project's model set (active and,
 *   during a re-embed, target), 20 s timeout; a failure leaves `embedding = NULL` (embed-pending fills it);
 * - indexItemChunks: inside the item write transaction, lock the model set `FOR SHARE` and replace the item's
 *   chunks for every model of the locked set (a model not prepared gets NULL-embedding chunks);
 * - dedupeCandidates: chunk-0 cosine within (project, space, active model), exclusions per section 5;
 * - relatedCandidates: best-chunk cosine over the project (+ `_shared` on the same model), unlinked only
 *   (related.ts, ADR-0022);
 * - search: FTS (`simple` + unaccent, prefix tsquery) and vector cosine on the active model, fused by RRF
 *   (k = 60), project and shared merged by score.
 */
import { spaces } from '@spoor/shared'
import { eq, sql } from 'drizzle-orm'
import { chunks as chunksTable } from '../../db/schema.js'
import type { DbOrTx, Tx } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import type {
  ChunkSource,
  DedupeCandidate,
  DedupeQuery,
  DedupeResult,
  EmbeddingProvider,
  IndexedItem,
  PreparedChunk,
  PreparedChunks,
  RelatedQuery,
  RelatedResult,
  SearchPort,
  Space,
} from '../../ports.js'
import { chunkItem, type TokenCounter } from './chunker.js'
import { LocalE5Provider } from './providers/local.js'
import { dimsOfTag, fallbackCount, withTimeout } from './providers/util.js'
import { buildTsQuery, makeSnippet, mergeScopes, normalizeQuery, queryTokens } from './query.js'
import { relatedCandidates } from './related.js'
import {
  DIGEST_ELIGIBLE,
  inList,
  type ProjectModels,
  projectModels,
  sharedProjectModels,
  tagLiteral,
  textArray,
  vectorLiteral,
  vectorType,
} from './sql.js'

export const EMBED_TIMEOUT_MS = 20_000
export const BRANCH_LIMIT = 50
export const NOTE_VECTOR_UNAVAILABLE = 'vector search unavailable'
export const NOTE_REEMBEDDING = 'vector search unavailable (re-embedding)'
export const SPACES_ALL: Space[] = [...spaces]

// ---- token counters ---------------------------------------------------------------------------------

/** A counter that never needs a loaded model (FTS-only tags, a provider that failed to load). */
export function fallbackCounter(maxInputTokens = 512): TokenCounter {
  return { maxInputTokens, countTokens: fallbackCount }
}

/** The provider's own counter when usable right now (no I/O), else the fallback. */
export function syncCounter(provider: EmbeddingProvider | undefined): TokenCounter {
  if (!provider) return fallbackCounter()
  if (provider instanceof LocalE5Provider && !provider.loaded) return fallbackCounter(provider.maxInputTokens)
  try {
    provider.countTokens('probe')
    return provider
  } catch {
    return fallbackCounter(provider.maxInputTokens)
  }
}

// ---- query vector cache -----------------------------------------------------------------------------

/** LRU of query vectors keyed by (tag, normalised query): 256 entries, 10 minutes. */
export class QueryVectorCache {
  readonly #map = new Map<string, { v: Float32Array; at: number }>()
  constructor(
    private readonly max = 256,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  get(tag: string, q: string): Float32Array | undefined {
    const key = `${tag}\0${q}`
    const hit = this.#map.get(key)
    if (!hit) return undefined
    this.#map.delete(key)
    if (Date.now() - hit.at > this.ttlMs) return undefined
    this.#map.set(key, hit)
    return hit.v
  }

  set(tag: string, q: string, v: Float32Array): void {
    const key = `${tag}\0${q}`
    this.#map.delete(key)
    this.#map.set(key, { v, at: Date.now() })
    while (this.#map.size > this.max) {
      const oldest = this.#map.keys().next().value as string
      this.#map.delete(oldest)
    }
  }
}

// ---- search types -----------------------------------------------------------------------------------

export interface SearchParams {
  projectId: string
  query: string
  spaces?: Space[]
  type?: string | null
  tags?: string[]
  limit: number
  includeShared: boolean
  includeInactive: boolean
  /** Digest tier 4: only digest-eligible items (active, not drafted into an accepted ADR, …). */
  digestEligible?: boolean
}

export interface SearchHit {
  id: string
  projectId: string
  /** The item lives in `_shared` and the search ran from a regular project (handle gets `S:`). */
  shared: boolean
  space: Space
  number: number
  adrNumber: number | null
  title: string
  type: string | null
  status: string
  lifecycle: string
  revision: number
  provenance: string
  confidence: string | null
  decidedOn: string | null
  expiresAt: Date | null
  pinned: boolean
  score: number
  snippet: string
}

export interface SearchResult {
  hits: SearchHit[]
  /** `vector search unavailable` / `vector search unavailable (re-embedding)`, deduplicated. */
  notes: string[]
}

type HitRow = {
  id: string
  project_id: string
  space: Space
  number: number
  adr_number: number | null
  title: string
  type: string | null
  status: string
  lifecycle: string
  revision: number
  provenance: string
  confidence: string | null
  decided_on: string | null
  expires_at: Date | string | null
  pinned: boolean
  score: number
  chunk_text: string
}

// ---- the service --------------------------------------------------------------------------------------

export class SearchService implements SearchPort {
  readonly queryCache = new QueryVectorCache()

  constructor(private readonly deps: ServerDeps) {}

  get #registry() {
    return this.deps.ports.embeddings
  }

  /** Chunk and embed for one model tag (no transaction open). */
  async prepareForTag(tag: string, source: ChunkSource): Promise<PreparedChunk[]> {
    const provider = this.#registry.byTag(tag)
    let ready = false
    if (provider) {
      try {
        await withTimeout(provider.ready(), EMBED_TIMEOUT_MS)
        ready = true
      } catch (err) {
        this.deps.logger.warn({ tag, err: (err as Error).message }, 'embedding provider not ready')
      }
    }
    const counter = ready && provider ? provider : fallbackCounter(provider?.maxInputTokens)
    const texts = chunkItem(source, counter)
    let vectors: (Float32Array | null)[] = texts.map(() => null)
    if (ready && provider) {
      try {
        const got = await withTimeout(provider.embedPassages(texts), EMBED_TIMEOUT_MS)
        if (got.length === texts.length) vectors = got
      } catch (err) {
        this.deps.logger.warn(
          { tag, err: (err as Error).message },
          'embedding failed; chunks stored as pending',
        )
      }
    }
    const dims = provider?.dims ?? dimsOfTag(tag) ?? 1
    return texts.map((text, ordinal) => ({
      model: tag,
      dims,
      ordinal,
      text,
      embedding: vectors[ordinal] ?? null,
    }))
  }

  async prepareChunks(source: ChunkSource): Promise<PreparedChunks> {
    const p = await projectModels(this.deps.db, source.projectId)
    const models = p ? [...new Set([p.model, ...(p.target ? [p.target] : [])])] : []
    const out: PreparedChunk[] = []
    for (const tag of models) out.push(...(await this.prepareForTag(tag, source)))
    return { source, models, chunks: out, pending: out.some((c) => c.embedding === null) }
  }

  async indexItemChunks(
    tx: Tx,
    item: IndexedItem,
    prepared: PreparedChunks,
  ): Promise<{ embeddingPending: boolean }> {
    // serialises against the re-embed cut-over, which takes FOR UPDATE on the same row
    const locked = await tx.execute<{ embedding_model: string; embedding_target: string | null }>(
      sql`SELECT embedding_model, embedding_target FROM projects WHERE id = ${item.projectId} FOR SHARE`,
    )
    const row = locked.rows[0]
    if (!row) throw new Error(`indexItemChunks: no project ${item.projectId}`)
    const models = [
      ...new Set([row.embedding_model, ...(row.embedding_target ? [row.embedding_target] : [])]),
    ]

    // every chunk of the item goes: models of the locked set are rebuilt below, any other model's are leftovers
    await tx.delete(chunksTable).where(eq(chunksTable.itemId, item.id))

    let pending = false
    for (const tag of models) {
      let rows = prepared.chunks.filter((c) => c.model === tag)
      if (rows.length === 0) {
        // the model set changed after prepareChunks (or nothing was prepared): NULL-embedding chunks now
        const provider = this.#registry.byTag(tag)
        const texts = chunkItem(prepared.source, syncCounter(provider))
        const dims = provider?.dims ?? dimsOfTag(tag) ?? 1
        rows = texts.map((text, ordinal) => ({ model: tag, dims, ordinal, text, embedding: null }))
      }
      if (rows.some((r) => r.embedding === null)) pending = true
      await tx.insert(chunksTable).values(
        rows.map((r) => ({
          itemId: item.id,
          projectId: item.projectId,
          space: item.space,
          ordinal: r.ordinal,
          itemRevision: item.revision,
          text: r.text,
          model: r.model,
          dims: r.dims,
          embedding: r.embedding ? Array.from(r.embedding) : null,
        })),
      )
    }
    return { embeddingPending: pending }
  }

  async dedupeCandidates(db: DbOrTx, q: DedupeQuery): Promise<DedupeResult> {
    const p = await projectModels(db, q.projectId)
    if (!p) return { candidates: [], skipped: true }
    const provider = this.#registry.byTag(p.model)
    if (!provider) return { candidates: [], skipped: true } // FTS-only until the re-embed cuts over (I36)
    const probe = q.prepared.chunks.find(
      (c) => c.model === p.model && c.ordinal === 0 && c.embedding !== null,
    )
    if (!probe?.embedding) return { candidates: [], skipped: true }
    const vt = vectorType(provider.dims)
    const tag = tagLiteral(p.model)
    const v = vectorLiteral(probe.embedding)
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL hnsw.ef_search = 100`)
      await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`)
      const res = await tx.execute<{
        id: string
        number: number
        adr_number: number | null
        space: Space
        title: string
        type: string | null
        revision: number
        lifecycle: string
        cos: number
      }>(sql`
        SELECT i.id, i.number, i.adr_number, i.space, i.title, i.type, i.revision, i.lifecycle,
               (1 - (c.embedding::${vt} <=> ${v}::${vt}))::float8 AS cos
        FROM chunks c JOIN items i ON i.id = c.item_id
        WHERE c.project_id = ${q.projectId} AND c.space = ${q.space} AND c.model = ${tag} AND c.ordinal = 0
          AND c.embedding IS NOT NULL
          AND i.lifecycle <> 'archived' AND i.status NOT IN ('superseded','deprecated')
          AND (i.expires_at IS NULL OR i.expires_at > now())
          AND (${q.type}::text IS NULL OR i.type IS DISTINCT FROM 'observation' OR ${q.type}::text = 'observation')
          AND i.id IS DISTINCT FROM ${q.excludeItemId ?? null}::uuid
        ORDER BY c.embedding::${vt} <=> ${v}::${vt}
        LIMIT 5`)
      return res.rows
    })
    const candidates: DedupeCandidate[] = rows.map((r) => ({
      id: r.id,
      number: r.number,
      adrNumber: r.adr_number,
      space: r.space,
      title: r.title,
      type: r.type,
      revision: r.revision,
      lifecycle: r.lifecycle,
      cos: Number(r.cos),
    }))
    return { candidates, skipped: false }
  }

  relatedCandidates(db: DbOrTx, q: RelatedQuery): Promise<RelatedResult> {
    return relatedCandidates(this.#registry, db, q)
  }

  /** The query vector for a tag (LRU cached), or null when the provider fails. */
  async #queryVector(provider: EmbeddingProvider, q: string): Promise<Float32Array | null> {
    const hit = this.queryCache.get(provider.tag, q)
    if (hit) return hit
    try {
      await withTimeout(provider.ready(), EMBED_TIMEOUT_MS)
      const v = await withTimeout(provider.embedQuery(q), EMBED_TIMEOUT_MS)
      this.queryCache.set(provider.tag, q, v)
      return v
    } catch (err) {
      this.deps.logger.warn({ tag: provider.tag, err: (err as Error).message }, 'query embedding failed')
      return null
    }
  }

  async #searchScope(
    scope: ProjectModels,
    sharedFromProject: boolean,
    tsq: string,
    normQuery: string,
    p: SearchParams,
    notes: Set<string>,
  ): Promise<SearchHit[]> {
    const provider = this.#registry.byTag(scope.model)
    let vector: Float32Array | null = null
    if (!provider) notes.add(NOTE_REEMBEDDING)
    else {
      vector = await this.#queryVector(provider, normQuery)
      if (!vector) notes.add(NOTE_VECTOR_UNAVAILABLE)
    }
    if (tsq === '' && !vector) return []

    const tag = tagLiteral(scope.model)
    const spaces = p.spaces && p.spaces.length > 0 ? p.spaces : SPACES_ALL
    const filtered = !!p.type || (p.tags?.length ?? 0) > 0 || !!p.digestEligible
    const branch = filtered ? Math.max(BRANCH_LIMIT, p.limit * 3) : BRANCH_LIMIT
    const emptyBranch = sql`SELECT NULL::uuid AS item_id, NULL::bigint AS chunk_id, NULL::bigint AS r WHERE false`

    const fts =
      tsq === ''
        ? emptyBranch
        : sql`SELECT item_id, chunk_id, row_number() OVER (ORDER BY rank DESC, chunk_id) AS r
              FROM (SELECT c.item_id, c.id AS chunk_id, ts_rank_cd(c.tsv, q, 32) AS rank
                    FROM chunks c, to_tsquery('simple', ${tsq}) q
                    WHERE c.project_id = ${scope.id} AND c.model = ${tag} AND c.space IN ${inList(spaces)}
                      AND c.tsv @@ q
                    ORDER BY rank DESC, c.id LIMIT ${branch}) s`
    let vec = emptyBranch
    if (vector && provider) {
      const vt = vectorType(provider.dims)
      const v = vectorLiteral(vector)
      vec = sql`SELECT item_id, chunk_id, row_number() OVER (ORDER BY dist, chunk_id) AS r
                FROM (SELECT c.item_id, c.id AS chunk_id, c.embedding::${vt} <=> ${v}::${vt} AS dist
                      FROM chunks c
                      WHERE c.project_id = ${scope.id} AND c.model = ${tag} AND c.space IN ${inList(spaces)}
                        AND c.embedding IS NOT NULL
                      ORDER BY c.embedding::${vt} <=> ${v}::${vt} LIMIT ${branch}) s`
    }
    const filters = [
      sql`(i.expires_at IS NULL OR i.expires_at > now())`,
      p.includeInactive
        ? sql`true`
        : sql`(i.lifecycle <> 'archived' AND i.status NOT IN ('superseded','deprecated'))`,
    ]
    if (p.type) filters.push(sql`i.type = ${p.type}`)
    if (p.tags && p.tags.length > 0) filters.push(sql`i.tags @> ${textArray(p.tags)}`)
    if (p.digestEligible) filters.push(DIGEST_ELIGIBLE)

    const rows = await this.deps.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL hnsw.ef_search = 100`)
      await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`)
      const res = await tx.execute<HitRow>(sql`
        WITH fts AS (${fts}), vec AS (${vec}),
        fused AS (
          SELECT COALESCE(f.item_id, v.item_id) AS item_id, COALESCE(f.chunk_id, v.chunk_id) AS chunk_id,
                 COALESCE(1.0 / (60 + f.r), 0) + COALESCE(1.0 / (60 + v.r), 0) AS score
          FROM fts f FULL OUTER JOIN vec v ON f.chunk_id = v.chunk_id
        ), best AS (
          SELECT DISTINCT ON (item_id) item_id, chunk_id, score FROM fused ORDER BY item_id, score DESC, chunk_id
        )
        SELECT i.id, i.project_id, i.space, i.number, i.adr_number, i.title, i.type, i.status, i.lifecycle,
               i.revision, i.provenance, i.confidence, i.decided_on::text AS decided_on, i.expires_at, i.pinned,
               b.score::float8 AS score, ch.text AS chunk_text
        FROM best b JOIN items i ON i.id = b.item_id JOIN chunks ch ON ch.id = b.chunk_id
        WHERE ${sql.join(filters, sql` AND `)}
        ORDER BY b.score DESC, i.id
        LIMIT ${p.limit}`)
      return res.rows
    })
    const tokens = queryTokens(normQuery)
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      shared: sharedFromProject,
      space: r.space,
      number: r.number,
      adrNumber: r.adr_number,
      title: r.title,
      type: r.type,
      status: r.status,
      lifecycle: r.lifecycle,
      revision: r.revision,
      provenance: r.provenance,
      confidence: r.confidence,
      decidedOn: r.decided_on,
      expiresAt: r.expires_at === null ? null : new Date(r.expires_at),
      pinned: r.pinned,
      score: Number(r.score),
      snippet: makeSnippet(r.chunk_text, tokens),
    }))
  }

  /** `SELECT spoor_unaccent($1)` then the sanitised tsquery text (empty = no FTS branch). */
  async tsQueryFor(normQuery: string): Promise<string> {
    if (normQuery === '') return ''
    const res = await this.deps.db.execute<{ u: string | null }>(
      sql`SELECT spoor_unaccent(${normQuery}) AS u`,
    )
    return buildTsQuery(res.rows[0]?.u ?? '')
  }

  /** Hybrid search over the project (and `_shared` when asked), section 4. Never bumps `last_used_at`. */
  async search(p: SearchParams): Promise<SearchResult> {
    const notes = new Set<string>()
    const normQuery = normalizeQuery(p.query)
    const project = await projectModels(this.deps.db, p.projectId)
    if (!project || normQuery === '') return { hits: [], notes: [] }
    const tsq = await this.tsQueryFor(normQuery)
    const own = await this.#searchScope(project, false, tsq, normQuery, p, notes)
    let shared: SearchHit[] = []
    if (p.includeShared && project.kind !== 'shared') {
      const s = await sharedProjectModels(this.deps.db)
      if (s) shared = await this.#searchScope(s, true, tsq, normQuery, p, notes)
    }
    return { hits: mergeScopes(own, shared, p.limit), notes: [...notes] }
  }
}

/** Re-export for callers that only need the check: is a candidate a duplicate at this threshold? */
export function firstDuplicate(result: DedupeResult, threshold: number): DedupeCandidate | undefined {
  return result.candidates.find((c) => c.cos >= threshold)
}

/** Items lacking chunks for the active model at their current revision (consistency sweep). */
export async function itemsMissingActiveChunks(db: DbOrTx, limit: number, projectId?: string) {
  const res = await db.execute<{ id: string; project_id: string; space: Space; revision: number }>(sql`
    SELECT i.id, i.project_id, i.space, i.revision
    FROM items i JOIN projects p ON p.id = i.project_id
    WHERE ${projectId ? sql`i.project_id = ${projectId}` : sql`true`}
      AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.item_id = i.id AND c.model = p.embedding_model
                        AND c.item_revision = i.revision)
    ORDER BY i.id LIMIT ${limit}`)
  return res.rows
}
