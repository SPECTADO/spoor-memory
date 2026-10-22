# Changelog

All notable changes. Format after Keep a Changelog; versions follow semver.

## [Unreleased]

## [0.5.1] - 2026-10-22

### Added

- The web sidebar ends with the versions, `Web 0.5.1 · Server 0.5.1`: the web build's own version (from its `package.json`,
  set at build time) and the server's (`GET /api/v1/instance`), so a stale browser bundle or a half-finished upgrade shows.

## [0.5.0] - 2026-10-22

### Changed

- **Near-duplicates no longer lose facts** (ADR-0025). The MCP write tools refuse a create (`DUPLICATE`, nothing saved) only
  when an item with the same title and body exists (case and whitespace ignored). A create that is merely similar is saved,
  and the reply adds `note: similar to m53 r1 cos=0.94 [fact] "…" · same claim → spoor_supersede old="m53" new_id="m65" · …`;
  that item is left out of the `related:` line. Before, every create at or above the threshold was refused, so an agent that
  ignored the reply lost the fact (a benchmark refused 3 of 10 genuinely different facts).
- **Different values are never duplicates**: when two similar texts each state a number, identifier, code span or quoted
  string the other lacks (`60` vs `600` requests/min), the web shows no near-duplicate warning, and MCP names the item only
  as `… but the values differ (60 vs 600) · replaces it → spoor_supersede …`.
- **Default `dedupe.threshold` is 0.87** (was 0.92), calibrated on the benchmark pairs with the shipped e5 q8 model:
  reworded duplicates score 0.878 to 0.957, so 0.92 caught 1 of 10. Projects that set a threshold keep it.
- `spoor_remember` and `spoor_decide` tool descriptions say when `DUPLICATE` happens; the request log records `similar` and
  `similar_values_differ` for creates saved next to a similar item.

## [0.4.0] - 2026-10-21

### Added

- **Map page** (ADR-0021): `/projects/:slug/graph` and `/shared/graph`, nav entry "Map" after Library, for every role. Items are
  nodes (shape by space, size by number of links), the seven link kinds are styled edges, a `[[ref]]` to nothing is a hollow node,
  and items outside the filters or in another space appear as dashed ghosts. Filters for spaces, link kinds, lifecycle, superseded
  and "Unlinked only", a text highlight, a legend, focus mode (`?focus=<handle>&depth=1|2`, "Open in map" on the item page), a list
  view, keyboard pan and zoom, and a side card with links, suggested links, "Add relation", "Open item" and "Focus here". All state
  is in the URL. At most 1,500 items, with a notice when the map is cut short. New web dependency `d3-force` 3.0.0 (exact pin),
  loaded only by the map chunk.
- **Graph endpoint** `GET /api/v1/projects/:slug/graph` with `spaces`, `kinds`, `lifecycle`, `include_superseded`, `unlinked`,
  `focus` and `depth`; returns nodes with degrees and a ghost flag, edges (`id, kind, src, dst, dst_ref, editable`) and `meta`
  (`truncated`, `node_cap`, `total_nodes`, `unlinked_count`, `dangling_count`). Same visibility as the per-item edges endpoint.
- **Related items endpoint** `GET /api/v1/projects/:slug/items/:ref/related?limit=1..20` (ADR-0022): unlinked items ranked by the
  best-chunk embedding cosine under the project's active model, over the project's four spaces plus `_shared` on the same model;
  the item itself, linked, archived, superseded, deprecated and expired items are excluded inside the nearest-neighbour search.
  Computed on demand, nothing stored, no LLM; `note: embedding pending…` while the item has no vector.
- **Suggested links** in the item page's Links panel and the map's side card: up to 5 related items with their similarity, a kind
  choice and one-click **Link** for people who can add relations.
- **Dashboard link health**: `links: { unlinked_items, dangling_refs }` in the dashboard response and one line such as
  `12 items without links · 3 dangling references` that opens the map (with "Unlinked only") or the whole map; hidden when both
  are 0.
- **Project setting** `dedupe.related_min_cos` (ADR-0023): the minimum similarity of a suggestion, 0.50 to 0.90, default 0.70,
  "Related items minimum similarity" in the Duplicates section. It is always read at least 0.01 below the duplicate threshold.
