# Architecture

Status: implemented, 0.4.0 (2026-10-21). Written as the phase 1 design, then updated for the server (phase 2), the MCP endpoint, device login, install doc, repo mirror, CLI and hooks (phase 3), the web UI (phase 4), release documentation (phase 5), the library space (0.2), the agent request log (0.3) and the map and link suggestions (0.4). The contract is [BRIEF.md](BRIEF.md); the detailed designs are in
[docs/design/](docs/design/); terms are defined in [GLOSSARY.md](GLOSSARY.md). Where this file and a design file
disagree, the design file wins and this file gets fixed. Open questions for the owner: [docs/design/deviations.md](docs/design/deviations.md).

## 1. What it is

Spoor is a self-hosted, team-shared memory for coding agents and humans. Agents read and write it over MCP with very few
tokens; humans browse, edit and administer it in a web UI. One deployment (one app container plus Postgres) serves many isolated
projects and one org-wide **shared** space. Each deployment is single tenant, so a later SaaS is one container per client.

## 2. Components

```
                 Claude Code / other MCP client                       Browser (SPA)
                 ┌───────────────┬───────────────────┐                      │
                 │ hooks         │ MCP client        │                      │ cookie
                 │ (spoor CLI)   │                   │                      │
                 └───────┬───────┴─────────┬─────────┘                      │
          bearer REST    │   bearer MCP    │                                │
          /p/:slug/api/* │   /p/:slug/mcp  │                                │ /api/v1/*
                         ▼                 ▼                                ▼
 ┌────────────────────────────────────────────────────────────────────────────────────┐
 │ app container (Node 22, Hono)                       packages/server/src/           │
 │  app.ts ── guards (modules/auth: cookie | bearer) ── module routes ── JSON 404     │
 │    ├─ mcp ── /p/:slug/mcp: Streamable HTTP, sessions bound to their token, nine    │
 │    │         tools delegating to the items and search services                     │
 │    ├─ device ── RFC 8628 code/token (public) + lookup/approve/deny (cookie)        │
 │    ├─ install ── public install.md / install.json                                  │
 │    ├─ mirror ── bearer activity (Stop nag), adr/push, docs/push                    │
 │    ├─ auth, projects, tokens, audit  users, sessions, invites, permission matrix,  │
 │    │                                 projects + settings, tokens, audit log        │
 │    ├─ items ── item service, revisions (append-only), edges, wikilinks, resolver,  │
 │    │           repo mirror (push, adr/import), project graph (graph.ts), related   │
 │    ├─ search ── chunker, providers (local ONNX e5-small q8 | OpenAI | Voyage),     │
 │    │            hybrid FTS+vector RRF, dedupe, related items (related.ts),         │
 │    │            digest (6 tiers), anchor matcher                                   │
 │    ├─ jobs ── scheduler (in process, DB leases): cleanup, embed-pending, reembed,  │
 │    │          purge-ephemeral; review queue, dashboard, undrafted, job status      │
 │    ├─ requests ── agent request log (MCP tool calls, bearer REST), 14 days        │
 │    ├─ transfer ── export / import (zip, lossless or Markdown folder)               │
 │    └─ healthz, instance, SPA static files (packages/web build); any other unknown  │
 │       API path or method is a JSON 404                                             │
 │  runtime.ts ── binds the ports: EmbeddingRegistry + SearchPort (search module),    │
 │                JobsPort (jobs scheduler); startup steps 3-8, graceful shutdown     │
 └───────────────────────────────────────┬────────────────────────────────────────────┘
                                         ▼
                      Postgres 17 + pgvector 0.8.7 (+ unaccent)  ──  named volume
```

How the server modules depend on each other (arrows = "calls through"; nothing imports another module's
internals, only its `index.ts` or a port):

```
 items ──SearchPort──▶ search (prepare/index chunks, dedupe, related candidates)     items ──JobsPort──▶ jobs (nudge embed-pending)
 transfer ──SearchPort──▶ search (NULL-embedding chunks in the import tx) projects ──JobsPort──▶ jobs (nudge reembed)
 jobs ──SearchJobs + BatchContext (ports.ts)──▶ search (embed-pending, reembed, consistency sweep)
 search, projects, transfer ──EmbeddingRegistry──▶ providers built by search (createEmbeddingRegistry)
 transfer ──▶ items (field cleaners, snapshot, ItemSummary)    review, search ──▶ items summaryJson (one ItemSummary)
 mcp ──▶ items (ItemService, incl. graph walk and related items) + search (SearchService, ContextService)    mirror ──▶ items (PushService)
 device ──▶ tokens (mintToken)    install ──▶ projects (default digest budget)
 every module ──▶ @spoor/shared (anchors, wikilinks, frontmatter split/serialize, known keys, ITEM_LIMITS)
 every module ──▶ auth guards, projects access
```

