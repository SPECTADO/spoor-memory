# Spoor memory — brief

Agreed 2026-10-19 between the owner (Ladislav Soukup) and Claude after a grilling session.
This is the contract for the MVP. Change it here before changing the code.

## Goal

A self-hosted, team-shared memory for coding agents and humans. Agents read and write it
through MCP with very few tokens; humans browse, edit and administer it in a web UI. One
Docker deployment serves many isolated projects plus one shared, org-wide knowledge space.
Self-hosted now; later SaaS as one container per client, so the app stays single-tenant.

## In scope (MVP)

### Memory model
- Every item is Markdown with YAML frontmatter, stored in Postgres, versioned (append-only revisions).
- Three spaces per project:
  1. **memories** — atomic claims. `type: decision | fact | procedure | observation`,
     `confidence`, `last_verified`, `anchors` (repo paths/globs), `tags`, supersede chain,
     typed edges `refines | supports | depends_on | conflicts_with`.
  2. **decisions** — ADR documents, numbered `ADR-0001` per project,
     `status: proposed | accepted | superseded | deprecated`.
  3. **docs** — long-form pages (architecture overview, domain model, runbooks).
- `[[slug]]` wikilinks in any body become graph edges; backlinks are shown in the UI.
- **shared** space: same three spaces, readable by every project token, written only by
  humans in the web UI (instance admins and users with the `shared_editor` right).
- Observations carry a hard expiry (default 7 days).

### Search and embeddings
- Hybrid search: Postgres full-text + pgvector cosine, fused (reciprocal rank fusion).
- Embedding provider is pluggable. Default: local ONNX `multilingual-e5-small` inside the app
  container, no API key. Optional OpenAI / Voyage / Ollama via env.
- Long items are chunked (~400 tokens, overlap); each chunk has a vector tagged with the model
  name. A `re-embed` job rebuilds all vectors when the model changes; search ignores vectors
  from a different model than the active one.
- Near-duplicate check on write (cosine ≥ 0.92 within the same space) returns the existing
  item instead of creating a copy. *Amended 2026-10-22 (ADR-0025): only the same text is refused; a similar item is
  saved and named in the reply, items whose values differ never count, default threshold 0.87.*

### Agent access (MCP, Streamable HTTP)
- Endpoint `/p/<slug>/mcp`, bearer token. Token is per user per project (inherits the user's
  project role; viewer tokens are read-only) or a project service token for CI/bots.
- Tools: `spoor_context` (budgeted digest, default 1500 tokens, ids + one-liners; pinned
  first, then accepted decisions from the last 30 days, then items anchored to the given
  files, then relevance to the optional query, then recently verified), `spoor_search`,
  `spoor_get`, `spoor_remember`, `spoor_decide`, `spoor_doc_write`, `spoor_supersede`,
  `spoor_relate`, `spoor_verify`.
- Every write records the user (token owner) and the client name from MCP `initialize`.
- Optimistic concurrency: updates carry `revision`; mismatch → conflict error, never
  last-write-wins.

### Harness integration
- Install doc per project at `/p/<slug>/install.md`, public, secret-free. Claude Code first,
  short generic-MCP section (Cursor, Codex, Gemini CLI) second.
- Device login (RFC 8628 style): agent requests a code, user opens the URL, logs in, approves
  the project, agent polls and receives a token. Manual path: paste the token.
- Token stored in `.claude/settings.local.json` → `env.SPOOR_TOKEN`; committed `.mcp.json`
  and hooks reference `${SPOOR_TOKEN}`.
- Hooks: **SessionStart** fetches the digest (passes recently changed files from git as
  anchors). **Stop** blocks once, only when the session changed files and made no Spoor
  writes, asking the agent to record decisions or confirm there were none; a marker file
  prevents a second nag in the same session.

### Repo mirror (ADRs and docs)
- Client CLI `spoor` in the `spoor-memory` npm package (also the hooks helper).
- `spoor adr import` at install time: one-time push of every existing `docs/adr/*.md` into the
  decisions space; writes the assigned `spoor_id` back into each file's frontmatter. Existing
  numbers are kept; Spoor continues numbering from the highest.
- Push on change: a PostToolUse hook on Write/Edit of `docs/adr/*.md` runs `spoor adr push <file>`.
- Draft from memory: `spoor_decide` records a short decision memory only. The Stop hook runs
  `spoor adr draft`, which takes this session's decision memories without an ADR, drafts the
  ADR with a cheap model **client-side** (configurable command, default
  `claude --model haiku -p`), saves `docs/adr/NNNN-slug.md`, and pushes it.