- **MCP**: `spoor_decide` and `spoor_doc_write` take `relations` like `spoor_remember` (at most 10); create replies echo
  `note: linked <kind>→<handle>`; after a create or a content-changing update the three write tools add a `related:` line of up
  to 3 similar unlinked items with a ready `spoor_relate` hint; `spoor_get` adds a `see also:` line (up to 3) and a `depth` input
  (0 to 2) that appends a `graph:` block of the neighbourhood, capped at about 400 tokens with `+N more edges`.
- A **Links** section in the agent guide: direction, when to use each kind, and how to act on the hints.
- Migration `0006_edges_project_idx`: an index on `edges(project_id)`.

### Changed

- `spoor_get`'s `links:` line prints a short title after each linked handle (`refines→m12 "Tokens are hashed"`), and `links:`,
  `see also:`, `related:` and `graph:` mark agent-written, unreviewed items with `~` after the handle, as the digest and
  `spoor_search` do.
- Every `relations` argument describes the four kinds: `refines = narrows or details, supports = evidence for, depends_on =
  requires, conflicts_with = contradicts (symmetric)`.
- The server instructions' recording sentence ends "link them to related items (relations, or spoor_relate)".
- The `tools/list` regression ceiling is 4,000 estimated tokens (was 3,500; ADR-0024). A writer's list is now 3,932 (was 3,440);
  the instructions are 317, or 402 with exclusive memory (were 291 and 376).
- Adding or removing a link in the web UI also refreshes the map, the suggestions and the dashboard.
- **Image tags** (ADR-0019, supersedes ADR-0017): `latest` is again the highest release, pushed only by a `v*` release that is
  the highest `vX.Y.Z` tag. The newest green commit on `main` is now `develop` (plus `sha-<short>`). Version tags are unchanged.

## [0.3.0] - 2026-10-21

### Added

- **Agent request log** (ADR-0018): every MCP tool call and every spoor CLI call is recorded with person, token, agent, read or
  write, tool or route, space, memory type, handles, query (200 characters), outcome and duration. Kept 14 days (`purge-ephemeral`).
  Project admins and instance admins read it on the new **Request log** page (`GET /api/v1/projects/:slug/requests`); other
  members get 403. New migration `0005_request_log`.
- Dashboard **Agent activity**: the last agent read and the last write, for every member (`last_requests` in the dashboard
  response).
- Dashboard **Connect** box for every member: the CLI install and `spoor login` commands with this server's URL and version, the
  install guide, token creation, and how to add a teammate or a project. It replaces the admin-only install hint.

## [0.2.0] - 2026-10-20

### Added

- **`latest` image from `main`** (ADR-0017): each push to `main` that passes CI publishes `ghcr.io/spectado/spoor-memory:latest`
  and `:sha-<short>`, once its server version's CLI is on npm. Releases still publish `x.y.z` and `x.y`, and move `latest` only
  when the tag is still `main`'s head.

- **Spoor is the agents' only memory** (ADR-0015): new project setting `memory.exclusive` (default on, editable in the web UI Settings
  page). When on, the MCP server instructions carry a rule that Spoor replaces every other memory store (Claude Code auto-memory,
  other memory MCP servers, memory notes in files) unless the user asks.
- `spoor init` writes a managed Spoor block to `AGENTS.md`, adds an `@AGENTS.md` import to `CLAUDE.md`, and, when exclusive, sets
  `autoMemoryEnabled: false` in an untracked `.claude/settings.local.json` (so `spoor login` turns Claude Code auto-memory off for that user).
- The SessionStart hook asks the user to run `spoor init` when `AGENTS.md` lacks the current block or `CLAUDE.md` does not import it,
  and repeats the rule until then. `install.json` gains `memory_exclusive`; the bearer `GET /p/:slug/api/context` sends
  `Spoor-Memory-Mode: exclusive|shared`.
