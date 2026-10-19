# Memory — Spoor memory   ·   cleaned 2026-10-20

## Facts
- BRIEF.md is the agreed contract (grilled 2026-10-19); change it before changing code.
- Design docs live in docs/design/*, research in docs/research/*; ADRs in docs/adr/.

## Preferences
- Owner wants questions one at a time, each with a recommended answer.
- Build runs as ultracode workflows per phase with an owner checkpoint between phases.
- Commit only when the owner asks.

## Now
- Build complete 2026-10-20 (phases 1–5, all DoD items met locally; see docs/design/dod-status.md). Nothing committed or pushed yet.
- Open owner decisions: initial commit; ADR-0012 acceptance; digest default budget after estimator recalibration (1500 vs 2200); alwaysLoad tool-list cost (~3.3k tokens/session); npm name + first release (versions 0.0.0 → 0.1.0, NPM_TOKEN, GHCR public); login writing mcp__spoor into settings.local.json; export 500 MB vs import 200 MB cap (G12).
- Server tests need pgvector Postgres: `pnpm test:db:up` (docker, port 55432); e2e: `pnpm e2e` (Playwright chromium) and `pnpm --filter @spoor/server test:e2e`.
- Dev-only advisory GHSA-67mh-4wv8-2f99 (esbuild via drizzle-kit); not in the image.