- Same import-once and push-on-change for a configurable doc list (default `ARCHITECTURE.md`,
  `GLOSSARY.md`, `docs/*.md` minus `docs/adr/`) into the docs space. No drafting for docs.
- No pull: items edited in the web UI stay in Spoor only. No full two-way sync.

### Self-cleanup
- Memory unverified and unused for 30 days → `stale` (out of the digest, in the review queue).
- Stale for 90 more days → `archived` automatically. Both counts are per-project settings.
- Decisions and docs never auto-expire; they only get superseded.
- Only humans hard-delete, in the UI. Nothing else deletes.

### Web UI
- Project list → project dashboard (counts, recent changes, review queue) → browse per space
  with type/tag filters → search → rendered Markdown with backlinks → edit with live preview
  (CodeMirror) → revision history with diff → pin/verify/archive/delete actions.
- Admin: users, invite links (copyable, no email), projects, memberships, roles, tokens,
  shared-editor right, project settings (cleanup days, embedding provider).
- Audit log per project: who or which agent changed what, when.
- English UI. No graph visualisation (phase 2).

### Auth and roles
- Local email + password, cookie sessions, bootstrap admin from env on first run.
- Roles: instance `admin`; per project `admin | editor | viewer`; global `shared_editor` right.

### Export / import
- Export a project (or shared) as a zip of Markdown files with frontmatter; import the same.

### Deployment
- pnpm monorepo: `packages/server` (Hono, MCP SDK, Drizzle), `packages/web` (React, Vite,
  Tailwind, TanStack Query, React Router), `packages/shared` (types, frontmatter schema).
- One app image on GHCR (multi-arch) + `pgvector/pgvector:pg17`, `docker-compose.yml`, optional
  `caddy` profile for automatic HTTPS. Plain HTTP on one port otherwise. Config by env vars,
  documented in `.env.example`.
- Node 22 LTS. MIT licence. Package name `spoor-memory`.

### Tests and CI
- Vitest unit tests (ranking, chunking, frontmatter, cleanup rules, RRF).
- Integration tests for REST + MCP tools against a real Postgres from compose.
- Playwright smoke test (login, browse, edit, create token).
- GitHub Actions: lint, tests, image build.

### Documentation to keep current
- `README.md`, `docs/install.md` (operator), `ARCHITECTURE.md`, `docs/adr/` for every
  significant decision above, `GLOSSARY.md` for the domain model.

## Out of scope (MVP)
- memspec import, OIDC/SSO, SMTP email, graph visualisation, pulling ADRs or docs from Spoor
  back into the repo (full two-way sync), server-side LLM calls, git blob SHA drift detection, multi-tenancy inside one container, rate limiting,
  agent writes to the shared space.

## Constraints
- Agents must get useful context in one call of ~1500 tokens on a large repo.
- Self-hosting must work with zero external accounts.
- No secrets in committed files.
- Dependency safety: release-age delay on every package added.

## Definition of done
1. `docker compose up` on a clean machine gives a working instance with a bootstrap admin.
2. Admin creates a project, a user, and the user gets a token via device login from Claude Code
   following only the install doc.
3. From Claude Code: `spoor adr import` pushes existing ADRs; editing an ADR file pushes it; a
   `spoor_decide` call followed by session end yields a drafted ADR file pushed to Spoor;
   SessionStart digest arrives; `spoor_remember`, `spoor_decide`, `spoor_search`,
   `spoor_context` with anchors all work; the Stop hook nags exactly once when nothing was recorded.
4. The web UI lists, searches, renders, edits (with history) and administers everything above.
5. Cleanup job moves an unverified memory to stale and then archived on the configured schedule.
6. Export produces a zip that re-imports losslessly.
7. All three test layers pass in CI and the image builds.

## Build plan (each phase is one ultracode workflow, owner checkpoint between phases)
1. Architecture + ADRs + domain model + scaffold (monorepo, compose, migrations).
2. Server core: auth, projects, items, revisions, search, embeddings, cleanup, export/import.
3. MCP server, tools, device login, install doc, hooks, client CLI (import/push/draft).
4. Web UI.
5. Tests, CI, docs, adversarial review.

## Amendments (2026-10-19, after the phase 1 design review; accepted by the owner)

