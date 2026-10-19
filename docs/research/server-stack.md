# Research: server stack (fact-finding, 2026-10-19)

Rule applied: every version published on or before 2026-10-16 (`npm view <pkg> time --json`). Registry data fetched 2026-10-19.
Newer-than-expected majors exist (vitest 5, pnpm 12, @hono/node-server 2). Choices below say why.

## 1. Pinned versions

| Package | Version | Released | Note |
|---|---|---|---|
| hono | 4.13.13 | 2026-10-04 | `latest` tag; v5 only rc |
| @hono/node-server | 2.1.5 | 2026-10-13 | engines node>=20; `latest-1` is 1.19.17 |
| @hono/zod-validator | 0.9.1 | 2026-08-31 | optional |
| zod | 4.6.7 | 2026-10-12 | `latest` tag |
| yaml | 2.9.1 | 2026-09-11 | frontmatter parse/write (see 8) |
| fflate | 0.8.3 | 2026-05-16 | zip, pure JS, 0 deps |
| pino | 10.4.0 | 2026-10-02 | |
| vitest | 5.0.5 | 2026-10-15 | `latest`; engines node ^22.12 OK. 4.1.12 (2026-10-15) is the safe 4.x fallback |
| @playwright/test | 1.64.1 | 2026-10-14 | |
| typescript | 6.0.3 | 2026-04-16 | 7.0.2 (2026-07-08) exists; 6.x chosen (see blockers) |
| pnpm | 12.14.0 | 2026-10-15 | 12.0.0 was 2026-08-26. Fallback 10.34.7 (2026-10-12) |
| drizzle-orm | 0.45.4 | 2026-10-08 | out of topic, noted only |
| node image | node:22-bookworm-slim (22.23.3 at time of writing) | pushed 2026-10-06 | linux/amd64, arm64, arm, ppc64le |
| docker/setup-qemu-action | v4.4.0 | 2026-09-15 | |
| docker/setup-buildx-action | v4.4.1 | 2026-09-16 | |
| docker/login-action | v4.6.0 | 2026-07-29 | |
| docker/metadata-action | v6.2.0 | 2026-07-02 | |
| docker/build-push-action | v7.4.0 | 2026-09-15 | |
| actions/checkout | v7.0.1 | 2026-07-20 | |
| actions/setup-node | v7.1.0 | 2026-10-08 | |
| pnpm/action-setup | v6.1.0 | 2026-09-05 | (dates via `gh api repos/<r>/releases/latest`) |

Rejected/considered: @node-rs/argon2 2.2.2 (2026-10-06), bcryptjs 3.0.3 (2025-11-02), yauzl 3.4.0 (2026-06-07), yazl 3.3.1 (2024-11-23), adm-zip 0.6.1 (2026-09-11), gray-matter 4.0.3 (2021-04-24), pino-http 11.0.0 (2025-10-04).

## 2. Hono + @hono/node-server (SPA hosting)

Source: package tarball `@hono/node-server@2.1.5` `dist/serve-static.d.mts`; https://hono.dev/docs/getting-started/nodejs
- Package is ESM-first (`"type":"module"`, also ships cjs). Subpath `@hono/node-server/serve-static` exists; `serveStatic` is also exported from the root.
- Options (verbatim from d.ts): `root?`, `path?`, `index?`, `precompressed?`, `allowPercentInPath?` (default false), `rewriteRequestPath?`, `onFound?`, `onNotFound?`. `root` is relative to process cwd, so use an absolute path or `process.chdir`-independent resolve.
- SPA history fallback pattern (static first, then index.html for non-API GETs):
```ts
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
app.use('/assets/*', serveStatic({ root: WEB_DIR }))        // immutable hashed files
app.get('*', serveStatic({ root: WEB_DIR }))                  // real files (favicon etc.)
app.get('*', serveStatic({ root: WEB_DIR, path: 'index.html' })) // fallback
```
  Register API routes (`/api/*`, `/p/:slug/mcp`, `/p/:slug/install.md`) BEFORE the fallback and make unknown `/api/*` return JSON 404 so the SPA never swallows API errors. Add `Cache-Control: no-cache` on index.html, `public, max-age=31536000, immutable` on `/assets/*` via `onFound`.
- `serve({ fetch: app.fetch, port })`; graceful shutdown: keep returned `server`, call `server.close()` on SIGTERM.
- Gotcha: v2 of node-server needs node>=20 (fine). Do not mix `@hono/node-server` 1.x docs with 2.x.

