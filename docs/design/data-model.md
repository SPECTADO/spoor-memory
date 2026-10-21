# Data model

Status: design, 2026-10-19. Source of truth for `packages/server/src/db/schema.ts` (Drizzle,
`casing: 'snake_case'`) and `packages/shared` (zod frontmatter schemas). DDL below is Postgres 17 +
pgvector 0.8.7 (`pgvector/pgvector:0.8.7-pg17`). Anything Drizzle cannot express (extensions,
functions, triggers, expression/partial vector indexes) goes in hand-written custom migrations.
Deviations from BRIEF.md are listed in [deviations.md](deviations.md).

## 0. Conventions

- Ids: `uuid` (`gen_random_uuid()`); timestamps `timestamptz`, UTC.
- **Shared space = one project row with `kind = 'shared'`, slug `_shared`.** Every item therefore has
  a `project_id`; ADR numbering, settings, export and search code paths are reused unchanged.
- **Handles** (what agents and humans type, short on purpose):

  | space | handle | example | shared-space form |
  |---|---|---|---|
  | memories | `m<number>` | `m42` | `S:m4` |
  | docs | `d<number>` | `d7` | `S:d2` |
  | decisions | `ADR-<adr_number 4-digit>` | `ADR-0012` | `S:ADR-0003` |
  | library | `L<number>` | `L3` | `S:L1` |

  `number` comes from one per-project counter shared by all spaces, so `m`/`d`/`L` numbers never collide (and are sparse: there is no counter per space). The letter of a handle is case-insensitive for `L` (`L3` and `l3` both parse); `m` and `d` stay lower-case only.
  Resolution order for an id argument: `S:` prefix selects the shared project, then
  `^[mdl]\d+$` → number, `^ADR-\d+$` (case-insensitive) → adr_number, uuid → id, otherwise slug
  (searched memories, decisions, docs, library; >1 hit → `ambiguous_id` error listing the handles). A read of a slug that names exactly one own non-library item while `_shared` holds a library page with that slug also answers `ambiguous_id` (listing for example `d4, S:L3`), so an agent-written slug twin cannot silently replace a shared library page.
- **Every resolution is project-scoped.** One resolver (`packages/server/src/modules/items/resolve.ts`) serves MCP,
  REST, repo push, `adr/import`, frontmatter `relations` / `supersedes` / `drafted_from`, wikilinks and zip
  import edges, and every lookup it runs carries `AND project_id = ANY($allowed)`:
  - write targets, sources and `old`/`new_id` positions: `$allowed` = the caller's project only;
  - read ids (`spoor_get`, REST reads) and edge-target positions (`to`, `relations[].to`, wikilink
    targets): the caller's project plus `_shared`.
  A handle resolves in the project its prefix names (`S:` → `_shared`, else the caller's project); a uuid or
  slug is looked up in `$allowed`, the caller's project first. A uuid of another project is `not_found`,
  exactly like a uuid that does not exist. A repo push whose `spoor_id` is not in the project is treated
  as if it had no `spoor_id` (§7) and never touches the foreign item.
- **Canonical refs** (wikilink text, ADR refs, handle refs): `ADR-0007`, `adr-7`, `ADR-07` → `adr-7`
  (unpadded); `m42` → `m42`; `d7` → `d7`; `L3`, `l3` → `l3`; anything else → `slugify`. Both sides use the same function, so
  a stored `dst_ref` always compares equal to the refs of the item it names.
- Promoted frontmatter fields live in columns; `items.frontmatter` keeps only unknown/extra keys, so
  columns are always authoritative and nothing is stored twice.
- Text that agents and other users will read as one-liners (titles, tags, `client_name`) has control
  characters (Unicode `Cc`) and bidi controls (U+200E, U+200F, U+202A–U+202E, U+2066–U+2069) stripped on
  every write path (auth-and-security.md §13).

## 1. Extensions, helper functions, triggers (custom migration `0000_extensions.sql`)

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE FUNCTION spoor_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- append-only guard for item_revisions and audit_log; purge bypass for human hard-delete only
CREATE FUNCTION spoor_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('spoor.allow_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
```
The hard-delete transaction (UI only, project admin / instance admin) runs
`SET LOCAL spoor.allow_purge = 'on'` before `DELETE FROM items ...`. Nothing else sets it.

## 2. Identity and access

```sql
CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  password_hash       text NOT NULL,          -- 'scrypt$17$8$1$<salt b64url>$<hash b64url>'
  is_admin            boolean NOT NULL DEFAULT false,   -- instance admin
  shared_editor       boolean NOT NULL DEFAULT false,   -- may write the shared space (web UI only)
  disabled_at         timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (email);

CREATE TABLE sessions (
  id_hash      bytea PRIMARY KEY,              -- sha256(cookie value)
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),   -- idle expiry: last_seen_at + 14 d
  expires_at   timestamptz NOT NULL,                  -- absolute: created_at + 30 d
  user_agent   text CHECK (length(user_agent) <= 300)
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE invites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    bytea NOT NULL UNIQUE,         -- sha256('spi_' + 32 random bytes b64url)
  email         text CHECK (email = lower(btrim(email))),  -- optional: locks the invite to one email
  is_admin      boolean NOT NULL DEFAULT false,
  shared_editor boolean NOT NULL DEFAULT false,
  grants        jsonb NOT NULL DEFAULT '[]',   -- [{"project_id": uuid, "role": "admin|editor|viewer"}]
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,          -- default created_at + 7 d
  used_at       timestamptz,
  used_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at    timestamptz,
  reset_user_id uuid REFERENCES users(id) ON DELETE CASCADE,  -- IA only: password reset for this user
  reset_revoke_tokens boolean NOT NULL DEFAULT true,         -- reset also revokes the user's API tokens
  CHECK (reset_user_id IS NULL OR (grants = '[]'::jsonb AND NOT is_admin AND NOT shared_editor))
);
-- accept: reset only when reset_user_id is set (matched by user id, never by email). Any other invite
-- whose (locked or supplied) email belongs to an existing user → 409 already_exists, no password written.

CREATE TABLE projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL DEFAULT 'project' CHECK (kind IN ('project','shared')),
  slug             text NOT NULL UNIQUE,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description      text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  settings         jsonb NOT NULL DEFAULT '{}',   -- see 2.1
  next_item_number integer NOT NULL DEFAULT 1 CHECK (next_item_number >= 1),
  next_adr_number  integer NOT NULL DEFAULT 1 CHECK (next_adr_number >= 1),
  embedding_model  text NOT NULL,                 -- active model tag, e.g. 'local:Xenova/multilingual-e5-small@q8/384'
  embedding_target text,                          -- non-null while a re-embed is running
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'shared' AND slug = '_shared')
      OR (kind = 'project' AND slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'))
);
CREATE UNIQUE INDEX projects_single_shared ON projects (kind) WHERE kind = 'shared';
-- the shared row is inserted by the server at startup if missing (idempotent)

