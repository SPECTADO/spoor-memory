# @spoor/server

The Spoor server: one Hono app on Node 22 serving the cookie API for the SPA (`/api/v1`), the bearer API
and MCP endpoint for agents (`/p/:slug/api`, `/p/:slug/mcp`), the public device and install endpoints, and
the SPA build. Behaviour is specified in [`docs/design/`](../../docs/design/); this file is about how the
code is organised.

## Layout

```
src/
  index.ts            process entry: config, pool, HTTP server, signal handling; calls runtime.ts
  runtime.ts          composition root: createRuntime() binds the real ports (provider registry, SearchService,
                      scheduler) and registers the search module's `jobs` (SearchJobs) with the scheduler, startup()
                      runs deployment.md section 4 steps 3-8, shutdown() stops scheduler + server, ends the pool
  app.ts              createAppModules() builds every module once; createApp({ports, modules, ...}): global
                      middleware, /healthz, /api/v1/instance, the guard chains, every module's routes (an unknown
                      API path or method is a JSON 404), error
                      mapping
  config.ts           typed env (zod), `<NAME>_FILE` secrets
  ports.ts            cross-module interfaces (see below), the job seam (SearchJobs, BatchContext, JobError,
                      LeaseLostError) and the NoopSearchPort placeholder
  types.ts            AppEnv (Hono context variables), ReadyState
  db/                 drizzle schema, migrations, migrator, pool
  lib/                small shared helpers, no business logic
    errors.ts         ApiError, the api.md error body, loggableError
    db.ts             Db / Tx / DbOrTx types, withTx, allowPurge (SET LOCAL spoor.allow_purge), lockProjectForWrite
                      (the content-write lock order: project row before item rows), pg error helpers, escapeLike
    auth-context.ts   AuthContext (user, project, role, via, tokenId, clientName), actorLabel, effectiveRole, capRole
    audit.ts          writeAudit(): the one way to append to audit_log
    validate.ts       readJson / readQuery (strict zod → 400 invalid_input), uuidOr404
    pagination.ts     cursor pagination (limit/cursor, next_cursor), decodeTypedCursor (every list: typed parts,
                      400 instead of a SQL cast error), cursorTimestamp
    crypto.ts         randomSecret, sha256 (what the DB stores for every bearer secret)
    semaphore.ts      bounded concurrency with a queue timeout
    client-ip.ts      SPOOR_TRUST_PROXY parsing and the client address (right-most untrusted X-Forwarded-For hop
                      behind a trusted proxy, else the TCP peer); the device flow's requester IP
    deps.ts           ServerDeps: { config, logger, db, ports }
  modules/<name>/     one folder per domain module:
    auth/             passwords, sessions, cookie guards, bearer guards (bearer.ts), the permission matrix (permissions.ts), invites, users
    projects/         projects + settings, memberships, project visibility (access.ts: loadProjectAccess), the `_shared` seed
    tokens/           API tokens (create, list, revoke, mintToken) and `GET /p/:slug/api/whoami`
    audit/            reading the audit log (project and instance level)
    items/            item service (create/update with revision check, pin, verify, archive, restore, delete,
                      supersede, edges, wikilinks, revisions), repo mirror (push.ts: push, adr/import), the
                      project-scoped id resolver (resolve.ts), frontmatter validation, revision snapshot and ADR
                      file conventions (markdown.ts), the field cleaners every write path uses (writes.ts), the one
                      ItemSummary serializer (rows.ts summaryJson), the review queue's bulk verify / archive
                      (`reviewBulk`, `POST …/review/bulk`)
    search/           chunker, embedding providers (providers/: local e5 q8, OpenAI, Voyage, registry),
                      SearchPort implementation, hybrid FTS+vector search (RRF), dedupe, digest (context.ts,
                      digest.ts), job functions (jobs.ts: embed-pending, reembed, target sync, consistency sweep,
                      all on the ports' BatchContext); routes: search, context (cookie + bearer). The anchor
                      matcher is @spoor/shared's anchors.ts
    jobs/             scheduler with DB leases (scheduler.ts, store.ts), job table (definitions.ts), cleanup
                      and purge jobs, lifecycle reference model, review queue (review.ts), the project dashboard
                      (dashboard.ts: counts, review counts, recent changes from the audit log), decisions/undrafted,
                      job status and the admin run trigger (status.ts); search-jobs.ts holds the handlers that
                      run SearchJobs and noopSearchJobs
    transfer/         export zip, lossless and Markdown-folder import (chunk rows written in the import
                      transaction), zip reader with hard caps; file content goes through @spoor/shared and the
                      items module's cleaners
    device/           RFC 8628 device login: public `code`/`token` (publicRoutes, `/p/:slug/device`), cookie
                      `device/lookup|approve|deny` (routes); user codes, client-name cleaning, the in-memory miss
                      lock (limiter.ts), the instance-wide row cap; mints through the tokens module's `mintToken`;
                      request schemas and response types from @spoor/shared (api/device.ts); requester IP via
                      lib/client-ip.ts
    install/          public install.md / install.json, rendered by pure template functions (templates.ts) from
                      server URL, slug, version and the project's default budget
    mirror/           bearer `activity` (the Stop hook's write count) and `adr/push` / `docs/push` (per-space forms
                      of the items module's `push`)
    mcp/              the agent endpoint `/p/:slug/mcp`: Streamable HTTP (SDK web-standard transport, JSON responses),
                      sessions bound to their token (sessions.ts: idle TTL, sweep, caps), own bearer auth and 1 MB cap
                      (routes.ts), role-aware tool list (server.ts), the nine tools' contract (tools.ts) and handlers
                      (handlers.ts) delegating to ItemService / SearchService / ContextService, text output (format.ts)
test/                 integration-test harness and the in-memory port fakes (see Tests)
```