| component | responsibility | design |
|---|---|---|
| REST API | everything the SPA, CLI and hooks need | [api.md](docs/design/api.md) |
| MCP server | the nine agent tools, per-session client name, role-aware tool list | [mcp.md](docs/design/mcp.md) |
| Auth | scrypt passwords, DB sessions, per-user and service tokens, device login, origin check, shared-space rules | [auth-and-security.md](docs/design/auth-and-security.md) |
| Data model | 15 tables, handles, frontmatter, ADR numbering, export format | [data-model.md](docs/design/data-model.md) |
| Search and digest | chunking, providers, RRF, dedupe, related items, token estimator, `spoor_context`, anchors | [search-and-digest.md](docs/design/search-and-digest.md) |
| Export and import | zip export, lossless and Markdown-folder import, zip hardening | [data-model.md](docs/design/data-model.md) §8, [api.md](docs/design/api.md) §9 |
| Cleanup and jobs | lifecycle (stale, archived), observation expiry, review queue, scheduler | [cleanup-and-jobs.md](docs/design/cleanup-and-jobs.md) |
| CLI and hooks | `spoor` commands, three hooks, ADR drafting, install doc | [cli-and-hooks.md](docs/design/cli-and-hooks.md) |
| Web UI | pages, editor, diff, review queue, admin, map of the links | [web-ui.md](docs/design/web-ui.md) |
| Deployment | Dockerfile, compose, env vars, CI, backup | [deployment.md](docs/design/deployment.md); operator guide [docs/operations.md](docs/operations.md) |
| Guides | what users and agents see | [user-guide.md](docs/user-guide.md), [agent-guide.md](docs/agent-guide.md) |

Boundaries worth remembering:
- **Postgres is the only state.** The app is stateless except for the embedding model baked into its image and in-memory MCP sessions (lost on restart, clients re-initialise).
- **Three auth surfaces, never mixed**: cookies on `/api/v1`, bearer tokens on `/p/:slug/mcp` and `/p/:slug/api`, public device and install endpoints.
- **No server-side LLM calls.** ADR drafting runs on the developer's machine through the user's own `claude` login; link suggestions are nearest neighbours over the stored embeddings, computed per request and never stored (ADR-0022).
- **Spoor never writes to the repo from the server.** The CLI pushes repo files to Spoor; nothing is pulled back.
- **The shared space is a special project row** (`kind='shared'`, slug `_shared`), so every code path is reused; its write rules (humans only, `IA` or `shared_editor`) are enforced server-side.
- **One composition root.** `src/runtime.ts` is the only place that binds real implementations to the ports of `src/ports.ts`; `src/index.ts` only reads env, opens the pool and the HTTP server, and calls it. Open drift from the design is listed in [deviations.md](docs/design/deviations.md) §G and §H.

## 3. Key flows

Flows 3.1, 3.2 (over MCP), 3.4 and 3.5 are walked end to end, with the built CLI against the real server, by
`packages/server/test/e2e/harness.e2e.test.ts` (BRIEF.md DoD 2 and 3); flows 3.3, 3.6 and 3.9 from the browser by `packages/web/e2e/fullstack.spec.ts` (DoD 4), and flow 3.10 by `packages/web/e2e/graph.spec.ts`. Evidence per Definition-of-done item: [docs/design/dod-status.md](docs/design/dod-status.md).

### 3.1 Agent session start
1. Claude Code starts a session and runs the SessionStart hook command `spoor init` wrote (`command -v spoor … && exec spoor hook session-start`, falling back to a pinned `npx spoor-memory@<server version>`) with `{session_id, source}` on stdin. `resume` and `fork` print nothing.
2. For `source` = `startup`, `clear` or `compact` the CLI writes `.spoor/session/<id>.json` (kept on `compact`), and collects anchors from git
   (uncommitted, untracked and recently committed files, at most 80). Everything runs under one 7 s deadline and a 5-minute circuit breaker after a network failure.
3. It calls `GET /p/<slug>/api/context?file=…` with the token from `SPOOR_TOKEN` (set by `.claude/settings.local.json`), then, in the time left, replays queued pushes and sweeps the mirrored files for edits the Write/Edit hook missed.
4. The server authenticates the token (hash lookup, revocation, membership), builds the digest in six tiers (library, pinned, accepted decisions of the last 30 days, anchored,
   relevant to the query, recently verified) inside the token budget, and reads nothing that bumps `last_used_at`.