CREATE TABLE memberships (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('admin','editor','viewer')),
  library_editor boolean NOT NULL DEFAULT false,   -- right to write the project's library (ADR-0014)
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);
-- app rule: no memberships on the shared project (access there = is_admin / shared_editor / any reader)
-- app rule: library_editor is stored false whenever role = 'admin' (the role implies the right). Promoting to
-- admin clears it; demoting from admin sets it to the request's library_editor, default false, so no one keeps
-- the right without a visible decision; a viewer/editor change keeps it. Every implicit change is audited.

CREATE TABLE tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('user','service')),
  token_hash   bytea NOT NULL UNIQUE,          -- sha256(full token string)
  prefix       text NOT NULL,                  -- first 12 chars, e.g. 'spr_Ab12Cd34', display only
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  role         text CHECK (role IN ('editor','viewer')),
               -- service: required, fixed role. user: optional cap (NULL = inherit membership role)
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,                    -- bumped at most once per minute
  expires_at   timestamptz,                    -- NULL = no expiry; device-minted tokens default to +90 d
  revoked_at   timestamptz,
  origin       text NOT NULL DEFAULT 'web' CHECK (origin IN ('web','device')),  -- shown in the token list
  CHECK ((kind = 'user' AND user_id IS NOT NULL)
      OR (kind = 'service' AND user_id IS NULL AND role IS NOT NULL))
);
CREATE INDEX tokens_project_idx ON tokens (project_id);
CREATE INDEX tokens_user_idx ON tokens (user_id);
-- app rule: tokens never target the shared project; shared is readable through any project token

CREATE TABLE device_codes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash bytea NOT NULL UNIQUE,      -- sha256(device_code)
  user_code        text NOT NULL CHECK (user_code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{8}$'), -- stored without dash
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  client_name      text NOT NULL CHECK (length(client_name) BETWEEN 1 AND 64),
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','denied','consumed')),
  role_cap         text CHECK (role_cap IN ('editor','viewer')),   -- chosen on approval ("read-only")
  user_id          uuid REFERENCES users(id) ON DELETE CASCADE,     -- approver
  token_id         uuid REFERENCES tokens(id) ON DELETE SET NULL,   -- minted token
  interval_s       integer NOT NULL DEFAULT 5,
  last_polled_at   timestamptz,
  requester_ip     text CHECK (length(requester_ip) <= 45),  -- shown on the approval page
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,       -- created_at + 10 min
  decided_at       timestamptz
);
CREATE UNIQUE INDEX device_codes_live_user_code ON device_codes (user_code)
  WHERE status IN ('pending','approved');
