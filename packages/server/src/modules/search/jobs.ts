/**
 * Background work of the search module, exposed for the jobs module (scheduler, leases, job_runs) to run
 * (docs/design/search-and-digest.md section 3, cleanup-and-jobs.md section 4):
 * - `embedPending`: fill `chunks.embedding IS NULL` for tags a provider in this image serves, 64 per batch;
 * - `reembed`: per project with `embedding_target`: create the target's partial HNSW index, re-chunk/embed
 *   items 16 at a time, cut over under `FOR UPDATE`, delete old-model chunks, drop unused indexes. Projects
 *   whose ACTIVE tag has no provider (default-model upgrade, FTS-only per I36) go first;
 * - `syncEmbeddingTargets`: at startup, a project whose provider's tag differs from its active model gets
 *   `embedding_target` (e.g. the image's default model was upgraded);
 * - `consistencySweep`: items with no chunk for the active model at their current revision are re-chunked
 *   (at most 200 per run), for the hourly cleanup job.
 * Every step is idempotent and can be re-run after a crash.
 */
import { sql } from 'drizzle-orm'
import { chunks as chunksTable } from '../../db/schema.js'
import { lockProjectForWrite, withTx } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import {
  type BatchContext,
  type EmbeddingProvider,
  JobError,
  type JobStats,
  LeaseLostError,
  type Space,
} from '../../ports.js'
import { resolveSettings } from '../projects/index.js'
import { chunkItem } from './chunker.js'
import { assertSafeDims, assertSafeTag, withTimeout } from './providers/util.js'
import { EMBED_TIMEOUT_MS, itemsMissingActiveChunks, type SearchService } from './service.js'
import { tagLiteral, vectorLiteral, vectorType } from './sql.js'

/**
 * The scheduler's `BatchContext` (src/ports.ts), every part optional so the functions also run on their own
 * (tests, a one-off call): no signal, a 4-minute deadline from the start, no lease.
 */
export type JobContext = Partial<BatchContext>

const DEFAULT_DEADLINE_MS = 4 * 60_000
const PENDING_BATCH = 64
const REEMBED_BATCH = 16
const DELETE_BATCH = 1000
const SWEEP_MAX = 200

class Stop extends Error {
  constructor(
    readonly why: 'aborted' | 'deadline' | 'lease',
    readonly lost?: LeaseLostError,
  ) {
    super(why)
  }
}

function guard(ctx: JobContext, started: number): void {
  if (ctx.signal?.aborted) throw new Stop('aborted')
  if (Date.now() > (ctx.deadline ?? started + DEFAULT_DEADLINE_MS)) throw new Stop('deadline')
}

async function renew(ctx: JobContext): Promise<void> {
  try {
    await ctx.renewLease?.()
  } catch (err) {
    if (err instanceof LeaseLostError) throw new Stop('lease', err)
    throw err
  }
}

/**
 * The end of a run stopped early: the deadline returns the stats (the next run continues); an abort
 * (shutdown) or a lost lease ends the run as an error that still carries the stats gathered so far.
 */
function stopped<S extends JobStats>(err: unknown, ctx: JobContext, stats: S): S {
  if (!(err instanceof Stop)) throw err
  if (err.why === 'deadline') return stats
  if (err.why === 'lease') throw new JobError((err.lost as LeaseLostError).message, stats)
  const reason: unknown = ctx.signal?.reason
  throw new JobError(reason instanceof Error ? reason.message : 'aborted', stats)
}

// ---- embed-pending ----------------------------------------------------------------------------------------

/** Fill NULL embeddings, 64 per batch, until none are left, the deadline, or abort. */
export async function embedPending(deps: ServerDeps, ctx: JobContext = {}): Promise<JobStats> {
  const started = Date.now()
  const stats = { embedded: 0, batches: 0, failed: 0, skipped_tags: [] as string[] }
  const tags = await deps.db.execute<{ model: string }>(
    sql`SELECT DISTINCT model FROM chunks WHERE embedding IS NULL ORDER BY model`,
  )
  try {
    for (const { model } of tags.rows) {
      const provider = deps.ports.embeddings.byTag(model)
      if (!provider) {
        stats.skipped_tags.push(model) // no provider in this image (FTS-only until cut-over)
        continue
      }
      let lastId = 0
      for (;;) {
        guard(ctx, started)
        const batch = await deps.db.execute<{ id: string | number; text: string }>(sql`
          SELECT id, text FROM chunks
          WHERE embedding IS NULL AND model = ${model} AND dims = ${provider.dims} AND id > ${lastId}
          ORDER BY id LIMIT ${PENDING_BATCH}`)
        if (batch.rows.length === 0) break
        lastId = Number(batch.rows[batch.rows.length - 1]?.id)
        let vectors: Float32Array[]
        try {
          await withTimeout(provider.ready(), EMBED_TIMEOUT_MS)
          vectors = await withTimeout(provider.embedPassages(batch.rows.map((r) => r.text)), EMBED_TIMEOUT_MS)
        } catch (err) {
          stats.failed += batch.rows.length
          deps.logger.warn({ tag: model, err: (err as Error).message }, 'embed-pending batch failed')
          break // next tag; this one is retried next minute
        }
        const ids = batch.rows.map((r) => String(r.id))
        const vecs = vectors.map((v) => vectorLiteral(v))
        const res = await deps.db.execute(sql`
          UPDATE chunks c SET embedding = v.e::vector
          FROM (SELECT unnest(${`{${ids.join(',')}}`}::bigint[]) AS id, unnest(${pgTextArray(vecs)}::text[]) AS e) v
          WHERE c.id = v.id AND c.embedding IS NULL`)
        stats.embedded += res.rowCount ?? 0
        stats.batches++
        await renew(ctx)
      }
    }
  } catch (err) {
    return stopped(err, ctx, stats)
  }
  return stats
}