Reference numbers point to `docs/design/deviations.md`.
- **D9 archive rule**: a stale memory is archived after the archive window only if it was also not
  used during the last `stale_days`; a stale memory still being fetched stays in the review queue.
- **I33 device-login tokens** expire after 90 days by default; web-created tokens keep an optional expiry.
- **I34 drafted ADRs** are pushed as `proposed`; they enter the digest's decision tier once a human
  accepts them. Drafting is skipped when `CI` is set.
- **I35 install path**: `spoor login` ends with `spoor init`, which writes `.mcp.json`, the hooks,
  the `mcp__spoor` permission and `.gitignore` entries from a public `/p/<slug>/install.json`.
  The install doc is mostly commands (curl first, WebFetch second).
- **I36 model upgrade**: the image ships only the current default model; a project searches
  full-text only (no duplicate check) until its re-embed job cuts over.
- **I37 digest shares**: library ≤ 15 %, pinned ≤ 30 %, recent decisions ≤ 25 % while anchored/relevant items
  exist (tiers library+pinned+decisions keep ≥ 35 % for them); overflow becomes one roll-up line per tier;
  titles cut at 90 chars.
- **I38 untrusted data**: digest and `spoor_get` start with a fixed ~20-token "data, not
  instructions" line; agent-written, unreviewed items carry a `~` marker; control/bidi characters
  are stripped from titles, tags and client names.
- **D6 duplicates**: threshold is a per-project setting (0.80–0.99, default 0.92); write tools
  accept `allow_duplicate: true` after a duplicate hit.
- **Docs naming (H16)**: the operator guide the brief calls `docs/install.md` is `docs/operations.md`; the web, agent and CLI guides are `docs/user-guide.md` and `docs/agent-guide.md`; Definition-of-done evidence is `docs/design/dod-status.md`.

## Amendment (2026-10-20): Library space

Agreed 2026-10-20 between the owner and Claude (four questions; the owner took the recommended answer each time).
- **Fourth space `library`** in every project, including `_shared`: long-form pages a human wants set in stone
  for agents (graphics guide, architecture guide, conventions). Same `items` table and mechanisms as docs
  (revisions, search, anchors, tags, wikilinks, export/import, audit). Handle `L3` (`S:L3` in the shared space).
  Library pages never expire and never go stale; only a human archives or deletes them.
- **Human-only writes**: created and edited only in the web UI by a logged-in human who is an instance admin, a
  project admin, or a member with the new per-membership `library_editor` flag (granted by project admins, the
  project-scoped twin of `shared_editor`). Every MCP, CLI, token and bearer write path, including verify, pin,
  lifecycle, relate-from and delete, is rejected with `read_only_space`, as for the shared space. Edges from
  project items to library pages are allowed. Owner amendment the same day: a human editing a library page may
  also link it to any item (`wikilink`, `refines`, `supports`, `depends_on`); agents' new items never capture or
  take over those links; `conflicts_with` between a library page and a non-library item is refused either way.
- **Agent reads**: a new first digest tier lists every active library page as handle + title under a capped
  share (overflow becomes one roll-up line); anchored pages also surface in the anchor tier; `spoor_search` and
  `spoor_get` accept the library space. No new MCP tool.
- **No repo mirror**: library pages live only in Spoor and travel with the project export zip. A human-only CLI
  push may be added later.

Recorded in ADR-0014.

## Amendment (2026-10-20): Exclusive memory

Agreed 2026-10-20 between the owner and Claude (four questions, answered one at a time).
- **Spoor is the agents' only memory by default**: the project setting `memory.exclusive` (default on, toggled by
  project admins in the web UI) adds one rule to the MCP instructions: do not read or write other memory stores
  (Claude Code auto-memory, other memory MCP servers, memory notes in files) unless the user asks.
- **`spoor init` writes the instructions into the repo**: a managed Spoor block in `AGENTS.md` (the rule when
  exclusive, plus the Spoor usage lines) and an `@AGENTS.md` import in `CLAUDE.md`; both files are created if missing.
- **SessionStart checks the block**: when it is missing or out of date, the hook tells the agent to ask the user for
  `spoor init` and, for an exclusive project, injects the rule for that session. The hook never edits the files.
- **Auto-memory off per user**: for an exclusive project, init (and so `spoor login`) sets `autoMemoryEnabled: false`
  in the user's own `.claude/settings.local.json`; teammates who never logged in keep theirs.