## Module convention

Each domain module lives in `src/modules/<name>/` with at least:

| file | holds | may import |
|---|---|---|
| `service.ts` | business logic as classes or functions taking `ServerDeps` (and a `DbOrTx` when the caller owns the transaction). No Hono, no `Context`. Throws `ApiError` for every expected failure. | `lib/*`, `db/schema`, `ports.ts`, `@spoor/shared` |
| `routes.ts` | a factory `xRoutes(deps, services) => new Hono<AppEnv>()`: parse with `readJson` / `readQuery` (request schemas live in `@spoor/shared` when the SPA or CLI use them too), check the caller (`requireUser`, `requireInstanceAdmin`, project role helpers), call the service, return JSON. | its own service, `lib/*`, the guards exported by `modules/auth` |
| `index.ts` | the module's public surface: `createXModule(deps)` returning `{ name, routes, ...services }`, plus re-exports other modules may use. | its own files |

Further files (e.g. `invites.ts`, `sessions.ts`) are fine; other modules import only from a module's `index.ts`.
Modules never import each other's services directly when a port exists: they code against `src/ports.ts`.

Rules that hold everywhere:
- **Errors**: throw `new ApiError(code, { message?, hint?, details? })` with a code from `@spoor/shared`
  (`ERROR_STATUS`); `app.onError` renders `{error, message?, hint?, details?, request_id}` with the right
  status. Anything else becomes a logged 500 `internal` (query parameters are never logged).
- **Validation**: request objects are `z.strictObject` (unknown fields are 400 `invalid_input` with
  `details.issues`).
- **Transactions**: `withTx(db, async (tx) => …)`; throwing inside rolls back. Hard deletes of items or
  projects call `allowPurge(tx)` first (the only way past the append-only triggers). Lock order for item
  content writes: the project row first (`allocate` for creates, `lockProjectForWrite` otherwise), then item
  and edge rows; a check that decides a write (fast-forward, `already_drafted`, promotion on restore) is
  re-made inside the transaction on the locked rows.
- **Audit**: every mutation calls `writeAudit(tx, actor, entry)` in the same transaction.
- **One-line text** (titles, tags, names, client names) goes through `cleanLine` / `stripControl` from
  `@spoor/shared` on every write path.
- **Time** comes from the database (`now()`), not from `Date`, for anything compared in SQL.
- **Item fields** (title, body, tags, anchors, extras) go through the items module's cleaners on every write
  path, imports included; limits are `ITEM_LIMITS` of `@spoor/shared` (code points, like the DB CHECKs).