/** A Postgres text[] literal of vector strings (they contain only digits, `.`, `-`, `e`, `,`, brackets). */
function pgTextArray(values: string[]): string {
  return `{${values.map((v) => `"${v}"`).join(',')}}`
}

// ---- HNSW index management ----------------------------------------------------------------------------

/** Create the tag's partial expression HNSW index if missing; an invalid leftover is dropped and recreated. */
export async function ensureHnswIndex(deps: ServerDeps, tag: string, dims: number): Promise<string> {
  assertSafeTag(tag)
  assertSafeDims(dims)
  const nameRes = await deps.db.execute<{ name: string }>(
    sql`SELECT 'chunks_hnsw_' || left(md5(${tag}), 12) AS name`,
  )
  const name = nameRes.rows[0]?.name as string
  const state = await deps.db.execute<{ valid: boolean }>(sql`
    SELECT ix.indisvalid AS valid FROM pg_class c JOIN pg_index ix ON ix.indexrelid = c.oid
    WHERE c.relname = ${name} AND c.relkind = 'i'`)
  const existing = state.rows[0]
  if (existing?.valid) return name
  if (existing && !existing.valid)
    await deps.db.execute(sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`))
  // CONCURRENTLY cannot run inside a transaction: a single autocommit statement on the pool
  await deps.db.execute(
    sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${sql.raw(`"${name}"`)} ON chunks USING hnsw ((embedding::${vectorType(dims)}) vector_cosine_ops) WITH (m = 16, ef_construction = 64) WHERE model = ${tagLiteral(tag)}`,
  )
  return name
}