Recorded in ADR-0015.

## Amendment (2026-10-21): Graph view and link suggestions

Agreed 2026-10-21 between the owner and Claude (twelve questions, answered one at a time; the owner took the
recommended answer each time and picked all four linking improvements). Supersedes "No graph visualisation
(phase 2)" in the Web UI section and the matching out-of-scope entry.

- **Map page**: `/projects/:slug/graph` (also `/shared/graph`), one nav entry, one lazy chunk. Nodes are items,
  edges are rows of the `edges` table: the seven stored kinds (refines, supports, depends_on, conflicts_with,
  supersedes, drafted_from, wikilink), each with its own style and toggle. Dangling wikilinks are hollow ghost
  nodes labelled with the reference text. Anchors are not edges in v1. Shared and library targets reached by a
  project edge appear as outlined ghost nodes and open in their own space; the rest of the shared space is never
  loaded.
- **Two entry points**: the whole project by default; `?focus=<handle>&depth=1|2` (default 2) shows one item's
  neighbourhood, reached from an "Open in map" button on the item page.
- **Defaults and filters**: lifecycle active+stale, superseded and deprecated hidden, all spaces, all kinds.
  Toggles for spaces, kinds, lifecycle, include superseded, unlinked only; a text filter highlights matching
  nodes. All state lives in the URL (`useSearchParamsState`).
- **Interaction**: click a node for a side card (title, badges, degree, links, suggested links, "Add relation"
  reusing RelationDialog, "Open item", "Focus here"). No drag-to-link; edge removal stays on the item page.
- **Rendering**: `d3-force` (exact pin, release-age checked) is the only new dependency; the layout is a pure
  function with unit tests; React renders SVG with the existing CSS tokens; pan and zoom are hand-rolled.
  Node cap 1,500 with a `truncated` notice that tells the user to narrow the filters.
- **Graph endpoint**: `GET /api/v1/projects/:slug/graph` returns nodes (lean ItemSummary subset plus degree) and
  edges (`id, kind, src, dst, dst_ref, editable`) under the same visibility rules as the per-item edges
  endpoint; `focus` and `depth` select the neighbourhood mode. Adds an `edges(project_id)` index.
- **Link health**: the endpoint reports degree per node and the dangling count; the map gets "unlinked only";
  the dashboard shows one line (items without links, dangling references) that links to the map.