## 3. Cookies, sessions, CSRF

Source: `hono@4.13.13` `dist/types/helper/cookie/index.d.ts`, `utils/cookie.d.ts`, `dist/middleware/csrf/index.js`.
- `setSignedCookie(c, name, value, secret, opt)` is async; `getSignedCookie(c, secret, name)` returns `string | undefined | false` (false = bad signature). `CookieOptions`: `httpOnly, secure, sameSite: 'Strict'|'Lax'|'None', maxAge, expires, path, domain, prefix: 'host'|'secure', partitioned`. `__Host-` prefix forces `secure:true, path:'/'`, no domain.
- Recommended session design: DB-backed. Cookie value = random 32-byte base64url session id; DB stores `sha256(id)` (not the id), user_id, created_at, last_seen_at, expires_at (idle 14d sliding / absolute 30d). Signing is optional if the id is unguessable and hashed in DB; still cheap to sign for defence in depth:
```ts
await setSignedCookie(c, 'spoor_sid', sid, SESSION_SECRET, {
  httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60*60*24*14,
  secure: COOKIE_SECURE /* env; false for plain-HTTP self-host */ })
```
  Gotcha: brief allows plain HTTP, so `secure` and the `__Host-` prefix must be env-driven (`SPOOR_PUBLIC_URL` starts with https). Rotate session id on login; delete DB row on logout and on password change.
- CSRF GOTCHA (verified in source): `hono/csrf` only checks requests whose Content-Type is `application/x-www-form-urlencoded | multipart/form-data | text/plain` (or missing); it passes `application/json` untouched. For a JSON API it is NOT enough. Use SameSite=Lax (blocks cross-site POST cookies) PLUS a small custom middleware on unsafe methods for cookie-authenticated routes:
```ts
app.use('/api/*', async (c, next) => {
  if (!/^(GET|HEAD|OPTIONS)$/.test(c.req.method) && !c.req.header('authorization')) {
    const o = c.req.header('origin')
    const ok = o ? o === PUBLIC_ORIGIN : c.req.header('sec-fetch-site') === 'same-origin'
    if (!ok) return c.json({ error: 'forbidden_origin' }, 403)
  }
  await next()
})
```
  Bearer-token routes (`/p/:slug/mcp`, token API) are not cookie-authenticated, so exempt them; never accept cookies on those routes. Also require `Content-Type: application/json` on JSON endpoints. `PUBLIC_ORIGIN` must come from config (reverse proxy rewrites Host); `new URL(c.req.url).origin` is wrong behind Caddy without trusted forwarded headers.

## 4. Password hashing (recommendation: node:crypto scrypt)

- @node-rs/argon2 2.2.2: napi-rs, prebuilt per-platform optional deps incl. `linux-x64-gnu`, `linux-arm64-gnu`, `linux-x64-musl`, `linux-arm64-musl` (verified via `npm view optionalDependencies`); no compile step on bookworm-slim (glibc). Cost: multi-arch `pnpm deploy`/install must run per target arch (QEMU or native) or the wrong optional dep is pruned; one more native binary to track.
- bcryptjs 3.0.3: pure JS, 72-byte input limit, ~3-4x slower than native, weaker (not memory-hard).
- node:crypto `scrypt` (built in, zero deps, memory-hard, OWASP-listed: N=2^17, r=8, p=1). Measured on Node 22.19 here: 196 ms per hash with `{N:2**17,r:8,p:1,maxmem:256*1024*1024}` (maxmem is mandatory above default 32 MiB, else ERR_CRYPTO_INVALID_SCRYPT_PARAMS... memory ~128 MiB per hash; run async version so it uses the libuv pool, not the event loop).
- Recommendation: scrypt, stored as `scrypt$N$r$p$<salt_b64>$<hash_b64>` (versioned PHC-like string) so a later rehash-on-login upgrade to argon2id is possible. Compare with `crypto.timingSafeEqual`. Always run a dummy hash for unknown emails (timing). Limit concurrent hashes (e.g. semaphore of 2) because rate limiting is out of MVP scope and each hash holds ~128 MiB.

## 5. API tokens

