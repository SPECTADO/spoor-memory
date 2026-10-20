# Changelog

All notable changes. Format after Keep a Changelog; versions follow semver.

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
- Out of scope by design: SSO, email, graph visualisation, server-side LLM calls, rate limiting, agent writes to the shared space,
  pulling ADRs or docs back into the repository.
