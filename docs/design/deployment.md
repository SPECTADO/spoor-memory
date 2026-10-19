# Deployment

Status: implemented (phase 5, 2026-10-19); the workflow files and `docker-compose.yml` are the source of truth where they differ. One app image plus Postgres. Everything pinned below was checked on 2026-10-19 and was
published on or before 2026-10-16 (3-day release-age rule); the Docker and GitHub pins are recorded in §9.
Search/embedding details: [search-and-digest.md](search-and-digest.md); jobs: [cleanup-and-jobs.md](cleanup-and-jobs.md);
secrets: [auth-and-security.md](auth-and-security.md) §12.

## 1. Shape

```
browser / agents ──HTTP──▶ [caddy]? ──▶ app (Node 22, Hono, SPA, MCP, jobs, local embeddings) ──▶ db (pgvector pg17)
                          profile "caddy"                 :3000                                      :5432, volume
```
- Single tenant per deployment (BRIEF). The app container is stateless except the embedding model it carries, so it can be
  replaced freely; all state is in Postgres.
- Plain HTTP on one port by default. The `caddy` profile adds automatic HTTPS.
- Only `app` (or `caddy`) publishes a port. `db` is reachable on the compose network only.

## 2. Dockerfile (repo root)

Multi-stage, pnpm 10.34.7 (2026-10-12; scaffold decision, the 12.x majors are too young, revisit later), `node:22.23-bookworm-slim` (glibc: `onnxruntime-node` has no musl build), run as the
non-root `node` user. Build stages run on the target platform (QEMU for arm64 in CI, 10 to 20 minutes with cache);
splitting the web build onto `$BUILDPLATFORM` is a later optimisation.

