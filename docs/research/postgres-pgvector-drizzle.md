# Research: Postgres 17 + pgvector + Drizzle

Date: 2026-10-19. Everything marked TESTED was run against `pgvector/pgvector:pg17` (arm64, Docker 29.8.1) with psql, or via drizzle-kit/drizzle-orm/pg in a scratch project.

## 1. Versions (release-age rule: published <= 2026-10-16)

| Package | Version | Released | Note |
|---|---|---|---|
| drizzle-orm | 0.45.4 (`latest`) | 2026-10-08 | stable line; peer `pg >=8`, `postgres >=3` |
| drizzle-kit | 0.31.11 (`latest`) | 2026-09-21 | pairs with orm 0.45.x |
| pg | 8.23.1 | 2026-09-30 | node-postgres |
| @types/pg | 8.23.1 | 2026-08-17 | |
| postgres (postgres.js) | 3.4.9 | 2026-04-05 | alternative, not chosen |

Source: `npm view <pkg> time --json`, `npm view <pkg> dist-tags`.
- drizzle 1.0 exists only as `1.0.0-rc.5` (orm+kit 2026-09-09, `rc` tag points at rc.4). Not stable; do not use for MVP. Revisit later (migrations folder format changes in v1).
- Docker image `pgvector/pgvector:pg17` EXISTS on Docker Hub (https://hub.docker.com/r/pgvector/pgvector/tags). Tag list (Hub API): `pg17`, `pg17-bookworm`, `pg17-trixie`, `0.8.7-pg17`, `0.8.7-pg17-bookworm`, `0.8.7-pg17-trixie`, `0.8.6-pg17...`. `pg17` updated 2026-10-01 digest `sha256:ac08538c...`.
- Contents TESTED: PostgreSQL 17.11 (Debian 12 bookworm), `pg_available_extensions`: `vector 0.8.7`, `unaccent 1.1`, `pg_trgm 1.6`.
- Brief says `pgvector/pgvector:pg17`: OK, but floating. Recommend pinning `pgvector/pgvector:0.8.7-pg17` in compose (reproducible, and upgrades of pgvector are explicit).

## 2. unaccent in the pgvector image
Nothing to install: `unaccent` is a contrib module already shipped in the image. Only `CREATE EXTENSION unaccent;` is needed (TESTED: `unaccent('Příliš žluťoučký kůň')` -> `Prilis zlutoucky kun`). The app role needs privilege to create extensions (compose default `postgres` superuser is fine; trusted-extension status of `vector` was not verified).

Gotcha: `unaccent(text)` is STABLE, so it cannot be used in a generated column or index expression. Fix (TESTED):
```sql
CREATE FUNCTION spoor_unaccent(text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;
```
Text search config for mixed Czech/English: `'simple'` (no stemming, no stopwords) over `spoor_unaccent(content)`. Postgres ships no Czech dictionary; `english` stemming would mangle Czech. Consequence: no stemming (`session` does not match `sessions`). Mitigations: prefix match in the query (`to_tsquery('simple', 'sessi:*')`, build it from tokens), and the vector half covers morphology. Use the same function for index and query side.

## 3. Drizzle pgvector support (TESTED with 0.45.4 / 0.31.11)
Sources: https://orm.drizzle.team/docs/guides/vector-similarity-search , https://orm.drizzle.team/docs/migrations
- Column: `vector({ dimensions: 3 })` from `drizzle-orm/pg-core` -> `vector(3)`; value is `number[]`.
- Helper: `cosineDistance(col, number[])` from `drizzle-orm` returns the `<=>` distance. Similarity = `1 - distance`:
```ts
const sim = sql<number>`1 - (${cosineDistance(chunks.embedding, q)})`;
db.select({ id: chunks.id, sim }).from(chunks).where(gt(sim, 0.92)).orderBy(desc(sim)).limit(1)
```
- HNSW in schema (generated DDL TESTED):
```ts
index('chunks_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')).with({ m: 16, ef_construction: 64 })
// -> CREATE INDEX "chunks_hnsw_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);
```
- Generated tsvector: no native type; use `customType<{data:string}>({ dataType: () => 'tsvector' })` plus `.generatedAlwaysAs(sql\`to_tsvector('simple', spoor_unaccent(content))\`)`; GIN: `index(...).using('gin', t.tsv)`. Generated to `"tsv" "tsvector" GENERATED ALWAYS AS (...) STORED` and works.
- Gotchas:
  1. drizzle-kit does NOT emit `CREATE EXTENSION` or the `spoor_unaccent` function. Create a first migration with `drizzle-kit generate --custom --name extensions` and hand-write the SQL (TESTED; it ran before the generated `0001_init.sql`). Statements in a file are separated by `--> statement-breakpoint`.
  2. Without `casing: 'snake_case'` columns are emitted camelCase (`"itemId"`). Set `casing: 'snake_case'` in BOTH `drizzle.config.ts` and `drizzle(pool, { casing })` (TESTED).
  3. The wide-dimension problem: a `vector(N)` column fixes N. For a pluggable provider, either one column per supported dim, or an untyped `vector` column plus partial expression HNSW index per model (TESTED in SQL, see section 5.6); Drizzle cannot express the expression index, so put it in a custom migration/the re-embed job. MVP simplification: `vector(384)` for default e5-small, and a re-embed migration step when dims change.
  4. Drizzle query builder cannot express the RRF CTE nicely: use `db.execute(sql\`...\`)` for hybrid search (typed rows via `.rows` with node-postgres).
  5. Top-level await in `tsx` scripts needs `.mts`/ESM package.

## 4. Migrations and driver
- `drizzle-kit push`: diffs schema vs live DB, no files; docs call it good for prototyping. Not suitable here: cannot do extensions/functions/triggers/partial expression indexes, no history. Use only for dev scratch.
- Recommended: `drizzle-kit generate` (commit SQL + `meta/`) and at app startup `await migrate(db, { migrationsFolder })` from `drizzle-orm/node-postgres/migrator` (TESTED; second call is a no-op, history in `drizzle.__drizzle_migrations`). Docs say runtime migrate is "widely used for monolithic applications": matches single-container deploy. Ship the `drizzle/` folder in the app image. Guard with a Postgres advisory lock if ever run with >1 replica (not needed MVP).
- Driver: `pg` 8.23.1 (node-postgres) via `drizzle-orm/node-postgres`. TESTED end to end. Reasons: most widely used, Pool semantics, `drizzle.execute()` returns `{rows}`, LISTEN/NOTIFY and transactions fine, drizzle's migrator for it is the reference path. postgres.js 3.4.9 (last release April 2026) also supported (`drizzle-orm/postgres-js`) and slightly faster but has had slower maintenance; no MVP need. Pick `pg`; add `@types/pg`.
- Dev dep for kit only: `drizzle-kit` (devDependency; the image needs only SQL files + orm).

## 5. SQL design (all TESTED in psql on pgvector/pgvector:pg17 unless noted)
Vector dim shown as 3 for the test; use 384 in production. Full script was run in one pass; results quoted.

### 5.1 DDL
```sql
CREATE EXTENSION IF NOT EXISTS vector;  CREATE EXTENSION IF NOT EXISTS unaccent;
-- spoor_unaccent() as in section 2

CREATE TABLE items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL, space text NOT NULL,           -- 'memories'|'decisions'|'docs'
  slug text NOT NULL, title text NOT NULL, body text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, space, slug)
);
CREATE TABLE item_revisions (
  item_id uuid NOT NULL REFERENCES items(id), revision integer NOT NULL,
  title text NOT NULL, body text NOT NULL,
  actor text NOT NULL, client text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, revision)
);
CREATE FUNCTION revisions_immutable() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN RAISE EXCEPTION 'item_revisions is append-only'; END $$;
CREATE TRIGGER item_revisions_ro BEFORE UPDATE OR DELETE ON item_revisions
  FOR EACH ROW EXECUTE FUNCTION revisions_immutable();

CREATE TABLE chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  project_id uuid NOT NULL, space text NOT NULL,
  idx integer NOT NULL, content text NOT NULL,
  model text NOT NULL, embedding vector(3) NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', spoor_unaccent(content))) STORED,
  UNIQUE (item_id, idx, model)
);
CREATE INDEX chunks_tsv_idx  ON chunks USING gin (tsv);
CREATE INDEX chunks_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);
CREATE INDEX chunks_model_idx ON chunks (project_id, model);

CREATE TABLE edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  src_id uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  dst_id uuid REFERENCES items(id) ON DELETE CASCADE,       -- NULL while a wikilink is unresolved
  dst_slug text,
  kind text NOT NULL CHECK (kind IN ('refines','supports','depends_on','conflicts_with','wikilink')),
  CHECK (dst_id IS NOT NULL OR dst_slug IS NOT NULL)
);
CREATE UNIQUE INDEX edges_uq ON edges (src_id, kind, COALESCE(dst_id::text, dst_slug));
CREATE INDEX edges_dst_idx ON edges (dst_id, kind);
CREATE INDEX edges_dst_slug_idx ON edges (project_id, dst_slug) WHERE dst_id IS NULL;
```
Notes: model tag lives on every chunk row (`model` column); the same item can hold chunks for old and new model during re-embed (`UNIQUE(item_id, idx, model)`), so the re-embed job inserts new-model chunks, then deletes old-model chunks, no search downtime. The expression `UNIQUE ... COALESCE` index cannot be declared in Drizzle schema: put it in a custom migration. `item_revisions` PK doubles as per-item history index. Hard delete of an item by humans cascades chunks/edges but `item_revisions` FK has no cascade and the trigger blocks DELETE: either drop the trigger's DELETE clause for item hard-delete or keep revisions with no FK (decide in ADR; recommend `ON DELETE` not cascading and a `SET LOCAL spoor.allow_purge` bypass in the trigger).

### 5.2 Hybrid search: FTS + vector, RRF, one query, filtered by active model
Params: $1 project, $2 query text, $3 active model, $4 query embedding (`vector`), $5 limit. RRF k=60; each branch top 50 chunks; best chunk per item.
```sql
WITH fts AS (
  SELECT c.item_id, c.id AS chunk_id,
         row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q) DESC) AS r
  FROM chunks c, websearch_to_tsquery('simple', spoor_unaccent($2)) q
  WHERE c.project_id=$1 AND c.model=$3 AND c.tsv @@ q
  ORDER BY ts_rank_cd(c.tsv, q) DESC LIMIT 50
), vec AS (
  SELECT c.item_id, c.id AS chunk_id,
         row_number() OVER (ORDER BY c.embedding <=> $4) AS r
  FROM chunks c WHERE c.project_id=$1 AND c.model=$3
  ORDER BY c.embedding <=> $4 LIMIT 50
), fused AS (
  SELECT COALESCE(f.chunk_id,v.chunk_id) AS chunk_id, COALESCE(f.item_id,v.item_id) AS item_id,
         COALESCE(1.0/(60+f.r),0) + COALESCE(1.0/(60+v.r),0) AS score
  FROM fts f FULL OUTER JOIN vec v ON f.chunk_id=v.chunk_id
), best AS (
  SELECT DISTINCT ON (item_id) item_id, chunk_id, score FROM fused ORDER BY item_id, score DESC
)
SELECT i.slug, b.score FROM best b JOIN items i ON i.id=b.item_id ORDER BY b.score DESC LIMIT $5;
```
TESTED: query `'pouzivame session'` (matches Czech text `Používáme` via unaccent) ranked the FTS+vector hit first (0.01639 vs 0.01613); vector-only query ranked by cosine. Old-model chunk (same item, other model tag) was ignored.
Gotchas: (a) HNSW + `WHERE` is a post-filter: with selective filters (project, model) the index may return fewer than LIMIT rows. pgvector 0.8 has iterative scans: `SET LOCAL hnsw.iterative_scan = relaxed_order;` (and `hnsw.ef_search`, default 40; set >= 50 to match LIMIT 50) inside the search transaction. Sizes here are small, so exact scan is also fine. (b) The `ORDER BY embedding <=> $4` must be the bare operator expression to use the index. (c) If sum(score) is not fused to an item with both branches, add per-item boost later; keep k=60 as a constant in code (unit-tested RRF, per brief). (d) Pass vector param as string `'[0.1,...]'` (`pg` has no vector codec) and cast `$4::vector`; Drizzle's `vector` column does this for you.

### 5.3 Near-duplicate check (cosine >= 0.92, same space, same model)
Cosine distance <= 0.08. Run per chunk or on the item's first/mean chunk before insert:
```sql
SELECT i.slug, 1-(c.embedding <=> $emb) AS cos
FROM chunks c JOIN items i ON i.id=c.item_id
WHERE c.project_id=$1 AND c.space=$2 AND c.model=$3 AND c.embedding <=> $emb <= 0.08
ORDER BY c.embedding <=> $emb LIMIT 1;
```
TESTED: returned `auth` with cos 0.9986 for `[0.95,0.05,0]` vs `[1,0,0]`. Keep the predicate as distance (`<= 0.08`) so ORDER BY can use HNSW. Drizzle equivalent in section 3 (`gt(sim, 0.92)` works but the `1 - dist` form in WHERE defeats the index; fine at MVP scale, prefer `lt(cosineDistance(...), 0.08)`).

### 5.4 Append-only revisions + optimistic concurrency (one atomic statement)
```sql
WITH upd AS (
  UPDATE items SET title=$t, body=$b, revision=revision+1, updated_at=now()
  WHERE id=$id AND revision=$expected
  RETURNING id, revision, title, body)
INSERT INTO item_revisions (item_id, revision, title, body, actor, client)
SELECT id, revision, title, body, $actor, $client FROM upd RETURNING revision;
```
TESTED: with `$expected=1` returns revision 2 and inserts the row; replaying with stale `1` returns 0 rows (`INSERT 0 0`) -> app maps empty result to a conflict error (re-read item to distinguish 404 from conflict). `DELETE FROM item_revisions` raises `item_revisions is append-only` (trigger). Row lock on `items` serialises concurrent writers; no transaction wrapper needed since it is one statement, but wrap together with chunk/edge rewrites in one transaction. Creation inserts revision 1 into both tables. In Drizzle: `.update(items).set({revision: sql\`${items.revision} + 1\`}).where(and(eq(id), eq(revision, expected))).returning()` (TESTED returned revision 2), then insert the revision row in the same `db.transaction`.

### 5.5 Edges and backlinks
```sql
-- backlinks of item $id (typed relations and wikilinks)
SELECT s.slug, s.title, e.kind FROM edges e JOIN items s ON s.id=e.src_id WHERE e.dst_id=$id;
-- resolve dangling wikilinks after an item is created
UPDATE edges e SET dst_id=i.id, dst_slug=NULL FROM items i
WHERE e.dst_id IS NULL AND e.dst_slug=i.slug AND e.project_id=i.project_id AND i.id=$new_id;
```
TESTED: backlink query returned `auth | wikilink` for `db`. Edge rewrite on item update: delete `kind='wikilink'` edges of `src_id` and re-insert from parsed `[[slug]]` (typed edges are untouched). Cross-space `shared` links: store `dst_slug` as `shared:slug` or add `dst_project_id`, decide in the domain model.

### 5.6 Multiple embedding dims (optional, TESTED)
```sql
CREATE TABLE c2 (id serial, model text, embedding vector);   -- untyped dims
CREATE INDEX c2_h ON c2 USING hnsw ((embedding::vector(2)) vector_cosine_ops) WHERE model='m2';
-- query must repeat the cast and the model predicate:
SELECT id FROM c2 WHERE model='m2' ORDER BY embedding::vector(2) <=> '[1,0]' LIMIT 1;  -- Index Scan using c2_h
```
Plan confirmed index use. More complex; defer unless OpenAI/Voyage with other dims is needed in MVP.

## 6. Recommendation
Use `pgvector/pgvector:0.8.7-pg17` (pinned; image already contains `vector` 0.8.7 and `unaccent`), Postgres 17.11. Stack: `drizzle-orm@0.45.4`, `drizzle-kit@0.31.11` (dev), `pg@8.23.1`, `@types/pg@8.23.1`; all older than 3 days. Avoid drizzle 1.0 RC. Schema in Drizzle (`casing: 'snake_case'`), migrations via `drizzle-kit generate` committed to the repo, applied at startup by `migrate()`; first migration is a hand-written custom one for extensions, `spoor_unaccent`, the revisions trigger and the edges COALESCE unique index. Search uses a single raw-SQL RRF query over `chunks` (tsvector `simple` + `spoor_unaccent`, GIN; vector cosine, HNSW) filtered by `model = active model`; set `hnsw.iterative_scan` for filtered recall. One chunk row per (item, idx, model) with `vector(384)` for the default e5-small; re-embed inserts new-model chunks then deletes old ones. Near-dup via `embedding <=> q <= 0.08`; OCC via the single-statement CTE update plus revision insert.

## Contradictions with BRIEF.md
None blocking. Notes: brief's `pgvector/pgvector:pg17` is a floating tag (pin it); fixed vector dimension conflicts with "pluggable provider" unless dims are equal or re-embed also migrates the column (decide in ADR).