- **Cursors** are decoded with `decodeTypedCursor`; **job errors** stored in `job_runs` go through
  `jobErrorMessage` (no SQL or parameters in an API body).

Wiring: `createAppModules(deps, { scheduler, search })` (app.ts) builds every module once with the same
`deps`; `src/index.ts` passes the runtime's scheduler and search module so the routes and the ports share
one instance (tests call `createAppModules` on `test/ports.ts` stubs, see `test/http.ts`). `/api/v1` first runs the auth
module's guards (`cookieApiGuards`: Authorization header rejected, 1 MB JSON cap except the import upload,
origin check, session lookup), then the routes of auth, projects, tokens, audit, items, search, jobs and
transfer and device (`device/lookup|approve|deny`). Any other path is a JSON 404 (no 501 stubs remain,
deviations.md G16).
`/p/:slug/api` runs `bearerApiGuards` (token → `AuthContext` with the effective, capped role; 401
`invalid_token` with `WWW-Authenticate`, 403 `token_project_mismatch`; cookies ignored; then the 1 MB cap),
then the bearer routes (`whoami` from tokens, `push` and `adr/import` from items, `context` from search,
`decisions/undrafted` from jobs, `activity`, `adr/push` and `docs/push` from mirror). The public surfaces have no
guard chain: `/p/:slug/device` (device `publicRoutes`), `/p/:slug/mcp` (the mcp module brings its own bearer auth,
1 MB cap and error mapping; `src/index.ts` calls `mcp.close()` on shutdown) and `/p/:slug/install.md|json`.

Authorisation on every route follows one pattern:
- cookie project routes: `loadProjectAccess(db, requireUser(c), slug)` (404 for a project the caller cannot
  see, `_shared` visible to everyone logged in), then `access.assert(action)` (403 `forbidden`);
- bearer routes: `assertCan(bearerPrincipal(ctx), action, { shared })` (403 `forbidden_role` for a viewer or
  read-only token, `read_only_space` for any shared write);
- ids, handles and slugs from a request: `resolveItemRef(db, scope, ref)` from `modules/items`, never a bare
  `WHERE id = $1`.

### Ports (`src/ports.ts`)

| port | implemented by (bound in `src/runtime.ts`) | used by |
|---|---|---|
| `EmbeddingProvider`, `EmbeddingRegistry` | search module, `createEmbeddingRegistry(config)` (local ONNX always; OpenAI / Voyage when keyed) | search, projects (provider settings), transfer, `/api/v1/instance`, startup readiness |
| `SearchPort` (`prepareChunks`, `dedupeCandidates`, `indexItemChunks`) | search module, `SearchService` | item service and push, transfer (chunk rebuild after import), MCP tools later |
| `JobsPort` (`enqueue`) | jobs module, `Scheduler` | items (`embed-pending`), projects (`reembed`), transfer, startup (`reembed` after a target sync) |
| `SearchJobs` + `BatchContext` | search module's `jobs` (registered as is) | the scheduler's `embed-pending`, `reembed` and `cleanup` (consistency sweep); the jobs module's `JobContext` extends `BatchContext` |

`NoopSearchPort` is the placeholder `runtime.ts` starts with. For tests, `test/ports.ts` (never shipped) has
`FakeEmbeddingProvider` (deterministic bag-of-words vectors), `StaticEmbeddingRegistry`, `MemoryJobsPort`, and
`stubPorts()` which bundles them. `createApp` takes `ports` and `modules` explicitly (no fallback to fakes).
To test the real wiring, `createRuntime(base, { embeddings, scheduler })` takes a fake registry and fake
timers (`FakeClock` from `modules/jobs`).

## Tests

- **Unit** (`*.test.ts` under `src/`): pure logic, no database, parallel. `pnpm test:unit`.
- **Integration** (`*.integration.test.ts` under `src/`): against a real Postgres with pgvector.
  `pnpm test:integration`.
