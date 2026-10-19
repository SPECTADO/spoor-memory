# Memory — Spoor memory   ·   cleaned 2026-10-20

## Facts
- BRIEF.md is the agreed contract (grilled 2026-10-19); change it before changing code.
- Design docs live in docs/design/*, research in docs/research/*; ADRs in docs/adr/.

## Preferences
- Owner wants questions one at a time, each with a recommended answer.
- Build runs as ultracode workflows per phase with an owner checkpoint between phases.
- Commit only when the owner asks.

## Now
- Build complete 2026-10-20 (phases 1–5, all DoD items met locally; see docs/design/dod-status.md). Initial commit 3bca21b on main; nothing pushed.
- Decided 2026-10-20: digest default 1500 real tokens; alwaysLoad kept; npm name unscoped spoor-memory (owner registers at first v0.1.0 release: NPM_TOKEN, GHCR public, versions 0.0.0 → 0.1.0).
- Decided 2026-10-20: no permission rule written by login; export cap = import cap 200 MB. No open owner decisions; next step is the first release (owner: GitHub remote, NPM_TOKEN, tag v0.1.0).
- Server tests need pgvector Postgres: `pnpm test:db:up` (docker, port 55432); e2e: `pnpm e2e` (Playwright chromium) and `pnpm --filter @spoor/server test:e2e`.
- Dev-only advisory GHSA-67mh-4wv8-2f99 (esbuild via drizzle-kit); not in the image.