CREATE INDEX device_codes_pending_idx ON device_codes (created_at) WHERE status = 'pending';
-- storage bound: at most 10,000 live rows instance-wide; a new code evicts the oldest pending rows
-- (auth-and-security.md §6).
```

### 2.1 `projects.settings` (zod schema in `packages/shared`; missing keys take defaults on read)

```json
{
  "cleanup":   { "stale_days": 30, "archive_days": 90, "observation_days": 7 },
  "digest":    { "default_budget": 1500, "decision_window_days": 30 },
  "dedupe":    { "threshold": 0.92 },
  "embedding": { "provider": "local" },
  "memory":    { "exclusive": true }
}
```
Ranges: `stale_days` 1–3650, `archive_days` 1–3650, `observation_days` 1–365,
`default_budget` 200–8000, `decision_window_days` 1–365, `threshold` 0.80–0.99,
`embedding.provider` ∈ providers enabled by env (`local` always). `memory.exclusive` is a boolean, default true (ADR-0015): when on, the
MCP instructions, the `AGENTS.md` block and the SessionStart hook tell agents to use no other memory store. Changing the provider sets
`embedding_target` (see search-and-digest.md §3); choosing the active model's provider again clears it.
Unknown keys are rejected on write. The column stores only the keys an admin set (a write deep-merges the
patch and validates the result), so a changed default reaches every project that never overrode it. A new
project stores `embedding.provider` = the instance's default provider (`SPOOR_EMBEDDING_DEFAULT`) and takes
that provider's tag as `embedding_model`; `_shared` is created at startup with `{}` and the default tag.

## 3. Content

```sql
CREATE TABLE items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  space            text NOT NULL CHECK (space IN ('memories','decisions','docs','library')),
  number           integer NOT NULL,           -- per-project counter (handles m42 / d7 / L3)
  adr_number       integer CHECK (adr_number BETWEEN 1 AND 99999),
  slug             text NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(slug) <= 80),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 200 AND title !~ '[\r\n]'),
  type             text,                       -- memories only
  status           text NOT NULL,
  lifecycle        text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','stale','archived')),
  confidence       text CHECK (confidence IN ('low','medium','high')),  -- memories only
  tags             text[] NOT NULL DEFAULT '{}',
  anchors          text[] NOT NULL DEFAULT '{}',
  frontmatter      jsonb NOT NULL DEFAULT '{}', -- extra/unknown keys only (<= 8 KB)
  body             text NOT NULL DEFAULT '' CHECK (length(body) <= 200000),
  revision         integer NOT NULL DEFAULT 1,
  pinned           boolean NOT NULL DEFAULT false,
  decided_on       date,                       -- decisions: frontmatter `date`
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  source_path      text,                       -- repo-relative path for mirrored ADRs/docs
  last_verified_at timestamptz NOT NULL DEFAULT now(),  -- creation counts as verification
  last_used_at     timestamptz,
  expires_at       timestamptz,                -- observations only (hard expiry)
  stale_since      timestamptz,
  archived_at      timestamptz,
  archive_reason   text CHECK (archive_reason IN ('stale','expired','manual')),
  push_conflict_at timestamptz,                -- set by a rejected repo push, cleared by the next accepted one
  provenance       text NOT NULL DEFAULT 'human' CHECK (provenance IN ('human','agent')),
                                               -- 'agent' after an MCP content write; 'human' after a web
                                               -- create/edit/verify/pin or a CLI push (a reviewed repo file)
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_label text NOT NULL,              -- actor label at creation; survives user deletion and import
  updated_at       timestamptz NOT NULL DEFAULT now(),  -- content writes only (no ORM $onUpdate)
  updated_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by_label text NOT NULL,
  client_name      text CHECK (length(client_name) <= 64),  -- last writer's MCP client / 'web' / 'spoor-cli'
  UNIQUE (project_id, space, slug),
  UNIQUE (project_id, number),
  CHECK ((space = 'decisions') = (adr_number IS NOT NULL)),
  CHECK ((space = 'memories') = (type IS NOT NULL AND confidence IS NOT NULL)),
  CHECK (space <> 'memories' OR type IN ('decision','fact','procedure','observation')),
  CHECK (CASE space
           WHEN 'decisions' THEN status IN ('proposed','accepted','superseded','deprecated')
           ELSE status IN ('active','superseded') END),
  CHECK ((type = 'observation') = (expires_at IS NOT NULL)),
  CHECK ((lifecycle = 'stale') = (stale_since IS NOT NULL)),
  CHECK ((lifecycle = 'archived') = (archived_at IS NOT NULL AND archive_reason IS NOT NULL)),
  CHECK (cardinality(tags) <= 20 AND cardinality(anchors) <= 20),
  -- library pages are active or archived, never stale, expiring, pinned, mirrored or agent-written
  CONSTRAINT items_library_shape_check CHECK (space <> 'library' OR (source_path IS NULL AND push_conflict_at IS NULL
    AND pinned = false AND expires_at IS NULL AND stale_since IS NULL AND lifecycle IN ('active','archived')
    AND provenance = 'human' AND status = 'active'))
);
CREATE UNIQUE INDEX items_adr_uq ON items (project_id, adr_number) WHERE adr_number IS NOT NULL;
CREATE UNIQUE INDEX items_source_uq ON items (project_id, source_path) WHERE source_path IS NOT NULL;
CREATE INDEX items_browse_idx ON items (project_id, space, lifecycle, status);
CREATE INDEX items_updated_idx ON items (project_id, updated_at DESC);
CREATE INDEX items_verified_idx ON items (project_id, last_verified_at DESC) WHERE lifecycle = 'active';
CREATE INDEX items_pinned_idx ON items (project_id) WHERE pinned;
CREATE INDEX items_tags_gin ON items USING gin (tags);
CREATE INDEX items_anchored_idx ON items (project_id) WHERE cardinality(anchors) > 0;
CREATE INDEX items_cleanup_idx ON items (project_id, lifecycle) WHERE space = 'memories';

CREATE TABLE item_revisions (            -- append-only, full snapshot per content revision
  item_id      uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,  -- cascade only under allow_purge
  revision     integer NOT NULL,
  title        text NOT NULL,
  body         text NOT NULL,
  status       text NOT NULL,
  frontmatter  jsonb NOT NULL,           -- FULL canonical frontmatter at this revision (columns + extras)
  change       text NOT NULL CHECK (change IN ('create','update','status','supersede','import','push')),
  actor_user_id uuid,                    -- no FK: rows are immutable, users may be deleted; NULL on imported rows
  actor_label  text NOT NULL,            -- email / 'service:<token name>' / 'system' / 'imported: <original label>'
  token_id     uuid,                     -- no FK, same reason; NULL on imported rows
  via          text NOT NULL CHECK (via IN ('web','mcp','cli','import','system')),
  client_name  text,
  imported_from jsonb,                   -- zip import only: {"via","actor_label","token_id","client_name"} as found
                                         -- in the archive; untrusted text, shown as "imported: …"
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, revision)
);
CREATE TRIGGER item_revisions_append_only BEFORE UPDATE OR DELETE ON item_revisions
  FOR EACH ROW EXECUTE FUNCTION spoor_append_only();
```

What creates a revision: changes to title, body, status, type, confidence, tags, anchors, extras
(i.e. anything that appears in the exported Markdown except operational state). Operational state
(`pinned`, `lifecycle`, `last_verified_at`, `last_used_at`, `stale_since`, `archived_*`,
`push_conflict_at`, `provenance`) changes do NOT bump `revision` or `updated_at`; they are recorded in
`audit_log`. `updated_at` is set only by this statement (no Drizzle `$onUpdate`), because the stale rule
reads it as a freshness signal. Every content write (MCP, REST, push, restore with promotion) uses this
one complete statement:

```sql
WITH upd AS (
  UPDATE items SET title=$t, body=$b, status=$s, type=$type, confidence=$conf, tags=$tags, anchors=$a,
         frontmatter=$fm, decided_on=$dec, provenance=$prov,
         expires_at = CASE WHEN $type = 'observation'
                           THEN CASE WHEN type = 'observation' THEN expires_at
                                     ELSE now() + make_interval(days => $obs_days) END
                           ELSE NULL END,
         status_changed_at = CASE WHEN status IS DISTINCT FROM $s THEN now() ELSE status_changed_at END,
         lifecycle   = CASE WHEN lifecycle = 'stale' THEN 'active' ELSE lifecycle END,
         stale_since = CASE WHEN lifecycle = 'stale' THEN NULL ELSE stale_since END,
         revision = revision + 1, updated_at = now(), updated_by = $u, updated_by_label = $label,
         client_name = $c
  WHERE id = $id AND revision = $expected
  RETURNING *)
INSERT INTO item_revisions (item_id, revision, title, body, status, frontmatter, change,
                            actor_user_id, actor_label, token_id, via, client_name)