export async function dropHnswIndexIfUnused(deps: ServerDeps, tag: string): Promise<boolean> {
  assertSafeTag(tag)
  const used = await deps.db.execute(
    sql`SELECT 1 FROM projects WHERE embedding_model = ${tag} OR embedding_target = ${tag} LIMIT 1`,
  )
  if (used.rows.length > 0) return false
  const nameRes = await deps.db.execute<{ name: string }>(
    sql`SELECT 'chunks_hnsw_' || left(md5(${tag}), 12) AS name`,
  )
  const name = nameRes.rows[0]?.name as string
  await deps.db.execute(sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`))
  return true
}

// ---- re-embed -----------------------------------------------------------------------------------------

type ItemContent = {
  id: string
  project_id: string
  space: Space
  revision: number
  title: string
  tags: string[]
  body: string
}

/** Re-chunk and embed one item for `tag` and replace its `tag` chunks, unless the item changed meanwhile. */
async function rebuildItemChunks(
  deps: ServerDeps,
  provider: EmbeddingProvider,
  item: ItemContent,
): Promise<'done' | 'changed' | 'pending'> {
  const texts = chunkItem({ title: item.title, tags: item.tags, body: item.body }, provider)
  let vectors: (Float32Array | null)[] = texts.map(() => null)
  try {
    vectors = await withTimeout(provider.embedPassages(texts), EMBED_TIMEOUT_MS)
  } catch (err) {
    deps.logger.warn(
      { tag: provider.tag, err: (err as Error).message },
      're-embed: embedding failed, stored as pending',
    )
  }
  return withTx(deps.db, async (tx) => {
    const cur = await tx.execute<{ revision: number }>(
      sql`SELECT revision FROM items WHERE id = ${item.id} FOR UPDATE`,
    )
    if (cur.rows[0]?.revision !== item.revision) return 'changed' as const
    await tx.execute(sql`DELETE FROM chunks WHERE item_id = ${item.id} AND model = ${provider.tag}`)
    await tx.insert(chunksTable).values(
      texts.map((text, ordinal) => ({
        itemId: item.id,
        projectId: item.project_id,
        space: item.space,
        ordinal,
        itemRevision: item.revision,
        text,
        model: provider.tag,
        dims: provider.dims,
        embedding: vectors[ordinal] ? Array.from(vectors[ordinal] as Float32Array) : null,
      })),
    )
    return vectors.some((v) => v === null) ? ('pending' as const) : ('done' as const)
  })
}

/** Delete chunks of models that are neither the project's active nor its target model, 1000 per statement. */
async function deleteOldChunks(deps: ServerDeps, projectId: string, ctx: JobContext, started: number) {
  const removed = new Set<string>()
  let deleted = 0
  for (;;) {
    guard(ctx, started)
    const res = await deps.db.execute<{ model: string }>(sql`
      DELETE FROM chunks WHERE id IN (
        SELECT c.id FROM chunks c JOIN projects p ON p.id = c.project_id
        WHERE c.project_id = ${projectId} AND c.model <> p.embedding_model
          AND c.model IS DISTINCT FROM p.embedding_target
        LIMIT ${DELETE_BATCH})
      RETURNING model`)
    for (const r of res.rows) removed.add(r.model)
    deleted += res.rows.length
    if (res.rows.length < DELETE_BATCH) break
  }
  return { deleted, models: [...removed] }
}

/**
 * One run of the `reembed` job over every project with a target (and every project with leftover old-model
 * chunks). Returns stats incl. `remaining` (items still without target chunks).
 */
export async function reembed(deps: ServerDeps, ctx: JobContext = {}): Promise<JobStats> {
  const started = Date.now()
  const registry = deps.ports.embeddings
  const stats = {
    projects: 0,
    items: 0,
    changed: 0,
    pending: 0,
    cutovers: 0,
    deleted: 0,
    remaining: 0,
    no_provider: 0,
  }
  const projects = await deps.db.execute<{
    id: string
    embedding_model: string
    embedding_target: string | null
  }>(sql`
    SELECT id, embedding_model, embedding_target FROM projects p
    WHERE embedding_target IS NOT NULL
       OR EXISTS (SELECT 1 FROM chunks c WHERE c.project_id = p.id AND c.model <> p.embedding_model LIMIT 1)
    ORDER BY id`)
  // default-model upgrades (active tag without a provider) first
  const ordered = [...projects.rows].sort(
    (a, b) =>
      Number(registry.byTag(a.embedding_model) !== undefined) -
      Number(registry.byTag(b.embedding_model) !== undefined),
  )
  const droppedTags = new Set<string>()
  try {
    for (const p of ordered) {
      guard(ctx, started)
      stats.projects++
      if (p.embedding_target) {
        const target = p.embedding_target
        const provider = registry.byTag(target)
        if (!provider) {
          stats.no_provider++
          deps.logger.warn({ project: p.id, target }, 're-embed: no provider for the target tag')
          continue
        }
        try {
          await withTimeout(provider.ready(), EMBED_TIMEOUT_MS)
        } catch (err) {
          stats.no_provider++
          deps.logger.warn(
            { project: p.id, target, err: (err as Error).message },
            're-embed: provider not ready',
          )
          continue
        }
        // 1. the target's HNSW index
        await ensureHnswIndex(deps, target, provider.dims)
        // 2. items without current target chunks, 16 at a time
        let more = true
        while (more) {
          guard(ctx, started)
          const batch = await deps.db.execute<ItemContent>(sql`
            SELECT i.id, i.project_id, i.space, i.revision, i.title, i.tags, i.body FROM items i
            WHERE i.project_id = ${p.id} AND NOT EXISTS (
              SELECT 1 FROM chunks c WHERE c.item_id = i.id AND c.model = ${target} AND c.item_revision = i.revision)
            ORDER BY i.id LIMIT ${REEMBED_BATCH}`)
          for (const item of batch.rows) {
            const r = await rebuildItemChunks(deps, provider, item)
            if (r === 'changed') stats.changed++
            else stats.items++
            if (r === 'pending') stats.pending++
          }
          // an item written meanwhile got target chunks from its own write (the model set includes the target)
          more = batch.rows.length === REEMBED_BATCH
          if (batch.rows.length > 0) await renew(ctx)
        }
        // 3. cut over, re-checked under FOR UPDATE
        const cut = await withTx(deps.db, async (tx) => {
          const cur = await tx.execute<{ embedding_target: string | null }>(
            sql`SELECT embedding_target FROM projects WHERE id = ${p.id} FOR UPDATE`,
          )
          if (cur.rows[0]?.embedding_target !== target) return { done: false, remaining: 0 }
          const missing = await tx.execute<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM items i WHERE i.project_id = ${p.id} AND NOT EXISTS (
              SELECT 1 FROM chunks c WHERE c.item_id = i.id AND c.model = ${target} AND c.item_revision = i.revision)`)
          const nulls = await tx.execute(sql`
            SELECT 1 FROM chunks WHERE project_id = ${p.id} AND model = ${target} AND embedding IS NULL LIMIT 1`)
          const remaining = missing.rows[0]?.n ?? 0
          if (remaining > 0 || nulls.rows.length > 0) return { done: false, remaining }
          await tx.execute(
            sql`UPDATE projects SET embedding_model = ${target}, embedding_target = NULL WHERE id = ${p.id}`,
          )
          return { done: true, remaining: 0 }
        })
        stats.remaining += cut.remaining
        if (!cut.done) continue // NULL target chunks: embed-pending fills them, the cut-over retries next run
        stats.cutovers++
      }
      // 4. old-model chunks, then indexes no project uses any more
      const del = await deleteOldChunks(deps, p.id, ctx, started)
      stats.deleted += del.deleted
      for (const tag of [...del.models, ...(p.embedding_target ? [p.embedding_model] : [])]) {
        if (droppedTags.has(tag)) continue
        droppedTags.add(tag)
        try {
          await dropHnswIndexIfUnused(deps, tag)
        } catch (err) {
          deps.logger.warn({ tag, err: (err as Error).message }, 're-embed: could not drop an old index')
        }
      }
    }
  } catch (err) {
    return stopped(err, ctx, stats)
  }
  return stats
}

