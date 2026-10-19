import { getTableName } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runMigrations } from './migrate.js'
import { TABLES } from './schema.js'

// Needs a real Postgres with pgvector (pgvector/pgvector:0.8.7-pg17). Skips cleanly without DATABASE_URL.
// DATABASE_MIGRATE_URL (superuser) is optional here; the test database is assumed to allow CREATE EXTENSION.
const url = process.env.DATABASE_URL

describe.skipIf(!url)('migrations against a real Postgres', () => {
  let client: pg.Client

  beforeAll(async () => {
    await runMigrations({ databaseUrl: url as string, migrateUrl: process.env.DATABASE_MIGRATE_URL ?? url })
    client = new pg.Client({ connectionString: url })
    await client.connect()
  })
  afterAll(async () => {
    await client?.end()
  })

  it('is idempotent (a second run is a no-op)', async () => {
    await runMigrations({ databaseUrl: url as string, migrateUrl: process.env.DATABASE_MIGRATE_URL ?? url })
  })

  it('creates the extensions', async () => {
    const res = await client.query<{ extname: string }>('SELECT extname FROM pg_extension')
    const names = res.rows.map((r) => r.extname)
    expect(names).toContain('vector')
    expect(names).toContain('unaccent')
  })

  it('creates every table of the schema', async () => {
    const res = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    )
    const have = new Set(res.rows.map((r) => r.table_name))
    const expected = Object.values(TABLES).map((t) => getTableName(t))
    expect(expected).toHaveLength(14)
    for (const t of expected) expect(have, t).toContain(t)
  })

  it('creates the hand-written objects', async () => {
    const trig = await client.query<{ tgname: string }>(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('item_revisions_append_only','audit_log_append_only','edges_scope')",
    )
    expect(trig.rows).toHaveLength(3)
    const idx = await client.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'chunks' AND indexname LIKE 'chunks_hnsw_%'",
    )
    expect(idx.rows).toHaveLength(1)
    expect(idx.rows[0]?.indexdef).toMatch(
      /USING hnsw .*vector_cosine_ops.*WHERE \(model = 'local:Xenova\/multilingual-e5-small@q8\/384'/s,
    )
    const un = await client.query<{ s: string }>("SELECT spoor_unaccent('Příliš žluťoučký kůň') AS s")
    expect(un.rows[0]?.s).toBe('Prilis zlutoucky kun')
  })

  it('keeps audit_log append-only, with the purge bypass for DELETE only', async () => {
    await client.query(
      "INSERT INTO audit_log (actor_label, via, action, summary) VALUES ('test','system','test.append_only','x')",
    )
    await expect(
      client.query("UPDATE audit_log SET summary = 'y' WHERE action = 'test.append_only'"),
    ).rejects.toThrow(/append-only/)
    await expect(client.query("DELETE FROM audit_log WHERE action = 'test.append_only'")).rejects.toThrow(
      /append-only/,
    )
    await client.query('BEGIN')
    await client.query("SET LOCAL spoor.allow_purge = 'on'")
    await client.query("DELETE FROM audit_log WHERE action = 'test.append_only'")
    await client.query('COMMIT')
  })

  it('accepts an untyped vector with a matching dims check and rejects a mismatch', async () => {
    await client.query('BEGIN')
    try {
      const p = await client.query<{ id: string }>(
        "INSERT INTO projects (kind, slug, name, embedding_model) VALUES ('project','it-test','T','m') RETURNING id",
      )
      const i = await client.query<{ id: string }>(
        `INSERT INTO items (project_id, space, number, slug, title, type, status, confidence, created_by_label, updated_by_label)
         VALUES ($1,'memories',1,'a','A','fact','active','medium','t','t') RETURNING id`,
        [p.rows[0]?.id],
      )
      const itemId = i.rows[0]?.id
      await client.query(
        `INSERT INTO chunks (item_id, project_id, space, ordinal, item_revision, text, model, dims, embedding)
         VALUES ($1,$2,'memories',0,1,'Příliš žluťoučký','other-model',3,'[1,2,3]')`,
        [itemId, p.rows[0]?.id],
      )
      const tsv = await client.query<{ hit: boolean }>(
        "SELECT tsv @@ to_tsquery('simple','prilis') AS hit FROM chunks WHERE item_id = $1",
        [itemId],
      )
      expect(tsv.rows[0]?.hit).toBe(true)
      await client.query('SAVEPOINT s')
      await expect(
        client.query(
          `INSERT INTO chunks (item_id, project_id, space, ordinal, item_revision, text, model, dims, embedding)
           VALUES ($1,$2,'memories',1,1,'x','other-model',4,'[1,2,3]')`,
          [itemId, p.rows[0]?.id],
        ),
      ).rejects.toThrow(/chunks_embedding_dims_check/)
    } finally {
      await client.query('ROLLBACK')
    }
  })
})
