# Memory — Spoor memory   ·   cleaned 2026-10-20 (Library added)

## Facts
- BRIEF.md is the agreed contract (grilled 2026-10-19); change it before changing code.
- Design docs live in docs/design/*, research in docs/research/*; ADRs in docs/adr/.

## Preferences
- Owner wants questions one at a time, each with a recommended answer.
- Build runs as ultracode workflows per phase with an owner checkpoint between phases.
- Commit only when the owner asks.

## Now
- Library space (ADR-0014, BRIEF amendment 2026-10-20) built 2026-10-20 by ultracode workflows: fourth space `library`, handle L<n>, human-only writes (IA/PA/`library_editor` flag), digest tier 0, no mirror. Owner chose: outgoing links from library pages allowed, capture/takeover blocked, conflicts_with refused. Uncommitted until the owner asks. Known limit: an agent driving a logged-in browser session is indistinguishable from the human (same as shared).
- Parallel integration tests: one `_test` database per agent on the test container (`docker exec spoor-test-db psql -U spoor -d spoor_test -c "CREATE DATABASE spoor_x_test"`, then DATABASE_URL=…/spoor_x_test); the harness truncates tables, so never share one.
- Build complete 2026-10-20 (phases 1–5, all DoD items met locally; see docs/design/dod-status.md). Pushed to github.com/SPECTADO/spoor-memory (public since 2026-10-20; npm provenance needs public); first CI run green 2026-10-20.
- Decided 2026-10-20: digest default 1500 real tokens; alwaysLoad kept; npm name unscoped spoor-memory (owner registers at first v0.1.0 release: NPM_TOKEN, GHCR public, versions 0.0.0 → 0.1.0).
- Released v0.1.0 on 2026-10-20: npm spoor-memory@0.1.0 (provenance; repo must stay public for that) and ghcr.io/spectado/spoor-memory:0.1.0 (public, amd64+arm64). Release = bump 4 package versions, date CHANGELOG, tag v*; docs/operations.md §10.
- Server tests need pgvector Postgres: `pnpm test:db:up` (docker, port 55432); e2e: `pnpm e2e` (Playwright chromium) and `pnpm --filter @spoor/server test:e2e`.
- Dev-only advisory GHSA-67mh-4wv8-2f99 (esbuild via drizzle-kit); not in the image.