```dockerfile
# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22.23-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# ---- build: install, compile shared + server + web, produce a pruned server tree -------------
FROM ${NODE_IMAGE} AS build
ENV CI=true
RUN npm install -g pnpm@10.34.7
WORKDIR /repo
COPY .npmrc pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json   packages/web/
COPY packages/cli/package.json   packages/cli/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r build
# pnpm 10 deploy relies on injectWorkspacePackages: true (set in pnpm-workspace.yaml); pnpm >= 12.2 would not need it
RUN pnpm --filter @spoor/server deploy --prod /out \
 && cp -r packages/server/drizzle /out/drizzle \
 && cp -r packages/server/scripts /out/scripts

# ---- model: bake the embedding weights, then prove they load offline --------------------------
FROM build AS model
ARG MODEL_REVISION=761b726dd34fb83930e26aab4e9ac3899aa1fa78
ENV SPOOR_MODEL_DIR=/opt/spoor/models MODEL_REVISION=${MODEL_REVISION}
RUN mkdir -p "$SPOOR_MODEL_DIR" && cd /out && node scripts/fetch-model.mjs

# ---- runtime ---------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production SPOOR_PORT=3000 SPOOR_WEB_DIR=/app/web \
    SPOOR_MIGRATIONS_DIR=/app/drizzle SPOOR_MODEL_DIR=/opt/spoor/models
WORKDIR /app
COPY --from=build --chown=node:node /out /app
COPY --from=build --chown=node:node /repo/packages/web/dist /app/web
COPY --from=model --chown=node:node /opt/spoor/models /opt/spoor/models
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SPOOR_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
```
Notes:
- **`scripts/fetch-model.mjs`** (`packages/server/scripts/`, uses the server's `@huggingface/transformers` 4.3.1 dependency):
  sets `env.cacheDir = <SPOOR_MODEL_DIR>/.download`, loads
  `pipeline('feature-extraction','Xenova/multilingual-e5-small',{ dtype:'q8', revision: MODEL_REVISION })` once (downloads
  `config.json`, tokenizer files and `onnx/model_quantized.onnx`). transformers.js caches a non-`main` revision under
  `<cacheDir>/<model>/<revision>/`, so the script moves that folder to `<dir>/Xenova/multilingual-e5-small/` and deletes the
  staging cache. It then re-loads the model with `allowRemoteModels=false, localModelPath=SPOOR_MODEL_DIR, cacheDir=null`
  and embeds one test string (asserting 384 dims). The build fails
  if either step fails, so an image that exists can start offline (research: embeddings-node.md; deviation D4). The revision is
  the Hugging Face commit `761b726d…` (last modified 2025-07-22). The build needs network access to huggingface.co; nothing at run time does.
- **Native scripts**: pnpm blocks dependency build scripts by default. `pnpm-workspace.yaml` carries an `onlyBuiltDependencies`
  allow-list of exactly the packages whose install scripts are needed (`onnxruntime-node`, `esbuild` for the vitest/vite toolchain and the CLI bundle);
  everything else stays blocked. `sharp` 0.35.x (pulled in by `@huggingface/transformers`) has no install script and is not
  listed. `ignoredBuiltDependencies` names the scripts reviewed and deliberately not run (`protobufjs`, whose postinstall only
  prints a warning), so installs stay warning-free without turning the check off.
- **Size**: roughly 0.7 to 1 GB (node_modules, 118 MB model). **Memory**: the embedder needs about 1.5 GB with batches of 8;
  compose sets `mem_limit: 2g`. CPU: 2 vCPU recommended; embedding is serialised (one inference at a time).
- `.dockerignore`: `.git`, `node_modules`, `**/dist`, `.env*` (except `.env.example`), `docs`, `.spoor`, `.claude`, `playwright-report`, `test-results`.
- The CLI package is built in the same workspace but not shipped in the image; it is published to npm separately.
- Init and signals: compose `init: true`; the app handles SIGTERM (close the HTTP server and stop the scheduler together, the
  scheduler waiting up to 25 s for a running job; then let an import's background chunk rebuild finish; then end the pool; a hard exit
  after 35 s) and compose gives it `stop_grace_period: 40s`.
- Pin `NODE_IMAGE` by digest as above and bump deliberately (the digest is of the multi-arch index).

## 3. `docker-compose.yml`

```yaml
name: spoor

services:
  db:
    image: pgvector/pgvector:0.8.7-pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d
    restart: unless-stopped
    environment:
      POSTGRES_USER: spoor
      POSTGRES_DB: spoor
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_APP_PASSWORD: ${POSTGRES_APP_PASSWORD:?set POSTGRES_APP_PASSWORD in .env}
    volumes:
      - spoor-pgdata:/var/lib/postgresql/data
      - ./deploy/initdb:/docker-entrypoint-initdb.d:ro   # creates the runtime role spoor_app on first init
    shm_size: 256mb                      # HNSW index builds during re-embed
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U spoor -d spoor"]
      interval: 5s
      timeout: 3s
      retries: 20

  app:
    image: ${SPOOR_IMAGE:-spoor-memory:local}
    build: { context: ., target: runtime }
    restart: unless-stopped
    init: true
    stop_grace_period: 40s
    mem_limit: 2g
    depends_on:
      db: { condition: service_healthy }
    environment:
      DATABASE_URL: postgres://spoor_app:${POSTGRES_APP_PASSWORD}@db:5432/spoor
      DATABASE_MIGRATE_URL: postgres://spoor:${POSTGRES_PASSWORD}@db:5432/spoor   # superuser, startup only
      SPOOR_PUBLIC_URL: ${SPOOR_PUBLIC_URL:-http://localhost:3000}
      SPOOR_ADMIN_EMAIL: ${SPOOR_ADMIN_EMAIL:?set SPOOR_ADMIN_EMAIL in .env}
      SPOOR_ADMIN_PASSWORD: ${SPOOR_ADMIN_PASSWORD:?set SPOOR_ADMIN_PASSWORD in .env}
      SPOOR_ADMIN_NAME: ${SPOOR_ADMIN_NAME:-Admin}
      LOG_LEVEL: ${LOG_LEVEL:-info}
      SPOOR_EMBEDDING_DEFAULT: ${SPOOR_EMBEDDING_DEFAULT:-local}
      SPOOR_EMBED_THREADS: ${SPOOR_EMBED_THREADS:-2}
      SPOOR_OPENAI_API_KEY: ${SPOOR_OPENAI_API_KEY:-}
      SPOOR_OPENAI_EMBED_MODEL: ${SPOOR_OPENAI_EMBED_MODEL:-}
      SPOOR_OPENAI_EMBED_DIMS: ${SPOOR_OPENAI_EMBED_DIMS:-}
      SPOOR_VOYAGE_API_KEY: ${SPOOR_VOYAGE_API_KEY:-}
      SPOOR_VOYAGE_EMBED_MODEL: ${SPOOR_VOYAGE_EMBED_MODEL:-}
      SPOOR_VOYAGE_EMBED_DIMS: ${SPOOR_VOYAGE_EMBED_DIMS:-}
      SPOOR_TRUST_PROXY: ${SPOOR_TRUST_PROXY:-}
    ports:
      - "${SPOOR_HTTP_BIND:-0.0.0.0}:${SPOOR_HTTP_PORT:-3000}:3000"

  caddy:                                 # optional: docker compose --profile caddy up -d
    profiles: ["caddy"]
    image: caddy:2.11.7-alpine
    restart: unless-stopped
    depends_on: [app]
    environment:
      SPOOR_DOMAIN: ${SPOOR_DOMAIN:-localhost}   # set a real host name when using this profile (a `:?` here would break plain `docker compose up`)
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config

volumes:
  spoor-pgdata:
  caddy-data:
  caddy-config:
```
`deploy/initdb/01-app-role.sh` (runs once, when the volume is first initialised):
```sh
#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
CREATE ROLE spoor_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '$POSTGRES_APP_PASSWORD';
GRANT CONNECT, TEMPORARY ON DATABASE $POSTGRES_DB TO spoor_app;
GRANT USAGE, CREATE ON SCHEMA public TO spoor_app;
SQL
```
`spoor_app` is not a member of `pg_execute_server_program`, `pg_read_server_files` or `pg_write_server_files` (nothing grants
them). It owns every table, which the re-embed job needs for `CREATE INDEX CONCURRENTLY`; the superuser `spoor` is used only at
startup for `CREATE EXTENSION`.

`deploy/Caddyfile`:
```
{$SPOOR_DOMAIN} {
	encode zstd gzip
	reverse_proxy app:3000
}
```
Using the caddy profile: in `.env` set `SPOOR_DOMAIN=spoor.example.com`, `SPOOR_PUBLIC_URL=https://spoor.example.com`
and `SPOOR_HTTP_BIND=127.0.0.1` so the plain-HTTP port is not exposed, and `SPOOR_TRUST_PROXY=private` so the device approval
page shows the user's address instead of Caddy's (Caddy reaches the app from the compose network's private range and sets
`X-Forwarded-For`). Connections through the published port 3000 arrive from the Docker gateway, also a private address, so
keep `SPOOR_HTTP_BIND=127.0.0.1`: then only processes on the host itself could bypass Caddy and claim an address. DNS must point at the host and ports 80/443 must be open
for the ACME challenge. `SPOOR_PUBLIC_URL` drives the cookie name (`__Host-` and `Secure` over https), the origin check and every link in
install.md, so it must be exactly the URL users type.

First run:
```
cp .env.example .env     # set POSTGRES_PASSWORD and POSTGRES_APP_PASSWORD (openssl rand -hex 24 each), SPOOR_ADMIN_EMAIL, SPOOR_ADMIN_PASSWORD
docker compose up -d
curl -s localhost:3000/healthz
```
Use only URL-safe characters in `POSTGRES_PASSWORD` and `POSTGRES_APP_PASSWORD` (they are embedded in the URLs); hex is fine. To
keep secrets off the environment use `DATABASE_URL_FILE`, `DATABASE_MIGRATE_URL_FILE` and `SPOOR_ADMIN_PASSWORD_FILE` with Docker
secrets (§5).
`SPOOR_ADMIN_*` are read only while the `users` table is empty.

## 4. Startup sequence (migrations at startup)

1. Parse and validate the environment with zod; on any error print all problems (never values of secrets) and exit 1.
2. Start the HTTP server **immediately**: `/healthz` answers 503 `starting`; every other route answers 503 `starting` (`Retry-After: 5`).
3. Connect to Postgres with retries (30 attempts, 2 s apart); compose already waits for `pg_isready`.
4. **Extensions** (only when `DATABASE_MIGRATE_URL` is set): one short-lived superuser connection runs
   `CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS unaccent;` and closes. Without it the extensions must already
   exist (external Postgres: create them once by hand) and the server checks `pg_extension` and exits 1 with a clear message if not.
   **Migrations** run as the runtime role, so it owns every object: check out **one dedicated** `pg` client (not the pool), take
   `SELECT pg_advisory_lock(hashtext('spoor-migrate'))` on it, run drizzle `migrate()` with a drizzle instance bound to that same client,
   `pg_advisory_unlock` on it, and release the client in `finally`. A session-level lock taken through a pool could be unlocked on a
   different connection and leak, blocking a second container's startup.
   The superuser step also runs `GRANT CREATE ON DATABASE <db> TO <runtime role>` (role taken from `DATABASE_URL`): drizzle's migrator runs
   `CREATE SCHEMA IF NOT EXISTS drizzle`, which Postgres ACL-checks before looking for the schema, and `01-app-role.sh` grants only schema `public`.
   Without `DATABASE_MIGRATE_URL` (external Postgres) grant it once by hand. Migration SQL lives in `packages/server/src/db/migrations` (`drizzle-kit generate`,
   plus hand-written `0000_extensions` and `0002_triggers_and_hnsw`); `pnpm build` copies it to `packages/server/drizzle`, the folder the image ships. Migrations are forward-only; the extensions migration
   ([data-model.md](data-model.md) §1) keeps `CREATE EXTENSION IF NOT EXISTS`, a no-op once they exist.
5. Create the `_shared` project row if missing (idempotent) on the default provider (its name in `settings.embedding.provider`,
   its tag as `embedding_model`, like a project created in the UI), seed `job_locks`.
6. If `users` is empty: create the bootstrap admin from `SPOOR_ADMIN_*`; missing values exit 1 with a clear message.
7. Build the embedding providers; `ready()` of the default one loads the model (about 5 s). If a provider's tag differs from `projects.embedding_model`, set
   `embedding_target` (re-embed starts, [search-and-digest.md](search-and-digest.md) §3). After a default-model upgrade the old model's weights are not in the
   image, so affected projects run full-text-only search until their re-embed cuts over (search says `vector search unavailable (re-embedding)`); plan
   upgrades of the default model for a quiet hour. A project of a few thousand items re-embeds in minutes.
8. Start the scheduler (first tick after 30 s) and flip the server to ready: `/healthz` becomes 200.

Steps 3 to 8 are `startup()` in `packages/server/src/runtime.ts`; `/healthz` reports `db`, `migrations` and `embedding`
(`loading` → `ok`, or `failed` when the default provider's `ready()` threw) and stays 503 until all three are `ok`.
A failed step is retried every 2 s, up to 30 attempts (a missing extension or `SPOOR_ADMIN_*` exits at once).

If steps 3 to 7 fail the process logs the error and exits non-zero; Docker restarts it (`restart: unless-stopped`).

## 5. Environment variables

`<NAME>_FILE` is accepted for every secret (`DATABASE_URL`, `DATABASE_MIGRATE_URL`, `SPOOR_ADMIN_PASSWORD`, `SPOOR_OPENAI_API_KEY`, `SPOOR_VOYAGE_API_KEY`): the value is read
from that path (Docker secrets, `/run/secrets/...`), trailing newline trimmed; setting both is an error. `.env.example` lists all variables below
with placeholders and comments; `.env` is gitignored.

| variable | default | meaning |
|---|---|---|
| `DATABASE_URL` | none, **required** | Postgres connection string of the **runtime** role (`NOSUPERUSER`, owns the tables). In compose built from `POSTGRES_APP_PASSWORD` |
| `DATABASE_MIGRATE_URL` | unset | Superuser connection used once at startup for `CREATE EXTENSION`; never used for requests. Unset → the extensions must already exist |
| `SPOOR_PUBLIC_URL` | `http://localhost:3000` | Externally visible origin, no trailing path. Used for the origin check, cookie flags, invite and device links, install.md. Never derived from `Host` |
| `SPOOR_PORT` | `3000` | Listen port inside the container |
| `SPOOR_HOST` | `0.0.0.0` | Listen address |
| `SPOOR_ADMIN_EMAIL` | none, required on an empty database | Bootstrap instance admin email |
| `SPOOR_ADMIN_PASSWORD` | none, required on an empty database | Bootstrap password (12 to 256 characters) |
| `SPOOR_ADMIN_NAME` | `Admin` | Display name of the bootstrap admin |
| `LOG_LEVEL` | `info` | pino level: `trace` `debug` `info` `warn` `error` `fatal`. JSON to stdout, secrets redacted, no request bodies |
| `SPOOR_DB_POOL_MAX` | `10` | Maximum Postgres connections |
| `SPOOR_JOBS` | `on` | `off` disables the in-process scheduler (tests, one-off maintenance) |
| `SPOOR_WEB_DIR` | image: `/app/web` (Dockerfile `ENV`); otherwise `packages/web/dist` (resolved from the server package) | Directory of the built SPA |
| `SPOOR_MIGRATIONS_DIR` | image: `/app/drizzle` (Dockerfile `ENV`); otherwise the server package's `drizzle/` folder | Drizzle migrations folder |
| `SPOOR_EMBEDDING_DEFAULT` | `local` | Provider new projects start with: `local`, `openai` or `voyage` (the latter two need their key) |
| `SPOOR_MODEL_DIR` | `/opt/spoor/models` | Directory with the baked local model; loaded offline |
| `SPOOR_EMBED_THREADS` | `2` | ONNX intra-op threads of the local model (use at most the CPUs given to the container) |
| `SPOOR_OPENAI_API_KEY` | unset | Enables the `openai` provider. Item text then leaves the instance |
| `SPOOR_OPENAI_EMBED_MODEL` | `text-embedding-3-small` | OpenAI embedding model |
| `SPOOR_OPENAI_EMBED_DIMS` | `1536` | Dimensions sent as `dimensions` |
| `SPOOR_VOYAGE_API_KEY` | unset | Enables the `voyage` provider |
| `SPOOR_VOYAGE_EMBED_MODEL` | none, required when the key is set | Voyage model name (check vendor docs at implementation) |
| `SPOOR_VOYAGE_EMBED_DIMS` | none, required when the key is set | Sent as `output_dimension` |
| `SPOOR_TRUST_PROXY` | unset (off) | Reverse proxies whose `X-Forwarded-For` is believed, for the requester IP the device approval page shows (the only use). Comma-separated keywords `loopback` (127.0.0.0/8, ::1) and `private` (10/8, 172.16/12, 192.168/16, fc00::/7), addresses and CIDR ranges, e.g. `private` for the compose `caddy` profile. When the TCP peer is trusted, the address is the right-most `X-Forwarded-For` hop that is not a trusted proxy (hops a client prepends do not count). Off, `off` or `false`: the TCP peer, forwarded headers ignored. Only list proxies that set or append `X-Forwarded-For` themselves; an invalid entry stops startup |
| `NODE_ENV` | `production` in the image | Set by the image; do not change |

Compose-only (read by `docker-compose.yml`, not by the app):

| variable | default | meaning |
|---|---|---|
| `POSTGRES_PASSWORD` | none, **required** | Password of the `spoor` database superuser (extensions at startup only) |
| `POSTGRES_APP_PASSWORD` | none, **required** | Password of the `spoor_app` runtime role, created by `deploy/initdb/01-app-role.sh` |
| `SPOOR_IMAGE` | `spoor-memory:local` | App image: the local build by default; `ghcr.io/<owner>/spoor-memory:<version>` (lowercase) for a published one, pinned in production |
| `SPOOR_HTTP_PORT` | `3000` | Host port for the app |
| `SPOOR_HTTP_BIND` | `0.0.0.0` | Host address to bind; `127.0.0.1` behind caddy or another proxy |
| `SPOOR_DOMAIN` | none, required with `--profile caddy` | Public host name for Caddy |

Not configurable on purpose (design constants): cookie lifetimes, scrypt cost, body and import caps, MCP session limits, scheduler cadence.

## 6. GitHub Actions

Actions are pinned by commit SHA (house rule); the comment names the release. Dates and SHAs in §9.

### 6.1 `.github/workflows/ci.yml` (push to `main`, pull requests, called by `release.yml`)

The file is the source of truth; this is its shape (phase 5, 2026-10-19). Every job: checkout, `pnpm/action-setup` (version from
`packageManager`), `setup-node` (`node-version-file: .nvmrc`, pnpm cache), `pnpm install --frozen-lockfile`. The other packages
import `@spoor/shared` from its `dist/`, so jobs that type-check or test build it first. The pgvector service is
`pgvector/pgvector:0.8.7-pg17` (user/password `spoor`, database `spoor_test`, `pg_isready` health check) and the workflow-level
`DATABASE_URL` is `postgres://spoor:spoor@localhost:5432/spoor_test`.

| job | needs | service | runs |
|---|---|---|---|
| `lint` | | | `pnpm lint` (Biome 2.5.15), build shared, `pnpm typecheck` |
| `unit` | | | build shared, `pnpm -r run test:unit` (shared, server unit project, web, cli); CLI package smoke test: `pnpm --filter spoor-memory build && pnpm --filter spoor-memory test:pack` (ADR 0013) |
| `integration` | | pgvector | build shared, `pnpm --filter @spoor/server test:integration` with `SPOOR_JOBS=off` (REST + MCP tools, fake EmbeddingProvider) |
| `e2e-server` | lint, unit, integration | pgvector | `pnpm build`, `pnpm --filter @spoor/server test:e2e` (real server in process, the built CLI; database `<name>_e2e_test`) |
| `e2e-web` | lint, unit, integration | pgvector | `pnpm --filter @spoor/web exec playwright install --with-deps chromium`, then `pnpm e2e` (builds shared, server and web; Playwright starts the built server with the fake embedding model on database `<name>_web_e2e_test` and a random port, serving the built SPA); `actions/upload-artifact` uploads `packages/web/playwright-report` and `test-results` on failure |
| `compose-smoke` | lint, unit, integration | | BRIEF DoD 1 as an operator runs it (deviations H13, review-log-phase5 D1): `.env` from `.env.example` with generated passwords and an admin, `docker compose up -d --build --wait --wait-timeout 600`, `curl /healthz`, the bootstrap admin logs in (`POST /api/v1/auth/login`), logs on failure, `docker compose down -v`. Runs also when `release.yml` calls the workflow |
| `image` | lint, unit, integration | | QEMU + buildx, multi-arch `linux/amd64,linux/arm64` build with the GHA cache, **never pushed**; skipped when `release.yml` calls the workflow (`skip_image: true`) |

Playwright is a dependency of `packages/web` only, so the browser install runs through `pnpm --filter @spoor/web exec`; a root
`pnpm exec playwright` does not find the binary. Pull requests cancel superseded runs; pushes to `main` do not. The real-model test
(`pnpm --filter @spoor/server test:model`) is not a CI job: it needs the e5 weights (run it by hand, or later with `actions/cache` on
`SPOOR_MODEL_DIR` keyed by `MODEL_REVISION`).

### 6.2 `.github/workflows/release.yml` (tags `v*` only)

ADR 0013. Jobs in order; nothing is published unless every earlier job passed.

1. `version`: the tag must be `v<major>.<minor>.<patch>[-pre]` and equal the `version` of `packages/server/package.json` and
   `packages/cli/package.json` (deviations I30). Outputs the version and whether it is a pre-release.
2. `ci`: `uses: ./.github/workflows/ci.yml` with `skip_image: true`, i.e. every job of §6.1 except the image build.
3. `npm` (`id-token: write`): build the CLI bundle; `npm pkg set repository.url=git+https://github.com/<repo>.git` (and
   `repository.directory`, `homepage`, `bugs`), because npm provenance rejects a mismatch; `node packages/cli/scripts/pack-smoke.mjs
   --install --out $RUNNER_TEMP/npm` packs, installs the tarball with npm and runs `spoor --help` and `--version`; then
   `npm publish <that tarball> --provenance --access public --tag latest|next` with `NODE_AUTH_TOKEN=${{ secrets.NPM_TOKEN }}`.
   An already published version is skipped, so re-running a release whose image job failed is safe.
4. `image` (`packages: write`), after `npm`: login to GHCR with `GITHUB_TOKEN`, `docker/metadata-action` on
   `ghcr.io/${{ github.repository }}` (lowercased by the action) with `flavor: latest=false` and tags
   `type=semver,pattern={{version}}`, `type=semver,pattern={{major}}.{{minor}}` (skipped for pre-releases) and `latest` unless a
   pre-release; `build-push-action` multi-arch with `push: true`.

npm goes before the image so an image whose install doc pins `spoor-memory@X` is never pullable while `X` is missing on npm.
No image is published from `main` and no GitHub release is created (the design draft had both; dropped as not needed for the MVP).
After the first push set the GHCR package visibility to public once, by hand (default is private). Secrets and the maintainer's
steps: [docs/operations.md](../operations.md) §10.

## 7. Operations

- **Logs**: `docker compose logs -f app`. Request lines carry a request id that also appears in `internal` error responses.
- **Upgrade**: back up (§8), `docker compose pull && docker compose up -d`. Migrations run at startup and are forward-only; roll back by restoring the dump
  and starting the older image. Pin `SPOOR_IMAGE` to a version tag in production.
- **Re-embed**: automatic when the default model changes or a project switches provider; progress in the project's Settings page and `GET /api/v1/projects/:slug/jobs`.
- **Reset a lost admin password** without SMTP: another instance admin creates a reset invite; if none exists, stop the app, set `users.is_admin` on a
  user through `psql`, or wipe and restore from a backup. (A CLI command for this is out of the MVP.)
- **Reverse proxy of your own**: forward everything to port 3000, keep `SPOOR_PUBLIC_URL` equal to the public origin, allow bodies up to 50 MB for import, do not buffer
  responses to `/p/*/mcp`, append the client address to `X-Forwarded-For` and set `SPOOR_TRUST_PROXY` to the proxy's address (§5). Add rate limiting there, the app has none (BRIEF). Rate-limit first the unauthenticated `POST /p/*/device/code` (a few per minute per IP),
  then `POST /api/v1/auth/login` and `POST /api/v1/invites/*`. Without it a flood of device codes only evicts older pending codes
  ([auth-and-security.md](auth-and-security.md) §6), but a limit keeps legitimate logins fast.

## 8. Backup and restore

Two complementary things:

1. **Full backup (disaster recovery)**: `pg_dump` of the whole database. It holds users (scrypt hashes), sessions, token hashes, embeddings, history and the audit log, so
   treat the file as a secret.
```
docker compose exec -T db pg_dump -U spoor -Fc spoor > spoor-$(date +%F).dump
# restore into an empty database (stop the app first):
docker compose exec -T db pg_restore -U spoor -d spoor --clean --if-exists --no-owner --role=spoor_app < spoor-2026-10-19.dump
# --role=spoor_app keeps the runtime role as the owner of every restored object
```
   Schedule it from the host (cron or systemd timer) and keep copies off the machine. A file-level copy of the volume is consistent only with the database stopped.
2. **Portable per-project export**: the zip from the web UI ([api.md](api.md) §9, [data-model.md](data-model.md) §8): Markdown files, per-item revision history and the project audit log. It
   contains no users, memberships, tokens, sessions or embeddings (embeddings are rebuilt on import), so it moves a project to another instance but does not restore an instance.

Test a restore at least once before relying on it; the compose file makes it a five-minute exercise on a scratch machine.

## 9. Pins and release dates

| item | pin | released / pushed | note |
|---|---|---|---|
| node image | `node:22.23-bookworm-slim` `sha256:c3de60bf…978392` | 2026-10-06 | multi-arch index digest |
| pgvector image | `pgvector/pgvector:0.8.7-pg17` `sha256:ac08538c…2a75d` | 2026-10-01 | D3 |
| caddy image | `caddy:2.11.7-alpine` | 2026-10-06 (tag last pushed); 2.11.7 itself 2026-10-14 | from the Docker Hub tag list |
| pnpm | 10.34.7 | 2026-10-12 | chosen at scaffold; 12.14.0 (2026-10-15) is too young a major. Needs `injectWorkspacePackages: true` for `pnpm deploy` |
| model `Xenova/multilingual-e5-small` | revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78` | 2025-07-22 | q8 file `onnx/model_quantized.onnx` |
| actions/checkout | v7.0.1 `3d3c42e5…ba90b1` | 2026-07-20 | |
| actions/setup-node | v7.1.0 `949feb24…c0b15c1` | 2026-10-08 | |
| pnpm/action-setup | v6.1.0 `ea17c68d…e413` (commit behind the annotated tag) | 2026-09-05 | |
| docker/setup-qemu-action | v4.4.0 `99012661…04e1` | 2026-09-15 | |
| docker/setup-buildx-action | v4.4.1 `f87e5991…f069` | 2026-09-16 | |
| docker/login-action | v4.6.0 `dbcb8138…9679f` | 2026-07-29 | |
| docker/metadata-action | v6.2.0 `dc802804…02e` | 2026-07-02 | |
| docker/build-push-action | v7.4.0 `c3c9e263…91b0dc` | 2026-09-15 | |
| actions/upload-artifact | v7.0.2 `cf430e03…6cd9` | 2026-10-07 | ci.yml `e2e-web`, report on failure |
| esbuild (npm, devDependency of packages/cli) | 0.28.2 | 2026-08-08 | already in the lockfile via `tsx`; bundles the CLI (ADR 0013) |

The npm publish uses the `npm` that ships with Node 22 on the runner (no action); no other npm package is added by this document.

## 10. Local development

`docker compose up -d db` (publish 5432 with a local override file), `pnpm install`, `pnpm --filter @spoor/server dev` (port 3000), `pnpm --filter @spoor/web dev` (Vite on 5173, proxies `/api` and
`^/p/` to 3000). Set `SPOOR_PUBLIC_URL=http://localhost:5173` for the Vite dev server so cookies and the origin check match the browser origin. Agents and the CLI talk to port 3000 directly in dev.