SELECT id, revision, title, body, status, $full_fm, $change, $u, $label, $tok, $via, $c FROM upd
RETURNING revision;
```
Right-hand column references in `SET` read the old row, so a stale item becomes active and a type change
to `observation` gets `now() + observation_days` (never `created_at + …`). 0 rows → re-read: missing →
`not_found`, otherwise `revision_conflict` (current revision returned). Chunk and wikilink-edge rewrites
run in the same transaction; the transaction first takes
`SELECT embedding_model, embedding_target FROM projects WHERE id=$p FOR SHARE` (search-and-digest.md §3).

```sql
CREATE TABLE chunks (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id       uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  project_id    uuid NOT NULL,                 -- denormalised for filtering
  space         text NOT NULL,                 -- denormalised for filtering
  ordinal       integer NOT NULL CHECK (ordinal >= 0),
  item_revision integer NOT NULL,              -- revision the chunk was built from
  text          text NOT NULL,                 -- chunk text incl. heading-path prefix (no 'passage: ')
  model         text NOT NULL,                 -- model tag
  dims          smallint NOT NULL CHECK (dims BETWEEN 1 AND 2000),
  embedding     vector,                        -- untyped; NULL = pending embedding
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('simple', spoor_unaccent(text))) STORED,
  UNIQUE (item_id, model, ordinal),
  CHECK (embedding IS NULL OR vector_dims(embedding) = dims)
);
CREATE INDEX chunks_tsv_gin ON chunks USING gin (tsv);
CREATE INDEX chunks_scope_idx ON chunks (project_id, model, space);
CREATE INDEX chunks_pending_idx ON chunks (model) WHERE embedding IS NULL;
-- one partial expression HNSW index per model tag (custom migration for the default model,
-- created by the re-embed job for others); name = 'chunks_hnsw_' || left(md5(tag), 12):
CREATE INDEX chunks_hnsw_<md5> ON chunks
  USING hnsw ((embedding::vector(384)) vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  WHERE model = 'local:Xenova/multilingual-e5-small@q8/384';
```
`vector(384)` is the default model's width, not a column type: the column is untyped so a project can
re-embed to a model with a different dimension (deviation D1).

```sql
CREATE TABLE edges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,  -- project of src
  src_id     uuid NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('refines','supports','depends_on','conflicts_with',
                                           'supersedes','drafted_from','wikilink')),
  dst_ref    text NOT NULL,        -- typed/system: target uuid, or 'shared:<space>/<slug>' for a shared target;
                                   -- wikilink: canonical link text ('auth-flow', 'adr-7', 'm42', 'shared:style-guide')
  dst_id     uuid REFERENCES items(id) ON DELETE SET NULL,   -- resolved target; NULL = dangling
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_label text,           -- actor label; kept when the user is deleted or the edge is imported
  client_name text,
  UNIQUE (src_id, kind, dst_ref),
  CHECK (src_id <> dst_id)
);
CREATE INDEX edges_dst_idx ON edges (dst_id, kind);
CREATE INDEX edges_dangling_idx ON edges (project_id, dst_ref) WHERE dst_id IS NULL;

-- scope guard (custom migration): an edge belongs to its source's project, and nothing in _shared
-- points out of _shared; a project item may point only into its own project or into _shared
CREATE FUNCTION spoor_edge_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE src_p uuid; dst_p uuid; shared_p uuid;
BEGIN
  SELECT project_id INTO src_p FROM items WHERE id = NEW.src_id;
  SELECT id INTO shared_p FROM projects WHERE kind = 'shared';
  IF NEW.project_id IS DISTINCT FROM src_p THEN
    RAISE EXCEPTION 'edge project must equal source project' USING ERRCODE = 'P0002';
  END IF;
  IF NEW.dst_id IS NOT NULL THEN
    SELECT project_id INTO dst_p FROM items WHERE id = NEW.dst_id;
    IF dst_p <> src_p AND (dst_p <> shared_p OR src_p = shared_p) THEN
      RAISE EXCEPTION 'edge crosses projects' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER edges_scope BEFORE INSERT OR UPDATE OF src_id, dst_id, project_id ON edges
  FOR EACH ROW EXECUTE FUNCTION spoor_edge_scope();