Verified locally: `'spr_' + randomBytes(32).toString('base64url')` gives 47 chars; `createHash('sha256').update(tok).digest('hex')` is 64 hex.
- Store only `sha256(token)` (hex or bytea) + `prefix` (first 8 chars of the token after `spr_`, for UI display) + owner, project, role snapshot-or-inherit, name, created/last_used/revoked_at. High-entropy tokens do not need a slow hash; lookup by `WHERE token_hash = $1` (indexed unique) is constant-time enough; no timingSafeEqual needed for DB equality lookup.
- Show the token exactly once. Use a distinct prefix per kind: `spr_` (user-project), `sprs_` (project service token) so secret scanners and humans can tell them apart. Reject tokens on cookie routes and vice versa.

## 6. Device authorization flow (RFC 8628) adapted to per-user-per-project token

Source: https://datatracker.ietf.org/doc/html/rfc8628 (sections 3.1-3.5, 6.1). Facts: grant_type `urn:ietf:params:oauth:grant-type:device_code`; request returns `device_code, user_code, verification_uri, verification_uri_complete?, expires_in, interval (default 5)`; poll errors `authorization_pending`, `slow_down` (add 5 s to interval permanently), `access_denied`, `expired_token`; user code should be short, case-insensitive, from a restricted alphabet; RFC 6.1 example alphabet `BCDFGHJKLMNPQRSTVWXZ`, 8 chars as `WDJB-MJHT`.
Design (no OAuth client machinery; single-tenant):
- `POST /api/device/code` body `{ project: "<slug>", client_name }` (unauthenticated, public). Creates row: `device_code` = random 32 bytes base64url (store sha256), `user_code` 8 chars from `BCDFGHJKLMNPQRSTVWXZ` shown `XXXX-XXXX` (about 34 bits; normalise by uppercasing and stripping `-`), project_id, status `pending`, `expires_at = now+15 min`, `interval=5`, `last_polled_at`. Response: `{device_code, user_code, verification_uri: "<PUBLIC_URL>/device", verification_uri_complete: "<PUBLIC_URL>/device?code=XXXX-XXXX", expires_in: 900, interval: 5}`.
- Browser: SPA route `/device` requires login (redirect to login with return path), shows project name + client_name + code, user clicks Approve/Deny. `POST /api/device/approve` (cookie auth + origin check) checks the user is a member of the project, and marks row `approved` with `user_id`. User-code lookup attempts limited (e.g. 5 wrong tries per session/IP in-memory, then lock) since global rate limiting is out of scope; only this endpoint needs it.
- `POST /api/device/token` body `{ grant_type, device_code }` (public). Pending: HTTP 400 `{error:"authorization_pending"}`; polling faster than `interval` since `last_polled_at`: 400 `{error:"slow_down"}` and persist `interval += 5`; expired: `expired_token`; denied: `access_denied`; approved: mint the `spr_` token for (user, project) inside one transaction with `UPDATE ... SET status='consumed' WHERE status='approved' RETURNING` so it is delivered once, return `{access_token, token_type:"Bearer", project}`. If the user already has a token for that project, issue an additional one (named after client_name) rather than revealing the old one.
- Housekeeping: cleanup job deletes device rows 1 day after expiry. The CLI stores the token via `.claude/settings.local.json` `env.SPOOR_TOKEN`.

## 7. Zip create/extract (recommendation: fflate)