- **Library space**: a fourth space in every project (and in `_shared`) for guides agents must follow, such as a graphics guide
  or coding conventions. Pages are written only by humans in the web UI, are `active` or `archived` (never stale, expiring,
  pinned or verified) and are read-only for MCP, CLI and tokens (`read_only_space`). Handle `L<n>` (`S:L<n>` for a shared page);
  slugs shaped `l<n>` are reserved. Recorded in [ADR-0014](docs/adr/0014-library-space.md).
- **`library_editor` member flag**: project admins grant the right to edit the library to any non-admin member, a viewer
  included. Admins always hold it. New permission action `library.write`; `ProjectJson.can_edit_library`; `counts.library` on the
  dashboard and project list.
- **Digest Library tier**: tier 0 lists every active library page (`L3 [lib] <title>`, with the matched anchor for own-project
  pages), at most 15 % of the budget; an overflow rolls up into one line. Projects without library pages get the same digest as
  before.
- Library pages link out to any item as a human choice at save time; `conflicts_with` with non-library items is refused, and
  capture or takeover of a library link by a later item is blocked (DB backstop `SPL01`; `SPL02` refuses library revisions via
  `mcp` or `cli`).
- Export and import carry `library/<slug>.md`; import normalises library rows and drops the refused edge kinds.
- **CLI version check**: the bearer `GET /p/:slug/api/context` sends `Spoor-Server-Version`, and when the installed CLI differs,
  the SessionStart digest asks the user to run `npm i -g spoor-memory@<server version>`, then `spoor init`.

### Changed

- `spoor_search` searches the library by default, and `space=library` is accepted; `spoor_get` takes `L<n>`.
- The member PUT body is `{ role?, library_editor? }` (at least one); POST accepts `library_editor`.
- Demoting an admin clears library editing unless the request sets `library_editor`.
- The review queue and cleanup never list library pages.
- The digest reserve now spans three tiers: library, pinned and decisions leave at least 35 % for anchored and relevant items
  (library at most 15 %, pinned 30 %, decisions 25 %).
- A slug read that matches both an own item and a `_shared` library page answers `ambiguous_id`.

### Upgrade notes

- Servers on 0.1.0 reject archives that contain library pages (`invalid_archive`); the export format stays `spoor-export/1`.
- Migration 0004 renames existing slugs shaped `l<n>` to `x-l<n>`. Body links written `[[l<n>]]` must be re-saved as
  `[[x-l<n>]]`; the migration reports their count in a NOTICE, which the server now writes to its startup log
  (`migration notice: library_guards: …`). See [docs/operations.md](docs/operations.md).

## [0.1.0] - 2026-10-20

First release. Scope is BRIEF.md (MVP) with its 2026-10-19 amendments; evidence per Definition-of-done item is in
[docs/design/dod-status.md](docs/design/dod-status.md).

### Added

- **Memory model**: three spaces per project (memories, decisions as numbered ADRs, docs), Markdown with YAML frontmatter,
  append-only revisions, `[[wikilinks]]`, typed edges, supersede chains, backlinks, observations with a hard expiry.
- **Shared space**: an org-wide space readable by every project token and written only by humans (instance admins and shared
  editors).
- **Search**: Postgres full text plus pgvector cosine fused by reciprocal rank fusion, chunking (about 400 tokens), a near-duplicate
  check on write (per-project threshold, default 0.92), local multilingual-e5-small (q8, in the image) with optional OpenAI and
  Voyage providers, and a re-embed job with atomic cut-over when the model changes.
- **MCP endpoint** `/p/<slug>/mcp` (Streamable HTTP, bearer tokens) with nine tools: `spoor_context`, `spoor_search`, `spoor_get`,
  `spoor_remember`, `spoor_decide`, `spoor_doc_write`, `spoor_supersede`, `spoor_relate`, `spoor_verify`; a budgeted five-tier digest
  (default 1,500 tokens); optimistic concurrency on every update; role-aware tool lists.
- **Auth**: local email and password, cookie sessions, invite links and reset invites (no email), instance admin, project roles
  admin, editor, viewer, `shared_editor`; per-user and service tokens (hashed, shown once); RFC 8628 style device login with
  90-day device tokens; `SPOOR_TRUST_PROXY` for the approval page's requester address.
