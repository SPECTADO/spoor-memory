/**
 * Related-item candidates (ADR-0022, contract of `GET …/items/:ref/related`): the probe item's chunk vectors
 * under its project's active model against every chunk of the same model tag in the project (and `_shared`
 * when its active model is the same), score = best (probe chunk, candidate chunk) cosine. Computed on demand
 * from the stored embeddings; nothing is written, no provider is called.
 */
import { sql } from 'drizzle-orm'
import type { DbOrTx } from '../../lib/db.js'
import type { EmbeddingRegistry, RelatedQuery, RelatedResult } from '../../ports.js'
import { dimsOfTag } from './providers/util.js'
import {
  projectModels,
  sharedProjectModels,
  tagLiteral,
  textArray,
  vectorLiteral,
  vectorType,
} from './sql.js'

/*
 * The ranking is approximate, by design (bounded cost, nothing precomputed):
 * - probe = up to RELATED_PROBE_MAX (32) chunks of the item, the first by ordinal, under the active model;
 * - per probe chunk, the K = relatedKnn(limit) nearest ELIGIBLE chunks are fetched (HNSW with iterative scan
 *   where the model tag has its partial index, an exact scan otherwise). Eligible = same model tag, in scope,
 *   not the probe item, not linked to it, not in excludeIds, not archived/superseded/deprecated/expired, so
 *   excluded items never take a slot and the scan keeps going past them;
 * - each candidate item scores its best (max) cosine over those (probe chunk, candidate chunk) pairs;
 *   then the floor and `limit` apply.
 * Beyond HNSW recall, an eligible item is missed only when, for every probe chunk, at least K chunks of other
 * eligible items are nearer than all of its own (e.g. an unlinked long doc with more than K near chunks).
 */

/** Minimum K: nearest eligible chunks fetched per probe chunk, whatever the limit. */
export const RELATED_KNN = 100
/** K grows with the requested limit: K = max(RELATED_KNN, limit × RELATED_KNN_PER_RESULT) (100 to 400). */
export const RELATED_KNN_PER_RESULT = 20
/** Probe chunks used at most (the first by ordinal); bounds the cost of long docs. */
export const RELATED_PROBE_MAX = 32

/** Nearest eligible chunks fetched per probe chunk for a request of `limit` items. */
export function relatedKnn(limit: number): number {
  return Math.max(RELATED_KNN, limit * RELATED_KNN_PER_RESULT)
}

const PENDING: RelatedResult = { candidates: [], pending: true }

export async function relatedCandidates(
  registry: EmbeddingRegistry,
  db: DbOrTx,
  q: RelatedQuery,
): Promise<RelatedResult> {
  const p = await projectModels(db, q.projectId)
  if (!p) return PENDING
  const dims = registry.byTag(p.model)?.dims ?? dimsOfTag(p.model)
  if (!dims) return PENDING
  const tag = tagLiteral(p.model)
  const vt = vectorType(dims)

  let probe: string[]
  if (q.chunks) {
    probe = q.chunks
      .filter((c) => c.model === p.model && c.embedding !== null)
      .sort((a, b) => a.ordinal - b.ordinal)
      .slice(0, RELATED_PROBE_MAX)
      .map((c) => vectorLiteral(c.embedding as Float32Array))
  } else {
    const res = await db.execute<{ v: string }>(sql`
      SELECT c.embedding::text AS v FROM chunks c
      WHERE c.item_id = ${q.itemId} AND c.model = ${tag} AND c.embedding IS NOT NULL
      ORDER BY c.ordinal LIMIT ${RELATED_PROBE_MAX}`)
    probe = res.rows.map((r) => r.v)
  }
  if (probe.length === 0) return PENDING

  const scopes = [p.id]
  if (q.includeShared && p.kind !== 'shared') {
    const s = await sharedProjectModels(db)
    if (s && s.model === p.model) scopes.push(s.id)
  }

  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL hnsw.ef_search = 100`)
    await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`)
    const res = await tx.execute<{ id: string; cos: number }>(sql`
      WITH probe AS (SELECT v::${vt} AS v FROM unnest(${textArray(probe)}) AS v),
      linked AS (
        SELECT e.dst_id AS id FROM edges e WHERE e.src_id = ${q.itemId} AND e.dst_id IS NOT NULL
        UNION SELECT e.src_id FROM edges e WHERE e.dst_id = ${q.itemId}
      ),
      hits AS (
        SELECT k.item_id, max(1 - k.dist) AS cos
        FROM probe p CROSS JOIN LATERAL (
          SELECT c.item_id, c.embedding::${vt} <=> p.v AS dist
          FROM chunks c JOIN items i ON i.id = c.item_id
          WHERE c.project_id IN (${sql.join(
            scopes.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}) AND c.model = ${tag} AND c.embedding IS NOT NULL AND c.item_id <> ${q.itemId}
            AND c.item_id NOT IN (SELECT id FROM linked)
            AND c.item_id::text <> ALL(${textArray(q.excludeIds ?? [])})
            AND i.lifecycle <> 'archived' AND i.status NOT IN ('superseded','deprecated')
            AND (i.expires_at IS NULL OR i.expires_at > now())
          ORDER BY c.embedding::${vt} <=> p.v
          LIMIT ${relatedKnn(q.limit)}
        ) k
        GROUP BY k.item_id
      )
      SELECT i.id, h.cos::float8 AS cos
      FROM hits h JOIN items i ON i.id = h.item_id
      WHERE h.cos >= ${q.minCos}
      ORDER BY h.cos DESC, i.updated_at DESC, i.id
      LIMIT ${q.limit}`)
    return res.rows
  })
  return { candidates: rows.map((r) => ({ id: r.id, cos: Number(r.cos) })), pending: false }
}