- fflate 0.8.3: pure JS, zero deps, 796 KB unpacked, `zipSync/unzipSync` plus async/streaming (`Zip`, `Unzip`), `filter` callback receives `UnzipFileInfo {name, size, originalSize, compression}` BEFORE inflate, which lets us enforce limits (verified in `lib/index.d.ts`). Not a streaming-from-disk API, so whole archive sits in memory: cap upload (e.g. 50 MB) and expanded total.
- yauzl 3.4.0 + yazl 3.3.1: robust streaming, but two packages, callback style, yazl unmaintained since 2024-11. adm-zip 0.6.1: sync, historically had path-traversal CVEs; rejected.
```ts
import { zipSync, unzipSync, strToU8 } from 'fflate'
const zip = zipSync({ 'memories/foo.md': strToU8(md), 'manifest.json': strToU8(json) }, { level: 6 })
let total = 0, count = 0
const files = unzipSync(buf, { filter: f => {
  if (f.name.endsWith('/')) return false
  if (++count > 20000 || (total += f.originalSize) > 200*2**20 || f.originalSize > 5*2**20) throw new Error('zip_limits')
  return true } })
```
- Path-traversal guard (import never writes to disk by path; entries go to DB): still validate each name: reject if it contains `\`, NUL, starts with `/` or drive letter, or any segment is `..` or empty/`.`; allow only `^(memories|decisions|docs)/[a-z0-9._-]+\.md$` plus `manifest.json`. Normalise with `path.posix.normalize` and compare to the original. Beware duplicate names and zip bombs (`originalSize` in the header can lie; also cap the length of each inflated Uint8Array after the fact). Ignore symlink attributes (we never create links).

## 8. Frontmatter and wikilinks

- gray-matter 4.0.3: last release 2021-04-24, CJS, depends on js-yaml ^3 (old major), no round-trip of comments/ordering on `stringify`. Recommendation: `yaml` 2.9.1 (active, `Document` API preserves comments and key order, needed for `spoor adr import` writing `spoor_id` back into user files) with a 15-line splitter:
```ts
import { parse, parseDocument } from 'yaml'
const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src.replace(/^﻿/, ''))
const data = m ? parse(m[1], { schema: 'core' }) : {}   // core schema: no timestamps surprises
const body = m ? m[2] : src
// write back: const doc = parseDocument(m[1]); doc.set('spoor_id', id); out = `---\n${doc.toString()}---\n${body}`
```
  Validate `data` with zod (`z.object({...}).passthrough()` for unknown keys). Gotcha: YAML dates (`last_verified: 2026-10-19`) become strings under `schema:'core'`; keep them as ISO strings in the zod schema. Guard `maxAliasCount` default is fine; set `{ maxAliasCount: 20 }`.
- Wikilinks: no library needed. Strip fenced code blocks and inline code first, then `/\[\[([^\[\]|#\n]+)(?:#[^\]|]*)?(?:\|[^\]\n]*)?\]\]/g`; slug = `trim().toLowerCase()` slugified identically to item slugs; resolve per project (and fall back to shared space); store unresolved links as dangling edges so backlinks appear when the target is created. Re-extract on every revision write in the same transaction. Optionally escape: ignore `\[[x]]`.

## 9. Zod

zod 4.6.7 (`latest`, 2026-10-12). Import `from 'zod'` (v4 API is the default export in 4.x). Same schema package shared between server and web (`packages/shared`). `@hono/zod-validator` 0.9.1 works with zod 4 (it accepts Standard Schema); alternatively validate by hand with `schema.safeParse(await c.req.json())` to avoid the extra dependency (recommended: hand-rolled helper, fewer packages). The MCP SDK also depends on zod, so one version covers both; check the MCP SDK's peer range in the next research topic.

## 10. In-process scheduler

No library. A `jobs` table (`name pk, locked_until, last_run_at, last_status`). Every tick (`setInterval` 60 s, `unref()`ed) per job whose cadence is due:
```sql
UPDATE job_locks SET locked_until = now() + $lease, last_run_at = now()
WHERE name = $1 AND locked_until < now() RETURNING name
```
Row returned means we own the run (safe even if two containers ever share a DB). Run handler, catch/log errors, update `last_status`. Use idempotent handlers (cleanup, re-embed, device-code purge, expired observations). On SIGTERM clear timers and wait for the running job. Alternative `pg_try_advisory_lock` is session-bound and awkward with pools; avoid. Libraries (node-cron, pg-boss, graphile-worker) add deps for no MVP benefit; revisit if re-embed needs a durable queue.

## 11. pino

pino 10.4.0 (deps: sonic-boom, thread-stream, pino-std-serializers...). JSON to stdout, `LOG_LEVEL` env. Redact: `redact: ['req.headers.authorization','req.headers.cookie','*.password','*.token']` (pino uses @pinojs/redact). Skip pino-pretty in the image; use it only in dev (`pnpm dlx`/devDependency). Write a 10-line Hono middleware (request id, method, path, status, ms) instead of pino-http (not Hono-aware). Never log bodies or tokens.

## 12. Test tooling

- vitest 5.0.5 (2026-10-15; engines `^22.12.0||^24.0.0||>=26`); node:22-bookworm-slim is 22.23.x so OK. Vitest 5.0.0 only 6 weeks old; fallback 4.1.12 is the last-4.x on the `V4` tag. Integration tests: separate vitest project/config with `globalSetup` that expects `DATABASE_URL` from compose (or a GitHub Actions `services: postgres` of `pgvector/pgvector:pg17`).
- @playwright/test 1.64.1 (2026-10-14). CI: `pnpm exec playwright install --with-deps chromium` (cache `~/.cache/ms-playwright`). Smoke test runs against the built app container or `node dist`.

## 13. Docker: image, pnpm deploy, multi-arch to GHCR

Sources: https://pnpm.io/cli/deploy ; https://hub.docker.com/_/node ; docker/build-push-action README.
- `node:22-bookworm-slim`: official multi-arch (amd64, arm64, arm, ppc64le verified via Docker Hub API). Pin by minor tag + digest in the Dockerfile for reproducibility (`node:22.23-bookworm-slim`). Run as the `node` user (uid 1000). bookworm-slim has no curl; HEALTHCHECK via `node -e "fetch(...)"`.
- pnpm deploy (docs verbatim): "Since v12.2.0, pnpm deploy no longer requires injectWorkspacePackages. A linked workspace dependency is rewritten to a file: dependency in the dedicated deploy lockfile." Before that (pnpm 10/11) deploy needs `injectWorkspacePackages: true` in `pnpm-workspace.yaml` or `--legacy`. Known fail mode: `ERR_PNPM_DEPLOY_AMBIGUOUS_PEER`; fix via `overrides`.
```dockerfile
FROM node:22-bookworm-slim AS build
RUN corepack enable   # or: npm i -g pnpm@12.14.0 (corepack availability in node 22 image: verify; pin packageManager field)
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r build
RUN pnpm --filter=@spoor/server deploy --prod /out
FROM node:22-bookworm-slim
USER node
COPY --from=build /out /app
COPY --from=build /repo/packages/web/dist /app/web
CMD ["node","/app/dist/index.js"]
```
- Native-dep caution (outside topic but affects arch): onnxruntime-node (local e5 embeddings) ships prebuilt linux x64 and arm64 binaries; verify in the embeddings research. With scrypt there is no other native module in the server path. Use `$BUILDPLATFORM` for the build stage and `--platform=$TARGETPLATFORM` only for the `pnpm deploy --prod` stage if native deps exist; otherwise plain QEMU emulation works but is slow (10-20 min for arm64).
- GitHub Actions (release job):
```yaml
permissions: { contents: read, packages: write }
steps:
 - uses: actions/checkout@v7
 - uses: docker/setup-qemu-action@v4
 - uses: docker/setup-buildx-action@v4
 - uses: docker/login-action@v4
   with: { registry: ghcr.io, username: "${{ github.actor }}", password: "${{ secrets.GITHUB_TOKEN }}" }
 - id: meta
   uses: docker/metadata-action@v6
   with: { images: "ghcr.io/${{ github.repository }}", tags: "type=ref,event=branch\ntype=semver,pattern={{version}}\ntype=raw,value=latest,enable={{is_default_branch}}" }
 - uses: docker/build-push-action@v7
   with: { context: ., platforms: "linux/amd64,linux/arm64", push: "${{ github.event_name != 'pull_request' }}", tags: "${{ steps.meta.outputs.tags }}", labels: "${{ steps.meta.outputs.labels }}", cache-from: type=gha, cache-to: "type=gha,mode=max" }
```
  Pin actions by commit SHA in the real workflow (house supply-chain rule); tags above are for readability. GHCR package visibility must be set to public once manually after first push (default private). Use lowercase repository name.

## Recommendation (one paragraph)

Use hono 4.13.13 with @hono/node-server 2.1.5 (serveStatic with an index.html fallback registered after API routes), zod 4.6.7, pino 10.4.0, fflate 0.8.3 for zip with a strict entry-name allowlist and size caps, `yaml` 2.9.1 plus a small splitter instead of gray-matter, and a regex wikilink extractor that ignores code. Auth: DB-backed sessions (hashed random id in an httpOnly, SameSite=Lax cookie, secure env-driven) with a custom Origin/Sec-Fetch-Site middleware because hono/csrf does not inspect JSON requests; passwords with built-in `crypto.scrypt` (N=2^17, versioned encoding) to avoid any native build or per-arch prebuilt pruning; tokens `spr_`+32 random bytes base64url stored as SHA-256; RFC 8628 device flow with 8-char `XXXX-XXXX` codes, 15 min expiry, 5 s interval, `slow_down` adds 5 s, approval bound to a project membership and minting a per-user-per-project token once. Scheduler: setInterval plus a lease row updated with a conditional UPDATE. Tooling: vitest 5.0.5, @playwright/test 1.64.1, pnpm 12.14.0 (deploy needs no injectWorkspacePackages since 12.2.0), node:22-bookworm-slim, buildx + QEMU multi-arch push to GHCR.