- **`spoor` CLI** (`spoor-memory` package): `login`, `init`, `whoami`, `status`, `context`, `adr import|push|draft`, `docs import|push`,
  and three Claude Code hooks (SessionStart digest, PostToolUse push, Stop nag), client-side ADR drafting, repo mirror (push only).
- **Self-cleanup**: stale after 30 days unverified and unused, archived 90 days later (if not used meanwhile), observations expire,
  only humans hard-delete; a scheduler with database leases (cleanup, embed-pending, reembed, purge-ephemeral).
- **Web UI**: project list, dashboard with digest preview, space lists with filters, search, rendered Markdown, CodeMirror editor with
  live preview and a conflict dialog, revision history with diff, review queue (bulk actions), audit log, tokens, members, invites,
  settings, jobs, device approval page; English, responsive, light and dark.
- **Export and import** of a project or the shared space as a zip (manifest, Markdown files, revisions, audit log), lossless, with
  zip hardening; a folder of Markdown files can be imported too.
- **Deployment**: one multi-arch image plus `pgvector/pgvector:0.8.7-pg17`, `docker-compose.yml`, optional `caddy` profile for
  automatic HTTPS, configuration by environment (with `_FILE` variants for secrets), health endpoint `/healthz`.
- **Tests and CI**: Vitest unit and integration tests against a real pgvector Postgres, an end-to-end walk of the CLI against the
  real server, Playwright browser tests; GitHub Actions `ci.yml` runs lint, typecheck, unit, server integration, server e2e,
  Playwright e2e, the CLI package smoke test and the multi-arch image build.
- **Release** (ADR 0013): the `spoor-memory` npm package is one esbuild bundle (`@spoor/shared` compiled in, version from
  `package.json`, only `dist/`, README and LICENSE shipped); `release.yml` on `v*` tags checks that tag, server and CLI versions
  match, runs the whole CI, publishes the npm package with provenance and then pushes the multi-arch image to GHCR.
- **Documentation**: README, operations, user and agent guides, ARCHITECTURE, GLOSSARY, thirteen ADRs and the design set under
  `docs/design/`.

### Fixed
- Export size cap lowered from 500 MB to 200 MB and derived from the import cumulative cap, so every export can be re-imported (deviations G12).

- The CLI in a package directory below the git top level (its own `.claude/`) now reports changed files and session anchors
  relative to its root and writes root-prefixed `.gitignore` lines at the top level (deviations.md H11).
- Phase 5 review ([docs/design/review-log-phase5.md](docs/design/review-log-phase5.md)): the CLI no longer trusts server answers
  with file paths, ids or renumbers (import, push, renumber, write-back), renders the `spoor init` blocks itself instead of
  copying install.json, prints and opens only its own `/device` URL and strips terminal control characters; the default
  `SPOOR_IMAGE` is the valid local tag `spoor-memory:local` (Docker refused the old placeholder); a CI job runs the compose
  stack; bold-bullet ADR headers (`- **Status:** …`, `- **Date:** …`) are read on import and push; the token estimator is
  calibrated to Claude's tokenizer (Latin 1/2.2), so a 1,500-token digest really is about 1,500 tokens; the CLI's own
  automatic pushes no longer suppress the Stop nag, read-only logins get no nag; `spoor_remember` defaults `type` to `fact`;
  the review queue lists undrafted decisions; the import panel accepts a Markdown-folder zip into a project with items.

### Known limitations

- The npm package `spoor-memory` is not published before the first `v*` tag: a source-built server (version `0.0.0`) tells users
  to install the CLI from the checkout, and its SessionStart hook has no `npx` fallback (docs/operations.md §10).
- Voyage embeddings are verified against a fake only (G15). The Cursor, Codex and Gemini CLI snippets in the install doc are checked
  against the vendors' docs but not run against those clients; Claude Code was verified with a real `claude -p` run
  ([docs/design/harness-verification.md](docs/design/harness-verification.md)).
- Out of scope by design: SSO, email, graph visualisation (added in 0.4.0), server-side LLM calls, rate limiting, agent writes to the shared space,
  pulling ADRs or docs back into the repository.