5. The CLI prints any open push conflicts or orphaned mirror files, then the digest, to stdout; Claude Code adds it to the context. The digest names itself as `spoor_context` output, so the agent does not fetch it again.
   On any failure it prints one line ("server unreachable") and exits 0.
6. The MCP client connects to `/p/<slug>/mcp` with the URL and `Authorization: Bearer ${SPOOR_TOKEN}` header of the committed `.mcp.json`. `initialize` creates a session bound to that token (idle 30 min, at most 20 per token) and is where the client name (`name/version`) is captured; the agent can now call `spoor_search`, `spoor_get`, and, with an editor or admin token, the write tools.

### 3.2 Agent remember (`spoor_remember`)
1. The agent calls the tool with `title`, `type`, optional body, anchors, tags. The request carries the bearer token and the MCP session id.
2. The server checks the token and the effective role (editor or admin); viewers never see the write tools.
3. It chunks the item and embeds chunk 0 (and the rest) before opening a transaction (20 s timeout; on failure the chunks are stored without vectors).
4. Near-duplicate check: cosine >= threshold (0.92) within the space, ignoring expired observations, observations when the new item is not one, and the item being superseded. A hit returns the existing item as a
   non-error `DUPLICATE` result and bumps its `last_used_at`.
5. Otherwise, in one transaction: insert the item (observations get `expires_at`), revision 1, chunks, wikilink edges, typed relations, audit row (`via=mcp`, client name, token owner).
6. The result is one short line, `OK created m58 r1 [fact]`, then one `note: linked …` per relation written and, after the commit, at most one `related:` line with up to three similar unlinked items and a ready `spoor_relate` hint (best effort: a failed lookup only drops the line). Updates carry the `revision` they read; a mismatch is `revision_conflict`, never last-write-wins. An update that also adds `relations` writes the edges in the same transaction (deviations.md H3).

### 3.3 Human edit (web UI)
1. The user opens an item (`/projects/:slug/i/:ref`), clicks Edit; the editor loads the item at revision N.
2. They change fields and body (CodeMirror with live preview) and save: `PATCH …/items/:ref` with `revision: N`.
3. The server runs the single-statement optimistic update plus revision snapshot, rewrites chunks and wikilink edges, audits it (`via=web`). A stale item becomes active again.
4. On `revision_conflict` the UI shows who changed it and offers compare, keep editing, save over their revision (explicit, still optimistic) or discard.
5. If the item mirrors a repo file, the save succeeds with a `mirrored_item` warning: the edit stays in Spoor and the next repo push is refused (`pushed_over_spoor_edit`) until a human forces it.