// ---- startup and consistency ------------------------------------------------------------------------------

/**
 * Startup (deployment step 7): every project whose configured provider's tag differs from its active model
 * gets that tag as `embedding_target` (unless already set to it). Returns the project ids that changed.
 */
export async function syncEmbeddingTargets(deps: ServerDeps): Promise<string[]> {
  const rows = await deps.db.execute<{
    id: string
    embedding_model: string
    embedding_target: string | null
    settings: Record<string, unknown>
  }>(sql`SELECT id, embedding_model, embedding_target, settings FROM projects ORDER BY id`)
  const changed: string[] = []
  for (const r of rows.rows) {
    const provider = deps.ports.embeddings.byName(resolveSettings(r.settings).embedding.provider)
    if (!provider) {
      // e.g. a remote provider whose key is gone: never re-embed a project to another provider silently
      deps.logger.warn({ project: r.id }, 'project names an embedding provider this instance does not enable')
      continue
    }
    const tag = provider.tag
    const target = tag === r.embedding_model ? null : tag
    if (target === r.embedding_target) continue
    // only ever SET a target here; clearing one is the settings PATCH's job
    if (target === null) continue
    await deps.db.execute(sql`UPDATE projects SET embedding_target = ${target} WHERE id = ${r.id}`)
    changed.push(r.id)
  }
  return changed
}

/**
 * Hourly sweep (inside the cleanup job): items with no chunk for the active model at their current revision
 * are re-chunked, at most 200. A non-zero count is logged as a warning (nothing should match).
 */
export async function consistencySweep(
  deps: ServerDeps,
  search: SearchService,
  ctx: JobContext = {},
): Promise<{ rechunked: number }> {
  const started = Date.now()
  const items = await itemsMissingActiveChunks(deps.db, SWEEP_MAX)
  const stats = { rechunked: 0 }
  try {
    for (const it of items) {
      // each item can take an embedding call of up to 20 s: honour shutdown, the budget and the lease
      // between items, like every other batch job (review C7)
      guard(ctx, started)
      const content = await deps.db.execute<{ title: string; tags: string[]; body: string }>(
        sql`SELECT title, tags, body FROM items WHERE id = ${it.id}`,
      )
      const c = content.rows[0]
      if (!c) continue
      const prepared = await search.prepareChunks({
        projectId: it.project_id,
        space: it.space,
        title: c.title,
        tags: c.tags,
        body: c.body,
      })
      const ok = await withTx(deps.db, async (tx) => {
        await lockProjectForWrite(tx, it.project_id) // project row before the item row (lock order)
        const cur = await tx.execute<{ revision: number }>(
          sql`SELECT revision FROM items WHERE id = ${it.id} FOR UPDATE`,
        )
        if (cur.rows[0]?.revision !== it.revision) return false
        await search.indexItemChunks(
          tx,
          { id: it.id, projectId: it.project_id, space: it.space, revision: it.revision },
          prepared,
        )
        return true
      })
      if (ok) stats.rechunked++
      await renew(ctx)
    }
  } catch (err) {
    stopped(err, ctx, stats)
  }
  const { rechunked } = stats
  if (rechunked > 0) deps.logger.warn({ rechunked }, 'consistency sweep re-chunked items')
  return { rechunked }
}
