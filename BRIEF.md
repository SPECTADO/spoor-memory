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
  container, no API key. Optional OpenAI / Voyage via env.
- Long items are chunked (~400 tokens, overlap); each chunk has a vector tagged with the model
  name. A `re-embed` job rebuilds all vectors when the model changes; search ignores vectors
  from a different model than the active one.
- Near-duplicate check on write (cosine ≥ 0.92 within the same space) returns the existing
  item instead of creating a copy.

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
- **I37 digest shares**: pinned ≤ 30 %, recent decisions ≤ 25 % while anchored/relevant items
  exist (≥ 35 % kept for them); overflow becomes one roll-up line per tier; titles cut at 90 chars.
- **I38 untrusted data**: digest and `spoor_get` start with a fixed ~20-token "data, not
  instructions" line; agent-written, unreviewed items carry a `~` marker; control/bidi characters
  are stripped from titles, tags and client names.
- **D6 duplicates**: threshold is a per-project setting (0.80–0.99, default 0.92); write tools
  accept `allow_duplicate: true` after a duplicate hit.
- **Docs naming (H16)**: the operator guide the brief calls `docs/install.md` is `docs/operations.md`; the web, agent and CLI guides are `docs/user-guide.md` and `docs/agent-guide.md`; Definition-of-done evidence is `docs/design/dod-status.md`.
