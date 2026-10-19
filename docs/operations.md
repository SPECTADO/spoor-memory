# Operations guide

For whoever deploys and runs a Spoor instance. The design behind it is [design/deployment.md](design/deployment.md).

## 1. What you run

Two containers from `docker-compose.yml`: `db` (`pgvector/pgvector:0.8.7-pg17`, pinned by digest, volume `spoor-pgdata`) and `app`
(the Spoor image: Node 22, the API, the MCP endpoint and the web UI on port 3000). An optional third, `caddy`, terminates TLS.
Postgres is the only state; the app keeps nothing on disk (the embedding model is baked into the image) except in-memory MCP
sessions, which clients re-create after a restart.

Two database roles exist on purpose. `spoor` (superuser) is used once at startup for `CREATE EXTENSION`; `spoor_app`
(`NOSUPERUSER`, created by `deploy/initdb/01-app-role.sh` when the volume is first initialised) owns every table and serves all
requests. `01-app-role.sh` runs only on an empty volume: changing `POSTGRES_APP_PASSWORD` later does not change the role's password.

## 2. Deployment

```sh
cp .env.example .env     # fill in the required values, section 3
docker compose up -d --build
docker compose ps        # app should become "healthy" (start period up to 2 minutes: migrations, model load)
```

- Compose builds the image from the repository (`build:` in the app service). To use a published image instead set `SPOOR_IMAGE`
  to a version tag (`ghcr.io/<owner>/spoor-memory:0.1.0`, owner in lowercase: Docker refuses upper-case repository names) and
  run `docker compose pull && docker compose up -d`. The default `spoor-memory:local` is the tag of the local build; images are
  pushed to GHCR by `.github/workflows/release.yml` when a `v*` tag is pushed (section 10). Pin a version tag in production.
- Startup order: the server listens at once and answers 503 `starting` to everything except `/healthz`, then runs migrations
  (forward-only, under a Postgres advisory lock, so two containers never migrate at once), seeds the `_shared` space, creates the
  bootstrap admin if the user table is empty, loads the embedding model (about 5 s) and starts the job scheduler 30 s later.
- The bootstrap admin (`SPOOR_ADMIN_EMAIL`, `SPOOR_ADMIN_PASSWORD`) is created only while there are no users. Changing these
  variables afterwards does nothing; change the password in the web UI (Account).
- Multiple app containers against one database are safe: migrations and jobs use database locks. There is no rate limiting in the
  app; put it in your proxy (section 5).

## 3. Environment variables

`.env.example` is the annotated template. Every secret also accepts a `<NAME>_FILE` variant (Docker secrets): the value is read from
that path with the trailing newline trimmed; setting both is a startup error. The app prints every configuration problem (never a
secret value) and exits 1.

### Read by compose (not by the app)

| variable | default | meaning |
|---|---|---|
| `POSTGRES_PASSWORD` | required | password of the `spoor` superuser (startup only). URL-safe characters only |
| `POSTGRES_APP_PASSWORD` | required | password of the `spoor_app` runtime role, set when the volume is first created |
| `SPOOR_IMAGE` | `spoor-memory:local` | app image; the default is the local build, set `ghcr.io/<owner>/spoor-memory:<version>` to pull a published one |
| `SPOOR_HTTP_PORT` | `3000` | host port |
| `SPOOR_HTTP_BIND` | `0.0.0.0` | host address; use `127.0.0.1` behind caddy or another proxy |
| `SPOOR_DOMAIN` | `localhost` | host name for the caddy profile |

### Read by the app