- **End to end** (`test/e2e/*.e2e.test.ts`): `pnpm test:e2e`. Boots the real server (createRuntime, createApp,
  startup with the real migrations, scheduler and SearchService; only the embedding model is the fake) on a
  random port against its own database `<test db>_e2e_test` (dropped and created by `test/e2e/global-setup.ts`,
  so it never races the integration tests' TRUNCATE; the database user needs CREATEDB, which the test
  container and CI have), and drives the **built** CLI (`packages/cli/dist/bin.js`; run `pnpm build` first,
  the setup fails fast otherwise) in a temp git repo: login through the device flow approved over the cookie
  API, init, `adr import`, the three hooks run from the `command` strings init wrote (`sh -c`, hook JSON on
  stdin), MCP tools through the SDK client with the `.mcp.json` URL and header, drafting with a fake
  `SPOOR_DRAFT_CMD`, the Stop nag once per session, and hooks with the server down.

**Realistic-data benchmark** (not part of `pnpm test`): `pnpm bench:realistic` (`scripts/seed-realistic.ts`) seeds ~410
items in its own database `spoor_bench_test` (dropped at the end), indexes them with the real e5 model
(`SPOOR_MODEL_DIR` required) and prints digest/search/tools-list token counts and latencies as JSON; the last results
are in docs/design/search-and-digest.md "Measured 2026-10-19".

`pnpm test` runs all three and **fails fast** with a clear message when the test database is unreachable.

The test database is `DATABASE_URL` when set (CI), otherwise `postgres://spoor:spoor@localhost:55432/spoor_test`:

```sh
pnpm test:db:up     # docker run pgvector/pgvector:0.8.7-pg17 as `spoor-test-db` on 127.0.0.1:55432 (tmpfs, fsync off)
pnpm test           # from the repo root or packages/server
pnpm test:db:down
```

Harness (`test/`):
- `global-setup.ts`: reachability check, then the real startup migrations once per run; it reads the
  definition of the default model's HNSW index they create and provides it to the workers.
- `setup.ts`: `TRUNCATE` of every public table before each test; integration files run one at a time. The
  HNSW indexes on `chunks` are reset before and after each test (`resetHnswIndexes`): every `chunks_hnsw_*`
  index but the default model's is dropped and a missing default is recreated, because the re-embed job
  creates and drops indexes and `TRUNCATE` does not undo that. The harness refuses a database whose name
  does not end in `_test` (override: `SPOOR_TEST_ALLOW_ANY_DB=1`).
- `db.ts`: `testDb()` / `testPool()`; `hnsw.ts`: the default index name and an index listing.
- `factories.ts`: `createUser`, `createAdmin`, `createProject`, `createSharedProject`, `addMember`,
  `createToken` (returns the plaintext `secret`), `createItem` (revision 1, real number counters). The
  default password `DEFAULT_PASSWORD` is hashed once per file.
- `http.ts`: `testApp({ env?, ports? })` builds the real app (`createApp` with `createAppModules`) on the
  test database and returns `{ app, ports, modules }`; `Client` is a small browser (cookie jar, same-origin
  `Origin`, JSON bodies); `loginAs(app, email, password)`.
- `ports.ts`: the in-memory port fakes (above).
- `cli-surface-app.ts`: `cliSurfaceApp()` = `testApp()` plus handles on the device, install, mirror and mcp
  modules (`testApp` takes the device overrides and the install version too).
- `e2e/`: the end-to-end walk of BRIEF.md DoD 2 and 3 (`harness.e2e.test.ts`, below).

Cross-module tests: `src/app.integration.test.ts` drives the assembled app with the runtime's real ports
(items → search indexing, dedupe, digest; scheduler → search jobs; push → undrafted; export → import →
search, the content-write lock order), `src/runtime.integration.test.ts` the startup gates and shutdown. Test-only
fixtures under `src/` (`*.scenarios.ts`, `zipfixtures.ts`) are excluded from `dist/` by `tsconfig.build.json`. Embedding-dependent tests use `FakeEmbeddingProvider` by default; the search module's
tests can run against the real e5 model with `SPOOR_TEST_REAL_MODEL=1 SPOOR_MODEL_DIR=<dir with
Xenova/multilingual-e5-small>` (fetch it once with `scripts/fetch-model.mjs`; see the header of
`src/modules/search/search.integration.test.ts`). Without a model, the one real-model unit test in
`providers.test.ts` is skipped.