- **Related items**: a new `GET .../items/:ref/related` ranks unlinked items by embedding cosine (best chunk,
  the project's active model) across the four spaces of the project plus `_shared`, excluding the item itself
  and already-linked, superseded, deprecated and archived items. The minimum cosine is a per-project setting
  (default 0.70), always below the duplicate threshold. Computed on demand, nothing stored, no server-side LLM.
  Without a vector (embedding pending) it returns an empty list with a note.
- **Agent side**: `spoor_remember`, `spoor_decide` and `spoor_doc_write` reply with up to three related
  unlinked items and a ready `spoor_relate` hint; `spoor_decide` and `spoor_doc_write` gain `relations`;
  create replies echo linked edges as update does; every `relations` argument describes the four kinds;
  `spoor_get` prints short titles next to link handles and a `see also` line of related unlinked items, and
  gains `depth` (0–2, default 0) that appends a token-capped `graph:` block. The tools/list budget (3,500
  tokens) and the server instructions may grow modestly if needed (owner, 2026-10-21).
- **Guidance**: a Links section in the agent guide (direction convention, when to use each kind); the server
  instructions gain one sentence if the budget allows. The AGENTS.md block and the Stop hook are unchanged.
- **Web**: "Suggested links" in the item page's Links panel with one-click "link as …"; the same list feeds
  the map's side card.
- **Out of scope**: stored suggestions or a suggestion job, drag-to-link, anchor or file nodes, loading the
  whole shared space, changes to the AGENTS.md block or the Stop hook.
- **Done when**: server integration tests (graph, related, depth walk, visibility), MCP format tests, web
  tests (map page, side card, suggested links, dashboard line), one Playwright spec that renders the map,
  docs updated (user guide, agent guide, api.md, web-ui.md, mcp.md, search-and-digest.md, ARCHITECTURE.md,
  CHANGELOG), version 0.4.0 across the five package.json files, full local CI green. Not committed; the owner
  reviews first.

Recorded in ADR-0021 (graph view) and ADR-0022 (link suggestions), refined by ADR-0023 (the related-item floor
setting) and ADR-0024 (the tools/list budget of 4,000 estimated tokens).

## Amendment (2026-11-26): v0.8 Backups

Agreed 2026-11-26 between the owner (Ladislav Soukup) and Claude after a grilling session. Owner decisions: a hybrid
mechanism (pg_dump plus per-project export zips); every feature below ships in 0.8.0; the raw `database.dump` is not
downloadable through the web UI; the Markdown zip is flat, re-importable and has a root `README.md` index; scheduled
backups are off until an instance admin enables them (the form is prefilled with 3 × 24 h and 2 × 7 d). Amends
"Postgres is the only state" for operators: the backup directory is state outside Postgres, on purpose (ADR-0038;
ADR-0020 stands, no attachment storage).

- **Backup bundle**: `<SPOOR_BACKUP_DIR>/backups/<id>/`, id `YYYYMMDDTHHMMSSZ-auto|manual|pre-restore` (checked on
  every route). It holds `database.dump` (pg_dump custom format of schemas `public` and `drizzle`, without the data of
  sessions, device codes, the request log and resource samples), one `projects/<slug>.zip` per project including
  `_shared` (the existing `spoor-export/1` archive, history kept unless over the cap; a busy project is retried and then
  recorded as skipped), and `backup.json` (`spoor-backup/1`: versions, migrations, files with sha256, projects,
  pinned, verified_at). Written under `.tmp/`, checked for free space, verified (pg_restore reads the dump, sha256),
  fsynced, then renamed into place. The directory is the catalog (no table), so a database restore cannot rewind the
  list. The pg client tools run with the connection in PG* environment variables only and data through pipes only.
- **Image**: `postgresql-client-17` from the PGDG apt repo, `/var/lib/spoor/backups` owned by `node`; compose mounts
  the named volume `spoor-backups` there. New env: `SPOOR_BACKUP_DIR` (unset = backups unavailable),
  `SPOOR_PG_BIN_DIR`. Missing tools or a server newer than the tools make backups "unavailable"; the app still runs.
- **Schedule and retention**: table `instance_settings` (key `backup`): enabled, time (UTC), 1 to 3 tiers
  (`24h | 48h | 7d`, keep 1 to 90), per-project archives on or off. Job `backup` looks every 15 minutes whether a slot
  is due. Pruning runs only after a new backup is verified: per tier, the newest auto backup of each bucket until
  `keep` buckets are filled; manual backups, pinned ones, the newest good one and pre-restore backups younger than
  14 days are always kept. A failed run never prunes.
- **Full restore from the web UI** (instance admin, cookie only): prepare (checks, warnings, a 5-minute token and a
  phrase such as `RESTORE 2026-11-20 03:00`), then confirm with the phrase and the admin's password. A pre-restore
  backup is made first; a maintenance gate answers 503 `maintenance` everywhere except `/healthz` and the restore
  status; the restore is one `psql -1` transaction (prelude drops the app's objects, epilogue clears sessions and
  re-applies token revocations, and an audit row proves the commit); startup steps run again; everyone logs in again.
  Refused when another app instance is connected or the backup is newer than the server.
- **Single project from a backup** (instance admin): from `projects/<slug>.zip`, never the dump. As a copy (new ids,
  slug `<slug>-r<YYYYMMDD>`, a "Restored copy" banner from `projects.restored_from`) or by overwrite (password and the
  typed slug, a safety archive first, then delete and re-import in one transaction; members, tokens and settings stay;
  not for `_shared` in 0.8).
- **Async Markdown zip** (live project or from a backup): table `export_tasks`, an in-process runner, job `exports`
  for leftovers and expiry (24 h), at most 3 open tasks per user. The zip is flat and re-importable: root
  `README.md` index, then `memories/`, `decisions/`, `docs/`, `library/` with the export frontmatter.
- **Web**: `/admin/backups` (status, schedule form with a "keeps up to N backups" preview, list, restore dialog,
  projects-in-backup dialog), a "Prepare Markdown zip" section in project settings, the restored-copy banner.
- **Not in 0.8**: downloading `database.dump` from the web UI, overwriting `_shared` from a backup.

Recorded in ADR-0038 (bundle, pg client in the image, backup directory as state), ADR-0039 (atomic in-process
restore with a maintenance gate), ADR-0040 (`instance_settings` and tiered retention) and ADR-0041 (async export
tasks). Routes: [api.md](docs/design/api.md) §13.