| variable | default | meaning |
|---|---|---|
| `DATABASE_URL` | required | runtime role connection string (`NOSUPERUSER`). Compose builds it |
| `DATABASE_MIGRATE_URL` | unset | superuser URL used once for `CREATE EXTENSION vector, unaccent` and a `GRANT CREATE`. Unset: the extensions must already exist and the runtime role needs `CREATE` on the database |
| `SPOOR_PUBLIC_URL` | `http://localhost:3000` | the origin users type, no path. Drives the CSRF origin check, cookie flags (`https` gives `Secure` and `__Host-` cookies), invite and device links and install.md. Never derived from the `Host` header, so a mismatch breaks logins (section 8) |
| `SPOOR_PORT`, `SPOOR_HOST` | `3000`, `0.0.0.0` | listen port and address inside the container |
| `SPOOR_ADMIN_EMAIL`, `SPOOR_ADMIN_PASSWORD`, `SPOOR_ADMIN_NAME` | required on an empty database; name `Admin` | bootstrap instance admin; password 12 to 256 characters |
| `LOG_LEVEL` | `info` | `trace` `debug` `info` `warn` `error` `fatal`; JSON lines on stdout, secrets redacted, no request bodies |
| `SPOOR_DB_POOL_MAX` | `10` | maximum Postgres connections (1 to 500) |
| `SPOOR_JOBS` | `on` | `off` disables the in-process scheduler (cleanup, embeddings, re-embed stop) |
| `SPOOR_EMBEDDING_DEFAULT` | `local` | provider new projects start with: `local`, `openai`, `voyage` (the latter two need their key) |
| `SPOOR_EMBED_THREADS` | `2` | ONNX threads of the local model; at most the CPUs given to the container |
| `SPOOR_MODEL_DIR` | `/opt/spoor/models` | where the baked model lives; loaded offline |
| `SPOOR_OPENAI_API_KEY`, `SPOOR_OPENAI_EMBED_MODEL`, `SPOOR_OPENAI_EMBED_DIMS` | unset, `text-embedding-3-small`, `1536` | enables the `openai` provider. Item text then leaves your instance |
| `SPOOR_VOYAGE_API_KEY`, `SPOOR_VOYAGE_EMBED_MODEL`, `SPOOR_VOYAGE_EMBED_DIMS` | unset | enables `voyage`; model and dimensions are required with the key. The request shape is tested only against a fake; try it on a scratch project before relying on it (deviations.md G15) |
| `SPOOR_TRUST_PROXY` | unset | see section 5 |
| `SPOOR_WEB_DIR`, `SPOOR_MIGRATIONS_DIR` | set by the image | only for runs outside the image |
| `NODE_ENV` | `production` in the image | do not change |

Fixed on purpose: cookie lifetimes (sessions last 30 days, 14 idle), password hashing cost, body caps (1 MB JSON, 50 MB import
upload), MCP session limits, scheduler cadence.

## 4. TLS

**Caddy profile** (automatic Let's Encrypt, needs ports 80 and 443 open and a DNS name pointing at the host):

```sh
# .env
SPOOR_DOMAIN=spoor.example.com
SPOOR_PUBLIC_URL=https://spoor.example.com
SPOOR_HTTP_BIND=127.0.0.1
SPOOR_TRUST_PROXY=private
docker compose --profile caddy up -d
```

`deploy/Caddyfile` is two lines: `encode zstd gzip` and `reverse_proxy app:3000`. Certificates persist in the `caddy-data` volume.

**Your own proxy** (nginx, Traefik, a cloud load balancer): forward everything to port 3000 and

- keep `SPOOR_PUBLIC_URL` identical to the public origin, including `https`;
- allow request bodies up to 50 MB (project import);
- do not buffer responses under `/p/*/mcp`, and keep idle timeouts above 60 s;
- append the client address to `X-Forwarded-For` and set `SPOOR_TRUST_PROXY` (below);
- rate-limit there, the app has no limiter. First `POST /p/*/device/code` (a few per minute per IP), then `POST /api/v1/auth/login`
  and `POST /api/v1/invites/*`. Without a limit a flood of device codes only evicts older pending codes, but it slows legitimate logins.

### SPOOR_TRUST_PROXY

The only thing this affects is the requester IP shown on the device approval page. Unset, that page shows the TCP peer, which behind
a proxy is the proxy. Set it to the proxies whose `X-Forwarded-For` you believe: comma-separated keywords `loopback` and `private`,
single addresses and CIDR ranges (`10.0.0.0/8,203.0.113.7`). The address shown is the right-most `X-Forwarded-For` hop that is not
itself a trusted proxy. With the caddy profile use `private`, and keep `SPOOR_HTTP_BIND=127.0.0.1` as in the example above:
`private` trusts every RFC 1918 peer, so if the app port is also published on `0.0.0.0`, any client on the LAN or VPN that reaches
port 3000 directly can forge the address the approval page shows. Never list a proxy that does not overwrite or append the header.

## 5. Backups

Two complementary kinds. Do both.

**1. `pg_dump` of the whole database (disaster recovery).** It contains users (password hashes), sessions, token hashes, embeddings,
history and audit log; treat the file as a secret.

```sh
docker compose exec -T db pg_dump -U spoor -Fc spoor > spoor-$(date +%F).dump
```

Run it from cron or a systemd timer and keep copies off the machine. A file copy of the volume is consistent only with `db` stopped.

**2. Project export (portable).** In the web UI: project Settings, Export. A zip with `manifest.json`, one Markdown file per item
(frontmatter included), per-item revision history and the project audit log. It holds no users, memberships, tokens, sessions or
embeddings (embeddings are rebuilt after import), so it moves a project to another instance but does not restore an instance. The
shared space exports from `/shared/settings` (instance admin). Exports and imports run one at a time.

## 6. Restore

From a dump, into an empty database, with the app stopped:

```sh
docker compose stop app
docker compose exec -T db pg_restore -U spoor -d spoor --clean --if-exists --no-owner --role=spoor_app < spoor-2026-10-19.dump
docker compose start app
```

`--role=spoor_app` keeps the runtime role as owner of every restored object. After a restore of a dump taken on an older version the
app migrates forward at startup. Test a restore once on a scratch machine before you need it.

From a project zip: create an empty project, then project Settings, Import (project admin); the web UI has no "import as a new
project" screen. An instance admin can also import a zip as a brand-new project through the API (`POST /api/v1/projects/import`,
multipart, cookie session). Ids, numbers, revisions, edges and counters are kept (or remapped on an id collision);
history is marked as imported. An import cap of 200 MB uncompressed applies while exports may be larger (deviations.md G12): export a
large project without history (`history=0`) if its zip will not re-import. A plain folder of Markdown files can be imported too.

