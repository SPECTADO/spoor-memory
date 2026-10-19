/** SQL fragments shared by search, dedupe, the digest and the jobs of the search module. */
import { type SQL, sql } from 'drizzle-orm'
import type { DbOrTx } from '../../lib/db.js'
import { assertSafeDims, assertSafeTag } from './providers/util.js'

/** `'<tag>'` inlined as a validated literal so the planner can match the tag's partial HNSW index. */
export function tagLiteral(tag: string): SQL {
  return sql.raw(`'${assertSafeTag(tag)}'`)
}

/** `vector(<dims>)` with validated dims. */
export function vectorType(dims: number): SQL {
  return sql.raw(`vector(${assertSafeDims(dims)})`)
}

/** pgvector text form of a vector. */
export function vectorLiteral(v: Float32Array | readonly number[]): string {
  return `[${Array.from(v).join(',')}]`
}

/** `(a, b, c)` for an IN list of parameters. */
export function inList(values: readonly string[]): SQL {
  return sql`(${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )})`
}

/** `ARRAY[$1, $2]::text[]` (an empty list gives `'{}'::text[]`). */
export function textArray(values: readonly string[]): SQL {
  if (values.length === 0) return sql`'{}'::text[]`
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`
}

/** Name of a model tag's partial HNSW index: `chunks_hnsw_` + the first 12 hex chars of md5(tag). */
export function hnswIndexNameSql(tag: string): SQL {
  return sql`'chunks_hnsw_' || left(md5(${tag}), 12)`
}

/**
 * Digest eligibility (search-and-digest.md section 7) over items aliased `i`: active (not stale or archived),
 * not superseded/deprecated, not an expired observation, `proposed` ADRs only when pinned, and decision
 * memories drafted into an ACCEPTED ADR are hidden (the ADR represents them).
 */
export const DIGEST_ELIGIBLE = sql.raw(`i.lifecycle = 'active'
  AND i.status NOT IN ('superseded','deprecated')
  AND (i.expires_at IS NULL OR i.expires_at > now())
  AND (i.space <> 'decisions' OR i.status <> 'proposed' OR i.pinned)
  AND NOT (i.type = 'decision' AND EXISTS (
    SELECT 1 FROM edges e JOIN items a ON a.id = e.src_id
    WHERE e.dst_id = i.id AND e.kind = 'drafted_from' AND a.status = 'accepted'))`)

export interface ProjectModels {
  id: string
  kind: 'project' | 'shared'
  slug: string
  model: string
  target: string | null
  settings: Record<string, unknown>
}

/** The project's active model tag and re-embed target. */
export async function projectModels(db: DbOrTx, projectId: string): Promise<ProjectModels | undefined> {
  const res = await db.execute<{
    id: string
    kind: 'project' | 'shared'
    slug: string
    embedding_model: string
    embedding_target: string | null
    settings: Record<string, unknown>
  }>(
    sql`SELECT id, kind, slug, embedding_model, embedding_target, settings FROM projects WHERE id = ${projectId}`,
  )
  const r = res.rows[0]
  return r
    ? {
        id: r.id,
        kind: r.kind,
        slug: r.slug,
        model: r.embedding_model,
        target: r.embedding_target,
        settings: r.settings,
      }
    : undefined
}

export async function sharedProjectModels(db: DbOrTx): Promise<ProjectModels | undefined> {
  const res = await db.execute<{ id: string }>(sql`SELECT id FROM projects WHERE kind = 'shared'`)
  const id = res.rows[0]?.id
  return id ? projectModels(db, id) : undefined
}
