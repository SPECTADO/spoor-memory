import { readFileSync } from 'node:fs'
import { getTableName } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrationNoticeLogger, runMigrations } from './migrate.js'
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

  it('is idempotent (a second run is a no-op, and logs no "already exists" notices)', async () => {
    const logged: string[] = []
    await runMigrations({
      databaseUrl: url as string,
      migrateUrl: process.env.DATABASE_MIGRATE_URL ?? url,
      log: (m) => logged.push(m),
    })
    expect(logged).toContain('migrations ok')
    expect(logged.filter((m) => m.startsWith('migration notice:'))).toEqual([])
  })

  it('forwards a RAISE NOTICE shaped like the 0004 backfill count to the log (the backfill itself is tested below)', async () => {
    const logged: string[] = []
    const onNotice = migrationNoticeLogger((m) => logged.push(m))
    client.on('notice', onNotice)
    try {
      await client.query('CREATE SCHEMA IF NOT EXISTS public')
      await client.query("DO $$ BEGIN RAISE NOTICE 'library_guards: 0 item slug(s) renamed'; END $$")
    } finally {
      client.off('notice', onNotice)
    }
    expect(logged).toEqual(['migration notice: library_guards: 0 item slug(s) renamed'])
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
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('item_revisions_append_only','audit_log_append_only','edges_scope','item_revisions_library_guard')",
    )
    expect(trig.rows).toHaveLength(4)
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

  // ---- library space (0003 generated, 0004 hand-written; ADR-0014) ----------------------------------

  describe('library space', () => {
    type Space = 'memories' | 'decisions' | 'docs' | 'library'
    let seq = 0

    /** Run `fn` in a transaction that is always rolled back. */
    async function inTx(fn: () => Promise<void>): Promise<void> {
      await client.query('BEGIN')
      try {
        await fn()
      } finally {
        await client.query('ROLLBACK')
      }
    }

    /** The statement fails with SQLSTATE `code` (and names `constraint` when given); the transaction goes on. */
    async function fails(text: string, params: unknown[], code: string, constraint?: string): Promise<void> {
      await client.query('SAVEPOINT expect_fail')
      let err: { code?: string; constraint?: string } | undefined
      try {
        await client.query(text, params)
      } catch (e) {
        err = e as { code?: string; constraint?: string }
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT expect_fail')
      }
      expect(err, `expected ${code}: ${text}`).toBeDefined()
      expect(err?.code).toBe(code)
      if (constraint) expect(err?.constraint).toBe(constraint)
    }

    async function project(): Promise<string> {
      const r = await client.query<{ id: string }>(
        "INSERT INTO projects (kind, slug, name, embedding_model) VALUES ('project',$1,'T','m') RETURNING id",
        [`lib-it-${++seq}`],
      )
      return r.rows[0]?.id as string
    }

    interface ItemCols {
      slug?: string
      body?: string
      pinned?: boolean
      sourcePath?: string | null
      provenance?: 'human' | 'agent'
      lifecycle?: 'active' | 'stale' | 'archived'
      status?: string
    }

    function itemInsert(projectId: string, space: string, o: ItemCols = {}): [string, unknown[]] {
      const n = ++seq
      const lifecycle = o.lifecycle ?? 'active'
      return [
        `INSERT INTO items (project_id, space, number, adr_number, slug, title, type, status, confidence, body,
           pinned, source_path, provenance, lifecycle, stale_since, archived_at, archive_reason,
           created_by_label, updated_by_label)
         VALUES ($1,$2,$3,$4,$5,'T',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'t','t') RETURNING id`,
        [
          projectId,
          space,
          n,
          space === 'decisions' ? n : null,
          o.slug ?? `item-${n}`,
          space === 'memories' ? 'fact' : null,
          o.status ?? (space === 'decisions' ? 'proposed' : 'active'),
          space === 'memories' ? 'medium' : null,
          o.body ?? '',
          o.pinned ?? false,
          o.sourcePath ?? null,
          o.provenance ?? 'human',
          lifecycle,
          lifecycle === 'stale' ? new Date() : null,
          lifecycle === 'archived' ? new Date() : null,
          lifecycle === 'archived' ? 'manual' : null,
        ],
      ]
    }

    async function item(projectId: string, space: Space, o: ItemCols = {}): Promise<string> {
      const [text, params] = itemInsert(projectId, space, o)
      const r = await client.query<{ id: string }>(text, params)
      return r.rows[0]?.id as string
    }

    const edgeSql = 'INSERT INTO edges (project_id, src_id, kind, dst_ref, dst_id) VALUES ($1,$2,$3,$4,$5)'
    const edge = (p: string, src: string, kind: string, dst: string | null, ref = dst ?? 'x') =>
      client.query(edgeSql, [p, src, kind, ref, dst])

    const revisionSql = `INSERT INTO item_revisions (item_id, revision, title, body, status, frontmatter, change, actor_label, via)
       VALUES ($1,2,'T','','active','{}','update','t',$2)`

    it('the space check accepts library and rejects anything else', async () => {
      await inTx(async () => {
        const p = await project()
        await item(p, 'library')
        const [text, params] = itemInsert(p, 'wiki')
        await fails(text, params, '23514', 'items_space_check')
      })
    })

    it('memberships.library_editor defaults to false', async () => {
      await inTx(async () => {
        const p = await project()
        const u = await client.query<{ id: string }>(
          "INSERT INTO users (email, name, password_hash) VALUES ($1,'U','x') RETURNING id",
          [`lib-it-${++seq}@example.com`],
        )
        await client.query("INSERT INTO memberships (project_id, user_id, role) VALUES ($1,$2,'viewer')", [
          p,
          u.rows[0]?.id,
        ])
        const r = await client.query<{ library_editor: boolean }>(
          'SELECT library_editor FROM memberships WHERE project_id = $1',
          [p],
        )
        expect(r.rows).toEqual([{ library_editor: false }])
      })
    })

    it('the shape check keeps library rows human, unmirrored, unpinned, never stale and active', async () => {
      await inTx(async () => {
        const p = await project()
        await item(p, 'library')
        await item(p, 'library', { lifecycle: 'archived' })
        for (const bad of [
          { pinned: true },
          { sourcePath: 'docs/guide.md' },
          { provenance: 'agent' as const },
          { lifecycle: 'stale' as const },
          { status: 'superseded' },
        ]) {
          const [text, params] = itemInsert(p, 'library', bad)
          await fails(text, params, '23514', 'items_library_shape_check')
        }
        // the same values stay legal outside the library
        await item(p, 'docs', { pinned: true, sourcePath: 'docs/guide.md', provenance: 'agent' })
      })
    })

    it('SPL01: conflicts_with between library and non-library, supersedes/drafted_from into library', async () => {
      await inTx(async () => {
        const p = await project()
        const lib = await item(p, 'library')
        const lib2 = await item(p, 'library')
        const doc = await item(p, 'docs')
        const mem = await item(p, 'memories')
        const dec = await item(p, 'decisions')
        await fails(edgeSql, [p, lib, 'conflicts_with', doc, doc], 'SPL01')
        await fails(edgeSql, [p, doc, 'conflicts_with', lib, lib], 'SPL01')
        await fails(edgeSql, [p, doc, 'supersedes', lib, lib], 'SPL01')
        await fails(edgeSql, [p, dec, 'drafted_from', lib, lib], 'SPL01')
        // allowed: outgoing library links of the other kinds go anywhere (owner amendment), inbound links too
        for (const kind of ['wikilink', 'refines', 'supports', 'depends_on']) {
          await edge(p, lib, kind, doc)
          await edge(p, mem, kind, lib)
        }
        await edge(p, lib, 'conflicts_with', lib2)
        await edge(p, lib, 'supersedes', lib2)
        // the human save path re-resolves a dangling library link by updating dst_id: allowed
        await edge(p, lib, 'wikilink', null, 'later-doc')
        await client.query("UPDATE edges SET dst_id = $1 WHERE src_id = $2 AND dst_ref = 'later-doc'", [
          mem,
          lib,
        ])
        // an UPDATE onto a refused target is refused too
        await edge(p, doc, 'conflicts_with', null, 'dangling')
        await fails(
          "UPDATE edges SET dst_id = $1 WHERE src_id = $2 AND dst_ref = 'dangling'",
          [lib, doc],
          'SPL01',
        )
      })
    })

    it('SPL02: a library revision through mcp or cli is refused', async () => {
      await inTx(async () => {
        const p = await project()
        const lib = await item(p, 'library')
        const mem = await item(p, 'memories')
        await fails(revisionSql, [lib, 'mcp'], 'SPL02')
        await fails(revisionSql, [lib, 'cli'], 'SPL02')
        await client.query(revisionSql, [lib, 'web'])
        await client.query(revisionSql, [mem, 'mcp'])
      })
    })

    it('the 0004 backfill renames l<n> slugs to x-l<n> and rewrites the refs that point at them', async () => {
      const file = readFileSync(new URL('./migrations/0004_library_guards.sql', import.meta.url), 'utf8')
      const backfill = file.split('--> statement-breakpoint').find((s) => s.includes('DO $$'))
      expect(backfill).toBeDefined()
      const notices: string[] = []
      const onNotice = (n: { message?: string }) => notices.push(n.message ?? '')
      client.on('notice', onNotice)
      try {
        await inTx(async () => {
          // the test database is empty apart from these rows (test/setup.ts truncates before each test)
          const p = await project()
          const l7 = await item(p, 'docs', { slug: 'l7' })
          const l8 = await item(p, 'docs', { slug: 'l8' })
          await item(p, 'docs', { slug: 'x-l8' }) // takes the new name: l8 stays
          await item(p, 'memories', { slug: 'l9' }) // other space, no conflict there
          const src = await item(p, 'memories', { body: 'see [[l7]] and [[L8|eight]]' })
          await edge(p, src, 'wikilink', l7, 'l7')
          await edge(p, src, 'wikilink', l8, 'l8')
          await edge(p, src, 'refines', l7, l7)
          await client.query(backfill as string)
          const slugs = await client.query<{ slug: string }>(
            'SELECT slug FROM items WHERE project_id = $1 ORDER BY slug',
            [p],
          )
          expect(slugs.rows.map((r) => r.slug).filter((s) => s.startsWith('x-') || /^l\d/.test(s))).toEqual([
            'l8',
            'x-l7',
            'x-l8',
            'x-l9',
          ])
          const refs = await client.query<{ kind: string; dst_ref: string; dst_id: string }>(
            'SELECT kind, dst_ref, dst_id FROM edges WHERE src_id = $1 ORDER BY kind, dst_ref',
            [src],
          )
          expect(refs.rows).toEqual([
            { kind: 'refines', dst_ref: l7, dst_id: l7 },
            { kind: 'wikilink', dst_ref: 'l8', dst_id: l8 },
            { kind: 'wikilink', dst_ref: 'x-l7', dst_id: l7 },
          ])
        })
      } finally {
        client.off('notice', onNotice)
      }
      expect(notices.join('\n')).toMatch(/2 item slug\(s\) l<n> renamed.*; 1 not renamed.*; 1 item body/)
    })
  })
})