## 7. Upgrades

1. Back up (section 5).
2. `docker compose pull && docker compose up -d` (or `git pull && docker compose up -d --build`).
3. Watch `docker compose logs -f app` until `/healthz` is `ok`.

Migrations are forward-only. To roll back, restore the dump taken in step 1 and start the older image. CLI users install the version
that matches the server (`npm i -g spoor-memory@<server version>`, as install.md says); the pinned `npx` fallback in the hooks follows
the server automatically after `spoor init` is rerun.

**Re-embed on model change.** Vectors are tagged with the model that made them (`local:Xenova/multilingual-e5-small@q8/384`).
Search only reads vectors of the project's active model, so a model change never mixes spaces.

- *A project admin switches the provider* (project Settings, Embedding, or the instance default changes): the project gets a target
  model and the `reembed` job (every minute) builds an index for it, re-chunks and embeds items in batches of 16, and meanwhile new
  writes are embedded for both models. Search keeps using the old model throughout. When nothing is missing, one transaction switches the
  active model; old vectors are deleted in batches and an unused index is dropped. Progress is on the project's Settings page and at
  Admin, Jobs. A job that stops (restart, outage) resumes on its own; an instance admin can press Run now.
- *You upgrade to an image whose default model differs*: the image carries only its own model, so affected projects search full-text
  only (results say `vector search unavailable (re-embedding)`) and skip the duplicate check until their re-embed cuts over. A few
  thousand items take minutes. Do such upgrades in a quiet hour.
- Switching to OpenAI or Voyage sends every item's text to that vendor.

## 8. Troubleshooting

**Health.** `GET /healthz` returns `{"status":"ok","version":"…","checks":{"db","migrations","embedding"}}`. 503 `starting` means a
check is still `pending` or `loading` (normal for the first minute); `embedding: failed` means the default provider could not load
(wrong `SPOOR_MODEL_DIR`, a missing API key for the configured default); 503 `unhealthy` means the database is unreachable. The app
retries startup steps every 2 s up to 30 times, then exits and Docker restarts it.

**Logs.** `docker compose logs -f app` (JSON, pino). Each request line carries a request id; the same id appears in `internal` error
responses (`request_id`) and in the UI's error panels, so a user report maps to a log line. `LOG_LEVEL=debug` for more. Database:
`docker compose logs db`.

| symptom | likely cause and fix |
|---|---|
| `docker compose up` stops with "set POSTGRES_PASSWORD" | a required `.env` value is empty |
| app exits at once, log says `invalid configuration` | read the listed variables; common: admin password under 12 characters, `SPOOR_EMBEDDING_DEFAULT=openai` without a key, both `X` and `X_FILE` set |
| app exits: extension `vector` missing | external Postgres without pgvector, or `DATABASE_MIGRATE_URL` unset and the extensions not created by hand |
| `permission denied for database` / schema `drizzle` | the runtime role lacks `CREATE` on the database; set `DATABASE_MIGRATE_URL` or `GRANT CREATE ON DATABASE spoor TO spoor_app` |
| login works in `curl` but the browser shows 403 `forbidden_origin` | `SPOOR_PUBLIC_URL` differs from the URL in the address bar (scheme, host or port), or a proxy rewrites `Origin` |
| cannot log in over plain http after setting an https `SPOOR_PUBLIC_URL` | cookies are `Secure` for https origins; use the https URL |
| device approval page shows the proxy's address | set `SPOOR_TRUST_PROXY` (section 4) |
| `spoor login` says the settings file is tracked by git | `.claude/settings.local.json` must never be committed; `git rm --cached` it or rerun with `--untrack` |
| agent sees 401 `invalid_token` | the token was revoked, has expired (device tokens last 90 days) or belongs to another server; run `spoor login` again |
| agent sees 403 `token_project_mismatch` | the token is for a different project than the URL |
| write fails with `read_only_space` | writes to the shared space are human-only by design |
| `revision_conflict` | someone changed the item since it was read; re-read and retry (the web editor offers a compare dialog) |
| `pushed_over_spoor_edit` | a mirrored ADR or doc was edited in the web UI; align the file or push with `--force` (needs a terminal) |
| search says `vector search unavailable (re-embedding)` | expected during a model change (section 7); it ends at cut-over |
| memories stopped going stale, embeddings never fill in | scheduler off (`SPOOR_JOBS=off`) or a stuck lease; Admin, Jobs shows `locked_by` and the last runs; Run now starts one |
| import is rejected `payload_too_large` or `zip_limits` | upload over 50 MB or archive over its caps; export with `history=0` |
| lost admin password | another instance admin creates a reset invite for you (Admin, Users). If none exists: stop the app and set `users.is_admin` on a user with `psql`, or restore a backup |