### 3.4 Device login
1. `spoor login --server … --project acme` first refuses if `.claude/settings.local.json` is tracked by git, then calls `POST /p/acme/device/code`; the server stores a hashed device code and an 8-letter user code (10 minutes; at most 10,000 live codes instance-wide, oldest pending evicted).
2. The CLI prints the URL and, separately, the code (and opens the browser). There is no pre-filled link, so a code cannot be phished with one click.
3. The user opens `/device`, logs in if needed, types the code, sees project, requester IP, age, their role and the self-reported client name, and presses Approve read-only, Approve or Deny (members of the project only).
4. Meanwhile the CLI polls `POST /p/acme/device/token` every 5 s (`slow_down` adds 5 s).
5. On approval the server consumes the code in one transaction, re-checks that the approver still has access, and mints a per-user project token (`spr_…`, stored as SHA-256, expires after 90 days; Approve read-only caps it at viewer, a plain Approve lets it follow the approver's live role); the plaintext is in this single response.
6. The CLI proves it with `whoami` (which also returns the expiry), writes `env.SPOOR_URL/PROJECT/TOKEN` into `.claude/settings.local.json` (mode 0600), adds that file and `.spoor/` to the repo `.gitignore`, and runs `spoor init`, which merges `.mcp.json`
   and the hooks into `.claude/settings.json`. It renders those blocks itself with `@spoor/shared` install.ts (the functions the server renders `install.json` and install.md with) from its own `SPOOR_URL`, the slug and the server version, so a compromised server cannot choose what lands in committed files. Nothing secret is committed; `.mcp.json` carries the literal server URL and references only `${SPOOR_TOKEN}`.

### 3.5 ADR push and draft
**Import and push (repo to Spoor):**
1. `spoor adr import` sends every `docs/adr/*.md` (batches) to `POST /p/<slug>/api/adr/import`; the server keeps existing numbers, renumbers collisions, continues numbering from the highest.
2. The CLI writes each assigned `spoor_id` back into the file's frontmatter (first key, body untouched), renames files the server renumbered, records bases in `.spoor/state.json`.
3. Later, the agent edits an ADR file; the PostToolUse hook (`Write|Edit`) runs `spoor hook post-tool-use`, which pushes only paths under `docs/adr/` and the configured doc list, silently. Edits made any other way are found by a
   local hash sweep at the next SessionStart and pushed then.
4. The server fast-forwards when nobody edited the item in Spoor since the last push; otherwise it answers `pushed_over_spoor_edit`, records `push_conflict_at`, and the CLI keeps the conflict in `.spoor/state.json`; it is shown at
   every session start, in `spoor status` and in the review queue until a human runs `--force` (TTY-confirmed) or aligns the file.

**Draft from memory:**
5. The agent records a decision with `spoor_decide`, which stores a decision memory only.
6. At the next Stop hook (every turn end), the CLI first decides whether to nag (below), then spawns a detached `spoor adr draft` (one at a time, `.spoor/draft.lock`) and returns at once. The drafting run calls
   `GET …/decisions/undrafted` (the owner's undrafted decisions of the last 14 days, oldest first; served by the jobs module next to the review lists) for decision memories without an ADR.
7. For each (at most 2 per run, 120 s deadline) it records the memory in `.spoor/state.json` first, runs the drafting command (default `claude -p --model haiku --safe-mode --no-session-persistence --tools ""`, with
   `SPOOR_DRAFTING=1`), validates the Markdown, falls back to a mechanical draft if needed, and picks the next number from max(local files, server next).
8. It writes `docs/adr/NNNN-slug.md` with CLI-built frontmatter (`status: proposed`, date, `drafted_from: [m59]`, the memory's title), pushes it, writes the `spoor_id` back and records the memory as drafted.
   The server adds a `drafted_from` edge and refuses a second ADR for the same memory (`already_drafted`). A `proposed` ADR stays out of the digest and the memory keeps
   representing it; when a human accepts the ADR (edits `status:` in the file, which is pushed), the memory leaves the digest and the ADR takes its place in the decision tier.

**The one nag:** if files other than the mirrored ADR/doc files changed in this session, nothing was written to Spoor by this token (MCP writes or CLI pushes, `GET …/activity`) and no `.nagged` marker exists, the Stop hook prints one
`{"decision":"block","reason":"…"}` and writes the marker first; the next Stop proceeds normally.

### 3.6 Cleanup
1. The scheduler starts with the server (first tick 30 s after ready, then every 60 s plus 0–10 s jitter); each job takes a database lease with one conditional `UPDATE`, so two containers never run the same job twice.
   A write that wants a job soon (`embed-pending` after a failed embedding, `reembed` after a provider change) nudges it through `JobsPort.enqueue`; an instance admin can also start one (`POST /api/v1/jobs/:name/run`).
2. Hourly `cleanup`, per project (including shared), in one transaction: observations past `expires_at` → archived (`expired`); unverified and unused memories older than `stale_days` (30) → stale;
   stale for `archive_days` (90) and not used within `stale_days` → archived (`stale`). Pinned items never go stale (pinning verifies). Each transition and its audit row are one statement.
   A project whose transaction fails is rolled back and skipped; the others are still cleaned and the run ends as `error`. The same job then runs the search module's chunk consistency sweep (§3.7 step 4).
3. Reads already hide expired observations at once; the job only records the state.
4. Humans handle the review queue: verify, edit, supersede, archive, restore (an expired observation must be promoted to a fact first), delete (project admin only). Decisions and docs never expire.
5. `purge-ephemeral` removes expired sessions, old device codes, spent invites and old job rows. Nothing else is ever deleted automatically.

### 3.7 Re-embed
1. Trigger: a project admin changes `embedding.provider`, or at startup the default provider's tag differs from a project's `embedding_model`. The project gets `embedding_target = newTag`.
2. The `reembed` job (every minute, lease renewed per batch) creates the target's partial HNSW index if missing, then re-chunks and embeds items 16 at a time into chunks tagged with the new model.
   New writes meanwhile build chunks for both the active and the target model, reading the model set under `FOR SHARE` on the project row (NULL-embedding chunks for any model they could not embed), so the job converges and the
   cut-over cannot strand an item.
3. Search keeps using the active model throughout and ignores vectors of any other model. Exception: after a **default-model upgrade** the image no longer carries the old weights, so affected projects search full-text only
   (`vector search unavailable (re-embedding)`) until the cut-over (ADR 0003).
4. When no item lacks target chunks and no target chunk is still un-embedded, one transaction under a row lock re-checks and sets `embedding_model = target, embedding_target = NULL`: search switches atomically. An hourly
   sweep re-chunks any item that has no active-model chunk at its current revision.
5. Old-model chunks are deleted in batches; if no project uses the old tag, its index is dropped. Progress shows in `GET /api/v1/projects/:slug/jobs` (the settings page). Every step can be re-run after a crash.

### 3.8 Startup and shutdown
1. `src/index.ts` reads env (exit 1 on any error), builds the runtime (`src/runtime.ts`: provider registry, scheduler, search module, ports) and the app, and listens at once; every route but `/healthz` answers 503 `starting`.
2. `startup()` runs deployment.md §4 steps 3 to 8: `SELECT 1` (`db: ok`), extensions and migrations (`migrations: ok`), the `_shared` row on the default provider and the `job_locks` seed, the bootstrap admin, the
   default provider's `ready()` (`embedding: ok`, or `failed` and a retry), the embedding-target sync (projects on another tag get `embedding_target` and `reembed` is nudged), then the scheduler starts and the
   server turns ready. A failed step is retried every 2 s, at most 30 times; a missing extension or bootstrap env exits at once.
3. On SIGTERM the MCP sessions are closed (and their sweep stopped), then the HTTP server closes and the scheduler stops together (running jobs are aborted and get up to 25 s, unfinished ones release their lease), the pool ends; a hard exit
   follows after 35 s (compose allows 40 s).

### 3.9 Export and import
1. `GET /api/v1/projects/:slug/export` builds the zip in one `REPEATABLE READ` transaction on the request thread: `manifest.json`, one Markdown file per item, `revisions/<id>.jsonl`, `audit.jsonl`; labels only, never user ids.
2. `POST /api/v1/projects/import` (instance admin, new project) or `POST …/:slug/import` (project admin, empty project) reads the multipart upload under a 50 MB cap, inflates each entry under its declared size with
   path, entry and total caps, verifies every file's hash, and writes everything in one transaction (ids, numbers, revisions, edges and counters kept, or remapped; history marked `via='import'`).
3. The same transaction writes every imported item's chunk rows with NULL embeddings (through `SearchPort`), so full-text search finds them at once; after the commit `embed-pending` is nudged and fills the
   embeddings. A folder import also claims the target project's existing wikilinks to the new items.

### 3.10 Map and link suggestions (ADR-0021, ADR-0022)
1. The SPA's Map page (`/projects/:slug/graph`, `pages/graph/`, its own lazy chunk) calls `GET …/graph` with only the non-default filters. `modules/items/graph.ts` selects the visible edges in SQL (the per-item edges rules; the filter predicate as a SQL expression), walks the neighbourhood breadth-first when `focus` is set, then counts degrees, applies `unlinked` and the 1,500-node cap and orders the result in process.
2. The browser lays the nodes out with `d3-force` in `lib/graphLayout.ts` (pure functions, unit-tested) and draws SVG; pan and zoom change only the view box.
3. Selecting a node opens a side card; its "Suggested links", like the item page's, come from `GET …/items/:ref/related`: `ItemService.related` resolves the item and calls `SearchPort.relatedCandidates` (`modules/search/related.ts`), a per-probe-chunk kNN over eligible chunks of the active model with the project's floor. "Link" is the ordinary `POST …/edges`, after which the edges, map, suggestions and dashboard queries refresh.
4. Agents get the same data as text: `related:` after a write, `see also:` and, with `depth`, a `graph:` block in `spoor_get` ([mcp.md](docs/design/mcp.md) §4, §5).

## 4. Package layout (pnpm monorepo)

```
spoor-memory/
  packages/
    shared/    types, zod schemas (settings, project/auth API, CLI config), slugify, token estimator, error codes, the anchor normaliser/validator/matcher (anchors.ts), frontmatter split/serialize (markdown.ts), the known-key table and ITEM_LIMITS (frontmatter.ts), the wikilink grammar and resolution order (wikilinks.ts), ItemSummary and the graph and related-item shapes (api/items.ts), the settings schema with `relatedMinCos` (settings.ts), the repo integration blocks of install.json and `spoor init` (install.ts), the review and undrafted-decision shapes (api/review.ts); the item request schemas still live in the server (deviations.md G5)
    server/    Hono app, Drizzle schema + migrations (src/db/migrations, copied to drizzle/ by `pnpm build` for the image), modules auth, projects, tokens, audit, requests, items (incl. graph.ts, the project graph), search (incl. related.ts, related items), jobs, transfer, device, install, mirror, mcp, scripts/fetch-model.mjs
      src/{config.ts, index.ts, app.ts, runtime.ts, ports.ts, db/, lib/, modules/<name>/{service,routes,index}.ts}   test/ (integration harness, e2e/ walk of DoD 2 and 3)
    web/       React SPA (src/{api,ui,components,pages,lib}; conventions in packages/web/README.md; the map in pages/graph/ with its layout in lib/graphLayout.ts), builds to dist/ served by the server
    cli/       npm package `spoor-memory`, bin `spoor`: src/{bin,cli,commands,ctx,config,http,state,mirror,writeback,settings-files,git}.ts, cmd/{setup,info,mirror,draft,session}.ts; published as one esbuild bundle dist/bin.js with `shared` compiled in (scripts/build.mjs, ADR 0013; layout in packages/cli/README.md)
  docs/        operations.md, user-guide.md, agent-guide.md; research/, design/ (incl. deviations.md, dod-status.md, harness-verification.md), adr/
  Dockerfile  docker-compose.yml  deploy/{Caddyfile,initdb/}  .env.example  .github/workflows/{ci.yml (lint, unit, integration, e2e-server, e2e-web, image build), release.yml (v* tags: version check, CI, npm publish with provenance, GHCR image; ADR 0013)}
  BRIEF.md  ARCHITECTURE.md  GLOSSARY.md  README.md  CHANGELOG.md  LICENSE
```
Dependencies point one way: `web`, `server` and `cli` depend on `shared`; `server` never imports `web` or `cli`; the CLI talks to the server only over HTTP.
Inside the server, domain modules (`src/modules/auth`, `projects`, `tokens`, `audit`, `requests`, `items`, `search`, `jobs`, `transfer`, `device`, `install`, `mirror`, `mcp`) code against the interfaces in `src/ports.ts`
(`EmbeddingProvider`, `SearchPort`, `JobsPort`, `SearchJobs` with its `BatchContext`) and the helpers in `src/lib/` (errors, transactions, `AuthContext`, audit), never against
each other's internals; the convention and the test harness are described in [packages/server/README.md](packages/server/README.md) and
[ADR-0011](docs/adr/0011-server-modules-and-ports.md).
Who may do what is one pure function, `can(principal, action, target)` in `modules/auth/permissions.ts` (the matrix of
[auth-and-security.md](docs/design/auth-and-security.md) §7, tested row by row); visibility of a project (404 for non-members) is
`loadProjectAccess` in `modules/projects`, and every item id, handle or slug goes through the one project-scoped resolver in
`modules/items/resolve.ts`.
Workspace names: `@spoor/shared`, `@spoor/server`, `@spoor/web`, and `spoor-memory` for the CLI.

## 5. Where decisions live

Design files (the *what*): [docs/design/](docs/design/). Research the choices rest on: [docs/research/](docs/research/). Open deviations and interpretations: [deviations.md](docs/design/deviations.md).

### 5.1 ADRs (`docs/adr/`, MADR style, with date and deciders; index in [docs/adr/README.md](docs/adr/README.md))

| # | file | title | records | source |
|---|---|---|---|---|
| 1 | [`0001-stack.md`](docs/adr/0001-stack.md) | Stack: Hono, Drizzle, React/Vite, MCP SDK, pnpm monorepo, Node 22, pinned versions | stack and pins | research/server-stack, web-stack |
| 2 | [`0002-postgres-pgvector.md`](docs/adr/0002-postgres-pgvector.md) | Postgres with pgvector as the only store | one database for items, full text, vectors, jobs, sessions; pinned image (D3); append-only revisions with purge bypass (I6, I7); untyped vector with per-model HNSW (D1) | data-model |
| 3 | [`0003-local-multilingual-embeddings.md`](docs/adr/0003-local-multilingual-embeddings.md) | Local multilingual embeddings with a re-embed job | e5-small q8 baked in the image (D4), pluggable providers, model tags, atomic re-embed (`FOR SHARE`/`FOR UPDATE` protocol), FTS-only search during a default-model upgrade (I36), hybrid RRF search, dedupe threshold (D6) | search-and-digest |
| 4 | [`0004-memory-model-three-spaces.md`](docs/adr/0004-memory-model-three-spaces.md) | Memory model: memories, decisions and docs | three spaces, handles (I2), typed edges, wikilinks, supersede chain, lifecycle, observations, digest tiers | data-model, cleanup |
| 5 | [`0005-shared-space-human-only-writes.md`](docs/adr/0005-shared-space-human-only-writes.md) | Shared space is a special project, written only by humans | `kind='shared'` row (I1), read by every token, `IA` or `shared_editor` write, server-side `read_only_space` | auth |
| 6 | [`0006-tokens-and-device-login.md`](docs/adr/0006-tokens-and-device-login.md) | Per-user tokens and device login, no secrets in git | `spr_`/`sprs_` hashed tokens, RFC 8628 adaptation without a pre-filled link and with 90-day device tokens (I33), scrypt, cookie sessions and origin check, reset invites, settings.local.json, the tracked-file guard and `.gitignore` (D5), token origin binding, MCP static bearer (D8), session-managed MCP, two database roles, memory content as untrusted data | auth, mcp |
| 7 | [`0007-cleanup-policy.md`](docs/adr/0007-cleanup-policy.md) | Cleanup policy: stale, archive, expire, human delete | exact predicates, `last_used` rules (I9), in-process scheduler with DB leases, nothing auto-deleted | cleanup |
| 8 | [`0008-client-side-adr-drafting.md`](docs/adr/0008-client-side-adr-drafting.md) | ADR drafting happens client-side | no server LLM calls, configurable command, `--safe-mode` and recursion guard (D2), detached run after Stop, drafts as `proposed` (I34), one ADR per memory (`already_drafted`), validation and fallback, number selection | cli-and-hooks |
| 9 | [`0009-repo-mirror-push-only.md`](docs/adr/0009-repo-mirror-push-only.md) | Repo mirror is push-only | import once, push on change, `spoor_id` write-back, fast-forward rule and `pushed_over_spoor_edit` (I3), MCP edits of mirrored items rejected (I4), docs identity by path (I27) | data-model, cli-and-hooks |
| 10 | [`0010-hooks-integration.md`](docs/adr/0010-hooks-integration.md) | Claude Code integration through hooks and a committed `.mcp.json` | SessionStart digest with git anchors and mirror sweep, PostToolUse push, Stop (single nag, detached drafting, per-turn semantics I26), circuit breaker, `spoor init` from `install.json` (I35), `alwaysLoad` with the measured tool-list size, install.md with curl first (D7) | cli-and-hooks |
| 11 | [`0011-server-modules-and-ports.md`](docs/adr/0011-server-modules-and-ports.md) | Server code is organised as modules behind ports | module convention, `ports.ts`, one composition root (`runtime.ts`) | server README |
| 12 | [`0012-authority-and-write-ordering.md`](docs/adr/0012-authority-and-write-ordering.md) | Delegated authority is re-checked at use; item writes lock the project row first | invites and other delegated authority end with their source, one lock order for item writes | phase 2 review |
| 13 | [`0013-cli-packaging-and-release.md`](docs/adr/0013-cli-packaging-and-release.md) | The CLI is published as one esbuild bundle; a v* tag releases the npm package and the image together | esbuild bundle of `@spoor/shared`, one version for image and package (I30), `release.yml` | deployment, cli-and-hooks |
| 14 | [`0014-library-space.md`](docs/adr/0014-library-space.md) | Library space: per-project pages written only by humans | fourth space `library` with handle `L<n>`, `library_editor` member flag, one human-only rule shared with `_shared` (`humanOnlyZone`), digest tier 0 (≤ 15 %), link rule (outgoing links are human choices; no capture or takeover; no `conflicts_with` with non-library items), `SPL01`/`SPL02` backstops, the stated web-session boundary | auth, data-model, search-and-digest |
| 15 | [`0015-exclusive-memory.md`](docs/adr/0015-exclusive-memory.md) | Spoor is the agents' only memory by default (accepted) | project setting `memory.exclusive` (default true), the memory rule in the MCP instructions, the `AGENTS.md` block and the SessionStart check | mcp, cli-and-hooks, data-model |
| 16 | [`0016-keep-the-global-cli-install-…md`](docs/adr/0016-keep-the-global-cli-install-the-sessionstart-digest-warns-when-the-cli-version.md) | Keep the global CLI install; the SessionStart digest warns when the CLI version differs from the server's (proposed) | `Spoor-Server-Version` header, version warning in the digest | cli-and-hooks, api |
| 17 | [`0017-latest-image-follows-main.md`](docs/adr/0017-latest-image-follows-main.md) | The `latest` image follows `main`; version tags stay on `v*` releases (superseded by ADR-0019) | image tags | deployment |
| 18 | [`0018-agent-request-log.md`](docs/adr/0018-agent-request-log.md) | An agent request log, kept 14 days, readable by admins (accepted) | `request_log` table (migration 0005), the Request log page, dashboard agent activity | api, data-model, web-ui |
| 19 | [`0019-develop-image-follows-main.md`](docs/adr/0019-develop-image-follows-main.md) | `develop` follows `main`, `latest` follows the highest release (accepted) | image tags | deployment |
| 20 | [`0020-no-file-attachment-storage-…md`](docs/adr/0020-no-file-attachment-storage-in-near-versions-json-goes-in-doc-bodies-files-stay.md) | No file or attachment storage in near versions: JSON goes in doc bodies, files stay in the repo with anchors (proposed) | scope | BRIEF |
| 21 | [`0021-graph-view-…md`](docs/adr/0021-graph-view-one-project-wide-graph-endpoint-rendered-as-d3-force-svg-with-focus.md) | Graph view: one project-wide graph endpoint rendered as d3-force SVG with focus mode, read-only canvas plus side card (proposed) | `GET …/graph`, ghosts, the 1,500-node cap, `edges_project_idx`, `d3-force` 3.0.0, the Map page, dashboard link health | api, web-ui, data-model |
| 22 | [`0022-link-suggestions-…md`](docs/adr/0022-link-suggestions-are-computed-on-demand-from-existing-embeddings-nothing-stored.md) | Link suggestions are computed on demand from existing embeddings; nothing stored, no server-side LLM (proposed) | `GET …/items/:ref/related`, the kNN approximation, MCP `related:` / `see also:` / `graph:`, Suggested links in the web UI | api, search-and-digest, mcp, web-ui |
| 23 | [`0023-related-item-floor-…md`](docs/adr/0023-related-item-floor-lives-at-settings-dedupe-related-min-cos-0-50-0-90-default-0.md) | Related-item floor lives at `dedupe.related_min_cos` (0.50 to 0.90, default 0.70), clamped on read below the duplicate threshold (proposed) | `relatedMinCos` | data-model |
| 24 | [`0024-mcp-tools-list-budget-…md`](docs/adr/0024-mcp-tools-list-budget-raised-to-4-000-estimated-tokens-for-relations-on-all.md) | MCP tools/list budget raised to 4,000 estimated tokens for relations on all write tools and `spoor_get` depth (proposed) | the `tools.test.ts` ceiling, measured 3,932 | mcp |

[deviations.md](docs/design/deviations.md) §D lists nine slightly different topics (for example "session-managed MCP transport" and "in-process scheduler" as their own ADRs); the list above
folds those into ADRs 6 and 7. Every ADR records the owner's decision (Ladislav Soukup) and the date of the decision, per house rule. ADRs 0001 to 0014 and
the accepted ones after them are decided; the proposed ones (0016, 0020 to 0024; most drafted from decision memories by `spoor adr draft`) wait for the owner to accept them.

## 6. Cross-cutting rules

- **Append-only history.** `item_revisions` and `audit_log` reject UPDATE and DELETE except inside the human hard-delete and project-delete transactions.
- **Optimistic concurrency everywhere.** Content writes carry the revision they read; conflicts are errors the caller resolves.
- **Token economy.** Handles instead of uuids, one text block per MCP result, a digest that provably fits its budget, no JSON in agent output.
- **Never block the agent.** Hooks always exit 0, have short deadlines and a circuit breaker; server-down is a one-line notice; drafting runs in the background.
- **No secrets in git or logs.** Tokens, invite tokens, device codes and session ids are stored hashed; `.claude/settings.local.json` and `.spoor/` are gitignored by the CLI, which refuses to write a token into a tracked file
  and sends a token only to the origin stored with it; pino redacts credentials.
- **Project-scoped resolution.** Every id, handle, `spoor_id` and ref is resolved inside the caller's project (plus `_shared` for reads and link targets); a trigger stops edges from leaving `_shared`.
- **Human-only spaces.** `_shared` and `library` follow one rule (`humanOnlyZone`, applied by `assertWritable(caller, space)`): only a logged-in web session of a user who holds the right writes them (shared: instance admin or `shared_editor`; library: instance admin, project admin or `library_editor`); every MCP, CLI, token and bearer path answers `read_only_space`. The boundary is stated, not absolute: a browser-automation agent driving a logged-in session passes as the human ([ADR-0005](docs/adr/0005-shared-space-human-only-writes.md), [ADR-0014](docs/adr/0014-library-space.md)).
- **Memory is untrusted data.** Digest and `spoor_get` output say so in a fixed line, agent-written items are marked `~`, titles are single-line without control or bidi characters, imported history is marked, never attributed. Library pages are human-approved guidance agents are told to follow, but never a source of commands to run unconfirmed.
- **Dependency safety.** Every package or image is pinned and published at least three days before it was chosen ([deployment.md](docs/design/deployment.md) §9 and the research files).