```
The item service maps `P0002` to `read_only_space` (shared target in a write position) or `not_found`;
the trigger is the backstop, not the primary check.

Migration `0004_library_guards.sql` extends `spoor_edge_scope()` (the body above plus the library rules) and raises the
custom SQLSTATE **`SPL01`** (not `P0003`, which is plpgsql's built-in `too_many_rows`) when
(a) a non-library source points at a library page with `conflicts_with`, `supersedes` or `drafted_from`, or
(b) a library source has `conflicts_with` to a non-library item. The service maps `SPL01` to `wrong_space` (library wording).
Other outgoing links of a library page (`wikilink`, `refines`, `supports`, `depends_on`) may point at any item, in the project or
in `_shared`: they are a human choice at save time. The trigger does not restrict `dst_id` updates, because the human save path
re-resolves wikilinks with an upsert of `dst_id`; capture and takeover are refused in the services instead (claim filters
below). The same migration adds `spoor_library_revision_guard()` as a `BEFORE INSERT` trigger on `item_revisions`: a revision of
a library page whose `via` is `mcp` or `cli` raises **`SPL02`** (mapped to `read_only_space`), a backstop for every content write.
Edge kinds: agent-settable `refines | supports | depends_on | conflicts_with` (src → dst;
`conflicts_with` is symmetric, stored once, queried both ways; the reverse-direction check and the insert
run under a transaction advisory lock on the unordered pair, so concurrent `a→b` and `b→a` store one edge);
system `supersedes` (new → old),
`drafted_from` (ADR → decision memory it was drafted from), `wikilink` (rewritten from the body on
every content revision; typed edges untouched). Cross-project edges are allowed only from a project
item to a shared item, never from shared to a project (`spoor_edge_scope` above; `supersedes` and
`drafted_from` therefore never start in `_shared` through an agent path). `supersedes` and `drafted_from`
also never END in another project: no write path (including both import kinds) resolves them into
`_shared`, and an item's `superseded_by` counts only superseders of its own project. Wikilink grammar (shared regex in
`packages/shared`, fenced and inline code stripped first):
`\[\[(?:(shared):)?([^\[\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]`. Target text is canonicalised
(§0: `ADR-0007` → `adr-7`, `m42` stays `m42`, else slugify). Resolution order inside the source
project: handle forms by number (`m`, `d`, `l` and `adr-` refs), then slug in the source's own space, then docs, decisions, memories, with library pages ranking first for every source (rank 0, the source's own space 1, then docs, decisions, memories). A library source resolves handles and slugs in any space: its links are a human choice at save time, a link that resolves to nothing is stored dangling; `shared:` prefix →
shared project only. A newly created item has `refs_of_new = {slug, 'm<n>' | 'd<n>' | 'l<n>' | 'adr-<n>'}` (prefixed
`shared:` for a shared item) and, in its create transaction:
1. resolves dangling edges:
   `UPDATE edges SET dst_id=$new WHERE dst_id IS NULL AND kind='wikilink' AND project_id=ANY($scope) AND dst_ref=ANY($refs_of_new)`,
   with the source joined and `AND (s.space <> 'library' OR <new item's space> = 'library')`: a dangling link written in a
   library page is claimed only by a new library page;
2. takes over wikilinks whose slug text currently resolves to a lower-precedence item (for example a memory
   `auth-flow` when the new item is doc `auth-flow`) in the same scope, except links whose source is a library page
   (`s.space <> 'library'`): a resolved library link is never taken over by a newer item.
Capture is therefore blocked: an agent cannot redirect a library link by creating a slug twin later.
When a human re-saves a library page, wikilinks whose ref text is unchanged keep their stored target; an unchanged dangling ref resolves later only to a library page; refs newly added in that save resolve normally (library pages rank first); to repoint a link the human changes the ref text, for example to the item's handle. Both updates map edge
errors through `mapEdgeError`.
For a shared item the scope is every project.

**Hard delete of an item** (purge transaction): incoming typed, `supersedes` and `drafted_from` edges are
deleted (they have no meaning without their target); incoming wikilinks become dangling (`dst_id NULL`,
by the FK). An item whose only `supersedes` source was the deleted item goes back to `status='active'`
(memory) or `'accepted'` (decision) with a `change='status'` revision by the deleting user.

## 4. Audit and jobs

```sql
CREATE TABLE audit_log (                -- append-only (same trigger); hard deletes leave their row
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  project_id    uuid,                   -- NULL = instance-level (users, invites, projects); no FK
  actor_user_id uuid,                   -- no FK (immutable rows)
  actor_label   text NOT NULL,
  token_id      uuid,
  via           text NOT NULL CHECK (via IN ('web','mcp','cli','import','system')),
  client_name   text,
  action        text NOT NULL,          -- 'item.create','item.update','item.verify','item.pin','item.stale',
                                        -- 'item.archive','item.restore','item.delete','edge.add','edge.remove',
                                        -- 'item.push','item.push_rejected','item.dedupe_hit','token.create',
                                        -- 'token.revoke','member.set','member.remove','project.update',
                                        -- 'item.expire','project.settings','project.import',
                                        -- 'device.approve','device.deny'; instance-level
                                        -- (project_id NULL): 'project.create','project.delete','job.run',
                                        -- 'user.*', 'invite.*', ...
  item_id       uuid,
  item_handle   text,                   -- snapshot 'm42' / 'ADR-0007', relative to project_id (plain in _shared)
  summary       text NOT NULL CHECK (length(summary) <= 300),
  data          jsonb NOT NULL DEFAULT '{}'   -- e.g. {"revision":[3,4]}, never secrets or bodies;
                                        -- imported rows: {"imported_from":{…}} (§8 step 3)
);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION spoor_append_only();
CREATE INDEX audit_project_idx ON audit_log (project_id, at DESC);
CREATE INDEX audit_item_idx ON audit_log (item_id, at DESC) WHERE item_id IS NOT NULL;

CREATE TABLE job_locks (                -- scheduler lease, one row per job name (seeded at startup)
  name         text PRIMARY KEY,
  locked_until timestamptz NOT NULL DEFAULT '-infinity',
  locked_by    text,                    -- instance id (hostname:pid)
  last_run_at  timestamptz,
  last_status  text CHECK (last_status IN ('ok','error')),
  last_error   text
);

CREATE TABLE job_runs (                 -- history for the admin UI; pruned to 30 days
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL,
  project_id  uuid,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL CHECK (status IN ('running','ok','error')),
  stats       jsonb NOT NULL DEFAULT '{}',   -- {"staled":3,"archived":1,"expired":2} / {"embedded":120,"remaining":0}
  error       text
);
CREATE INDEX job_runs_name_idx ON job_runs (name, started_at DESC);
```
```sql
CREATE TABLE request_log (              -- agent requests, kept 14 days (ADR-0018); not append-only
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  project_id    uuid NOT NULL REFERENCES projects ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('read','write')),
  surface       text NOT NULL CHECK (surface IN ('mcp','cli')),
  operation     text NOT NULL,          -- tool name 'spoor_search' or 'GET /context'
  actor_user_id uuid,                   -- snapshots, no FKs (like audit_log)
  actor_label   text NOT NULL,          -- email or 'service:<token name>'
  token_id      uuid,
  token_name    text,
  token_prefix  text,
  client_name   text,                   -- MCP initialize client or CLI user agent
  space         text,                   -- targeted or written, when one
  memory_type   text,
  handles       text[] NOT NULL DEFAULT '{}',  -- read or written, at most 50
  query         text CHECK (length(query) <= 200),
  outcome       text NOT NULL,          -- 'ok' or the error code
  duration_ms   integer NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}'    -- digest files, tags, budget, HTTP status
);
CREATE INDEX request_log_project_idx ON request_log (project_id, id DESC);
CREATE INDEX request_log_project_kind_idx ON request_log (project_id, kind, id DESC);
CREATE INDEX request_log_at_idx ON request_log (at);  -- purge-ephemeral
```
Project deletion (instance admin, UI only) sets `spoor.allow_purge` and cascades everything.
`audit_log` rows of the project are kept (no FK) and are purged only by that same transaction.

## 5. Frontmatter schema per space

Files and exports use YAML frontmatter (`yaml` 2.9.1, `schema: 'core'`, `maxAliasCount: 20`).
Canonical key order on output is the table order. Unknown keys → `items.frontmatter` (round-trip).

Common to all spaces:

| key | type | req | default | maps to |
|---|---|---|---|---|
| `spoor_id` | uuid | no (server assigns) | — | `id` |
| `title` | string, 1–200, single line | no in files¹ | — | `title` |
| `tags` | string[] ≤20, `^[a-z0-9][a-z0-9_/-]{0,39}$` | no | `[]` | `tags` |
| `anchors` | string[] ≤20, repo-relative path/glob ≤256 chars | no | `[]` | `anchors` |
| `pinned` | bool | no | `false` | `pinned` (operational: applied only when an import or push **creates** the item) |
| `last_verified` | ISO date or date-time | no | creation time | `last_verified_at` (operational: same rule) |
| `relations` | `[{kind: refines\|supports\|depends_on\|conflicts_with, to: <handle\|uuid>}]` | no | `[]` | typed `edges` |
| `supersedes` | handle/uuid | no | — | `supersedes` edge |
| `superseded_by` | handle | output only | — | derived from edges |

Export writes `relations[].to`, `supersedes` and `drafted_from` as `spoor_id` uuids (a shared target as
`shared:<space>/<slug>`), so an archive never depends on another project's handle numbers. Repo files
written by the CLI keep handles. Server-owned extras (`renumbered_from`, `original_status`) survive a push
whose file lacks them.

¹ Title fallback: first `# H1` (with `ADR-0007:` / `7.` prefixes stripped for decisions), then the
humanised file name. MCP tools always require `title`.

`memories`:

| key | type | req | default |
|---|---|---|---|
| `type` | `decision\|fact\|procedure\|observation` | **yes** | — |
| `confidence` | `low\|medium\|high` | no | `medium` (`high` for `spoor_decide`) |
| `status` | `active\|superseded` | output only | `active` |
| `expires` | ISO date-time | output only; observations | `now() + observation_days` at create or at the type change to `observation` |

`decisions` (ADR):

| key | type | req | default |
|---|---|---|---|
| `adr` | integer ≥1 | no | file-name prefix, H1 number, else `next_adr_number` |
| `status` | `proposed\|accepted\|superseded\|deprecated` | no | `proposed` (web create, drafted ADRs); `accepted` for a repo file (push or `adr/import`) with neither a `status` key nor a `## Status` section |
| `date` | `YYYY-MM-DD` | no | today on create; absent on import if the file has none → `decided_on` NULL |
| `deciders` | string[] | no | — (extra) |
| `drafted_from` | handle[] | no | — (`drafted_from` edges) |

Import status mapping when there is no `status` key: first word of a `## Status` section (MADR /
adr-tools), lower-cased; `rejected` → `deprecated` (original kept as extra `original_status`);
`superseded by …` → `superseded` plus a `supersedes` edge when the ref resolves. This mapping applies to
push and `adr/import`; the manifest-less folder import of §8 does not apply it yet (deviations.md G9).

`library`: only the common keys, except that `pinned` is refused (`invalid_input`) and the item is always `active`; the
lifecycle is `active` or `archived`, and export writes no `status`, `expires` or `last_verified` for it. Library pages are never
repo-mirrored: `source_path` is always NULL.

`docs`: only the common keys, plus `status` (`active|superseded`) as an output-only key like the memories'
one: export writes it when not `active`; it is never stored as an extra (one known-key table in
`@spoor/shared`). Push ignores it (output only); the manifest-less folder import reads it for memories and
docs alike, so an export → folder-import round trip keeps a superseded item superseded.

## 6. Slug rules

`slugify(title)`: NFKD, drop combining marks, lower-case, every run of chars outside `[a-z0-9]` → `-`,
trim `-`, cut to 80 chars at the last `-` boundary ≤80. Empty → `item`. Reserved shapes (would shadow
handles): `^[mdl]\d+$`, `^adr-\d+$`, uuid shape → prefixed `x-`. Migration 0004 renames existing slugs shaped `l<n>` to `x-l<n>` and rewrites the `dst_ref` of wikilinks that resolved to them (item bodies are not rewritten, because revisions are append-only, so a body link `[[l<n>]]` must be re-saved as `[[x-l<n>]]`; the migration raises a NOTICE with the counts). Import renames every item whose slug has a reserved shape, in any space, to `x-<slug>` with the usual collision rule, and lists the rename in the result notes. Collision inside (project, space) →
append `-2`, `-3`, … (same 80-char cap). Slugs are immutable after creation (wikilinks and repo
files reference them); the title can change freely. Items created by a repo push or `adr/import` take
their slug from the file name instead (`docs/intro.md` → `intro`; ADRs without the number prefix,
`0007-use-postgres.md` → `use-postgres`), through the same slugify and collision rules. Decision slugs exclude the number
(`0007-use-postgres.md` → slug `use-postgres`, `adr_number` 7). Project slugs: CHECK above, plus
reserved `api`, `assets`, `device`, `invite`, `login`, `admin`, `projects`, `shared`.

## 7. ADR numbering

- `projects.next_adr_number` is the next free number. Every insert with an explicit number runs
  `UPDATE projects SET next_adr_number = greatest(next_adr_number, $n + 1)` in the same transaction;
  an insert without a number takes `next_adr_number` and increments it (row lock serialises writers).
- Number source on import/push (precedence): frontmatter `adr` → file name `^(\d{1,5})-` → H1
  `ADR-(\d+)` or `^(\d+)\.` → none (assign next).
- **Matching order** (the same for `adr/import` and push, scoped per §0): `spoor_id` found in this project →
  `(project_id, source_path)`. The ADR number is **not** a match key: a file whose number is held by another
  item is a collision and is renumbered (step 3 below), so a new file can never overwrite another ADR
  (deviations.md G3). A `spoor_id` that is not in this project is ignored for matching (warning
  `foreign_spoor_id`); it never updates the foreign item.
- `spoor adr import` processes files sorted by path. The request carries `reserve_above` = the highest
  number among **all** local ADR files (the CLI computes it before the first batch and sends it with every
  batch). Per file:
  1. Matched by `spoor_id` or `source_path` → treated as a push (update, fast-forward rules below), number
     unchanged; the response carries the existing `spoor_id` so the CLI writes it back. A file number that
     differs from the item's gives `number_mismatch` (warning only).
  2. Number free → insert with that number.
  3. Number held by another item → **renumber**: insert with
     `greatest(next_adr_number, reserve_above + 1)`, response `{renumbered: {from: 7, to: 15}}`, and store
     `renumbered_from: 7` as a server-owned extra. Only true collisions move; the repo's own later numbers
     stay free. The CLI renames the file to `0015-<slug>.md` and sets `adr: 15` when the file has an `adr`
     key. Existing Spoor items never change number.
  4. A concurrent insert of the same new file (`23505` on `items_source_uq`) is retried once as an update.
- **ADR refs inside a batch** (`supersedes: ADR-0007`, `## Status: Superseded by ADR-0007`, `[[ADR-0007]]`,
  `drafted_from`) resolve first through the request's map `{repo number → assigned number}`, then in the
  project. A ref to a number that was renumbered in this or an earlier import (an item carries
  `renumbered_from` equal to it, or the number is a map key) is **not applied**: the response carries
  `{code:"ambiguous_ref", ref:"ADR-0007", candidates:["ADR-0007","ADR-0015"]}` and a human fixes the file.
- Gaps are allowed and never reused. Hard-deleted numbers are not reused (counter only grows).

**Repo push** (`POST /p/:slug/api/push`, used by the PostToolUse hook and `spoor adr push`):
- Body: `{space: 'decisions'|'docs', source_path, content, base_revision?, force?}`. The CLI keeps
  `base_revision` per `spoor_id` in the gitignored `.spoor/state.json`.
- Matching order as above. If nothing matches, the push creates a new item, numbered as above for ADRs.
  A `spoor_id` match whose `source_path` differs (the file was renamed or renumbered) updates
  `source_path` in the same transaction; if another item holds that path the result is `409
  source_path_taken` and nothing is written.
- It is a fast-forward when `base_revision` equals the current revision, or when the item's latest
  revision has `via = 'cli'`, i.e. nobody edited it in Spoor since the last push. Zip-imported revisions
  (`via='import'`) never count as a fast-forward base. A fast-forward writes a revision with
  `change='push'` through the §3 statement and clears `push_conflict_at`. The §3 statement checks the
  revision the decision was made on: an edit that committed in between (for example during the embedding
  call) makes the push decide again on the fresh row (fast-forward only if that edit came from the CLI),
  never last-write-wins.
- Otherwise the result is `409 pushed_over_spoor_edit {current_revision, edited_by, via}`, nothing is
  written except `push_conflict_at = now()` (operational, audited as `item.push_rejected`, shown in the
  review queue). `spoor adr push --force` (an explicit human choice, TTY-confirmed by the CLI) writes
  anyway. Identical content is a no-op.
- **What a push applies**: content keys (title, body, tags, anchors, status, `date`, extras) follow the
  file, because the file is the mirror's source; a missing content key takes its default. Operational
  keys (`pinned`, `last_verified`) are applied only when the push creates the item. Server-owned extras
  (`renumbered_from`, `original_status`) are kept.
- `status='superseded'` is sticky: while an incoming `supersedes` edge from a non-superseded item exists, a
  push that says otherwise keeps `superseded` and returns the warning `status_kept_superseded`.
- An ADR whose frontmatter has `supersedes: ADR-0003` sets ADR-0003 to `status='superseded'` (a
  `change='supersede'` revision with `via='cli'`) and adds the edge. An ADR with `drafted_from` adds
  `drafted_from` edges. A push that would **create** an ADR with `drafted_from: [m59]` while m59 already has
  a `drafted_from` edge from another, non-superseded ADR returns `409 already_drafted {handle:"m59",
  adr:"ADR-0015"}` and writes nothing (two sessions drafted the same memory). The check runs again inside
  the create transaction, after the project row lock that serialises creates, and the new ADR's
  `drafted_from` edges are inserted in that same transaction, so two concurrent drafts give one ADR and
  one 409.
- Shared ADRs have their own counter (the shared project row); handle `S:ADR-0003`.

## 8. Export zip layout and lossless import

```
manifest.json
memories/<slug>.md
decisions/<NNNN>-<slug>.md
docs/<slug>.md
library/<slug>.md
revisions/<item-uuid>.jsonl     -- one JSON object per revision, ascending
audit.jsonl                     -- project audit_log rows, ascending id
```
Entry-name allowlist (import): `^manifest\.json$`, `^audit\.jsonl$`,
`^(memories|docs|library)/[a-z0-9-]{1,80}\.md$`, `^decisions/\d{4,5}-[a-z0-9-]{1,80}\.md$`,
`^revisions/[0-9a-f-]{36}\.jsonl$`. Markdown files = canonical frontmatter (§5, plus `spoor_id`) +
body of the current revision; they are for humans and for manifest-less imports.

`manifest.json` (zod-validated, ≤20 MB):
```json
{
  "format": "spoor-export/1",
  "exported_at": "2026-10-19T12:00:00Z",
  "spoor_version": "0.1.0",
  "history": true,
  "project": { "id": "uuid", "kind": "project", "slug": "acme", "name": "Acme", "description": "",
               "settings": {}, "next_item_number": 57, "next_adr_number": 13 },
  "items": [ {
      "id": "uuid", "space": "memories", "number": 42, "adr_number": null, "slug": "session-store",
      "path": "memories/session-store.md", "revision": 3, "content_sha256": "hex",
      "pinned": false, "lifecycle": "active", "provenance": "agent", "last_verified_at": "...",
      "last_used_at": null, "expires_at": null, "stale_since": null, "archived_at": null,
      "archive_reason": null, "status_changed_at": "...", "decided_on": null, "source_path": null,
      "push_conflict_at": null, "created_at": "...", "created_by_label": "ann@example.com",
      "updated_at": "...", "updated_by_label": "ann@example.com", "client_name": "claude-code/2.1.303" } ],
  "edges": [ { "id": "uuid", "src_id": "uuid", "kind": "wikilink", "dst_ref": "auth-flow",
               "dst_id": "uuid|null", "created_at": "...", "created_by_label": "ann@example.com",
               "client_name": null } ]
}
```
`content_sha256` = sha256 of the Markdown file as exported (canonical frontmatter plus body), so an edit
to either part is detected. Typed and system edges to a shared item carry `dst_ref`
`shared:<space>/<slug>`. The manifest holds **labels, never user ids**.

Revision line: `{"revision":1,"title":…,"body":…,"status":…,"frontmatter":{…},"change":"create",
"actor_label":"ann@example.com","via":"mcp","client_name":…,"imported_from":null,"created_at":…}`.
Not exported: chunks/embeddings (rebuilt), user ids, tokens, sessions, memberships (so neither `library_editor`), password hashes,
device codes.

Import (`POST /api/v1/projects/import` new project, or into an existing **empty** project; shared
only by an instance admin into an empty shared space). It runs on the request thread (deviation I46), at most one import or
export per instance at a time (auth-and-security.md §9):
1. Unzip with hardening (auth-and-security.md §9), validate manifest and every line with zod.
2. Ids: kept as-is when no item/edge id exists anywhere in the instance; otherwise fail
   `id_collision` unless `remap_ids=true`, which assigns new uuids and rewrites `edges.src_id/dst_id`,
   `dst_ref` of typed edges, `spoor_id` in frontmatter snapshots and `audit.jsonl` `item_id` /
   `project_id` consistently (repo files that carry the old `spoor_id` then no longer match; the response
   says so).
3. **Provenance is marked, never forged.** Archive actors are never mapped to live users:
   `items.created_by/updated_by`, `edges.created_by`, `item_revisions.actor_user_id/token_id` and
   `audit_log.actor_user_id/token_id` are NULL on imported rows; the labels are kept as text. Every
   imported revision and audit row gets `via='import'`, `actor_label = 'imported: ' || <original label>`
   (a label that already starts with `imported: ` is kept as is) and `imported_from` (revisions) or
   `data.imported_from` (audit) = the original `{via, actor_label, token_id, client_name}`. One extra
   `project.import` audit row names the real importer (`via='web'`).
4. Items inserted with their `number`, `adr_number`, `revision` and all state columns; revisions
   inserted with their original `created_at` (the trigger blocks only UPDATE/DELETE). An archive without
   revisions (`history: false`, `?history=0`) gets one synthesised revision per item at the item's
   `revision`, `change='import'`, so every item has its current snapshot in `item_revisions`. Counters are
   set to `max(target counter, manifest counter, max(number)+1)` and
   `max(target counter, manifest counter, max(adr_number)+1)`, so numbers a target project once used are
   never reused.
5. If a Markdown file's `content_sha256` differs (frontmatter or body edited after export), one extra
   revision with `change='import'` is appended on top (logged in the response).
6. Edges: inserted with their ids. A `dst_id` that is neither in the archive nor an item of the target
   instance is set to NULL. Edges whose `dst_ref` starts with `shared:` re-resolve against the target
   instance's shared space (typed edges by `<space>/<slug>`, wikilinks by the wikilink rules), except
   `supersedes` and `drafted_from`, which never point into `_shared`; unresolved ones stay dangling and are
   listed in `dangling_edges`.
   The manifest is user-editable, so it is validated beyond the column CHECKs: a pinned item cannot be
   `stale` (422), and `last_verified_at`, `last_used_at` and `updated_at` later than the import are clamped
   to the import time (a future time would keep an item from ever going stale).
   Library rows are normalised: `lifecycle` `stale` becomes `active`, `stale_since`, `expires_at`, `source_path` and
   `push_conflict_at` are NULL, `pinned` false, `status` `active`, `provenance` `human` (the shape check would refuse the
   insert otherwise). Library → non-library `wikilink`, `refines`, `supports` and `depends_on` edges are kept; edges of the kinds
   the rule refuses (`conflicts_with` between a library and a non-library item, `supersedes` or `drafted_from` into a library page)
   are dropped and listed with the other skipped edges. The claim updates of the import apply the same two filters as §3, and a
   later `_shared` import resolves typed refs of a library source normally.
   An archive that contains `library/` entries needs the library right on the target (`library.write`); a server still on 0.1.0
   rejects it with `invalid_archive`. The format stays `spoor-export/1`.
7. `audit.jsonl` appended with original timestamps (marked as in step 3), plus the `project.import` row.
8. All in one transaction, including the chunk rows: every imported item gets its chunks for every model
   of the project's locked set with `embedding = NULL` (FTS works at once, nothing depends on a background
   task); after the commit `embed-pending` is nudged and fills the embeddings.

Manifest-less zip (a folder of Markdown): every file becomes a new item at revision 1 (`change=import`,
`via='import'`), numbers per §7. It may target a non-empty project; then refs in `relations`,
`supersedes` and `drafted_from` resolve only as uuids or as handles/slugs of files **in the same zip**,
never against the target project's own items (unresolved refs are listed, not guessed); `supersedes` and
`drafted_from` never resolve to the shared space. `last_verified` is clamped to the import time, like push.
The new items claim the target project's existing wikilinks like any create (§3): dangling links naming a
new item's slug or handle, and slug links that now resolve to a new, higher-precedence item, in the import
transaction.

**Round-trip test (DoD 6)**: export project A (with one memory linking `[[shared:style-guide]]`, one
typed `spoor_relate` edge to `S:m4`, and history) → import into an empty instance whose shared space
lacks those items → export again. The manifests and revision lines must be equal after normalising
provenance (`imported_from ?? {via, actor_label}` per revision and audit row; `actor_label` without the
`imported: ` prefix), except `exported_at`, `project.id` when remapped, and `dst_id` of the dangling shared
edges (NULL, listed in `dangling_edges`). A second case runs `?history=0` and checks one synthesised
revision per item.