## 9. Resources

- App container: compose sets `mem_limit: 2g`; the local model and runtime use about 1.5 GB. Give it 2 CPUs (`SPOOR_EMBED_THREADS=2`).
  Embedding is bursty: a write embeds its chunks, a re-embed runs batches.
- Database: small. Items, history and 384-dimension vectors of a few thousand items fit in hundreds of megabytes; `shm_size: 256mb`
  is set for HNSW index builds during a re-embed. Disk grows with history and the audit log, which are never pruned automatically.
- Network: the app needs no outbound access with the local provider. Image build and first pull need Docker Hub and GHCR; the model
  weights are fetched at image build time, not at runtime.
- Scaling out is not a goal: one container per client is the intended shape.

## 10. Releasing

A release is one `v*` tag. `.github/workflows/release.yml` (ADR 0013) then:

1. checks that the tag, `packages/server/package.json` and `packages/cli/package.json` carry the same version (deviations.md I30:
   the server's install doc pins `spoor-memory@<server version>`), and stops otherwise;
2. runs all of `ci.yml`: lint, typecheck, unit tests, server integration tests and the server e2e walk (pgvector service), the
   Playwright browser tests, and the CLI package smoke test;
3. publishes the npm package `spoor-memory` with provenance: builds the bundle, packs it, installs that tarball with npm and runs
   `spoor --help` and `--version`, then `npm publish <tarball> --provenance --access public` (dist-tag `next` for a pre-release
   such as `v0.2.0-rc.1`, `latest` otherwise). A version already on npm is skipped, so a re-run after a failed image job is safe;
4. after npm, pushes the multi-arch image (`linux/amd64`, `linux/arm64`) to `ghcr.io/<owner>/<repo>` with tags `x.y.z`, `x.y` and
   `latest` (a pre-release gets only `x.y.z-…`).

**Before the first release** (review-log-phase5 A1, D2): the npm name `spoor-memory` is unregistered today. Register it for the
project's npm account now (a placeholder `0.0.1` is enough), or switch the CLI to a scoped name the organisation controls, before any
repository uses a release server: the committed SessionStart hook falls back to `npx --yes spoor-memory@<server version>` when `spoor`
is not on the PATH, so whoever owns that name would run code at every session start. A source-built server reports `0.0.0`; for that
version the hook renders no `npx` fallback (`|| exit 0`) and install.md tells users to install the CLI from the source checkout
(`pnpm install && pnpm --filter spoor-memory build && npm i -g ./packages/cli`).

Steps for a maintainer:

```sh
v=0.1.0
for p in server cli shared web; do (cd packages/$p && npm pkg set version=$v); done
# update CHANGELOG.md, commit "release v$v", then:
git tag "v$v" && git push origin main "v$v"
```

**Secrets and settings** (repository Settings, Secrets and variables, Actions):

| name | needed by | what |
|---|---|---|
| `NPM_TOKEN` | `release.yml` job `npm` | an npm granular access token with read and write on the `spoor-memory` package (for the first publish: on all packages of the account, then narrow it), no IP allow-list (GitHub runners). Exposed only to the publish step as `NODE_AUTH_TOKEN` |
| `GITHUB_TOKEN` | jobs `image` (GHCR push) | automatic; the workflow asks for `packages: write` itself. Nothing to create |

No other secret is used: provenance signs through the workflow's OIDC token (`id-token: write`), and `package.json` gets its
`repository` URL from the GitHub repository at publish time (npm rejects provenance when they differ). After the first image push,
set the GHCR package's visibility to public once (Packages, spoor-memory, Package settings); GHCR creates it private. If the
repository is renamed or forked, both the image name and the npm `repository` follow `github.repository`.

Check a package locally before tagging: `pnpm --filter spoor-memory build && pnpm --filter spoor-memory test:pack` (the tarball
must hold only `package.json`, `README.md`, `LICENSE` and `dist/bin.js`; `npm pack --dry-run` in `packages/cli` shows the same).
