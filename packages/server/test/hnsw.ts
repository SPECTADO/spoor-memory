/**
 * The HNSW indexes on `chunks` (one partial index per model tag, named 'chunks_hnsw_' || left(md5(tag), 12);
 * docs/design/data-model.md). Shared by test/global-setup.ts (main process) and test/db.ts (workers), so
 * no runtime import of vitest here.
 */
import { createHash } from 'node:crypto'
import type pg from 'pg'
import { LOCAL_TAG } from '../src/modules/search/providers/local.js'

/** The index 0002_triggers_and_hnsw.sql creates for the default model. */
export const DEFAULT_HNSW_INDEX = `chunks_hnsw_${createHash('md5').update(LOCAL_TAG).digest('hex').slice(0, 12)}`

declare module 'vitest' {
  export interface ProvidedContext {
    /** CREATE INDEX of the default model's HNSW index right after the migrations (null if they made none) */
    defaultHnswIndexDef: string | null
  }
}

export type HnswIndex = { name: string; def: string }

export async function listHnswIndexes(client: Pick<pg.Pool, 'query'>): Promise<HnswIndex[]> {
  const res = await client.query<HnswIndex>(
    `SELECT indexname AS name, indexdef AS def FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'chunks' AND indexname LIKE 'chunks\\_hnsw\\_%'
     ORDER BY indexname`,
  )
  return res.rows
}
