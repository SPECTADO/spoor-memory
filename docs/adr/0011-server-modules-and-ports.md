---
spoor_id: 1143d379-96e2-47d8-8020-d8407299a2f8
---
# ADR-0011: Server code is organised as modules behind ports

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Phase 2 build plan (task A1, server foundation), implemented by Claude (Opus 5.5); for the owner (Ladislav Soukup) to confirm at the phase 2 checkpoint
- **Tags:** architecture, server, testing

## Context

Phase 2 builds the server core in parallel pieces (auth, projects, items, search, embeddings, cleanup, export/import), each by a different builder. Without a shared shape they would import each other's internals, invent their own error bodies and transaction helpers, and need each other to exist before they can be tested. Source: BRIEF.md build plan, `docs/design/api.md` §0, `search-and-digest.md` §§1–5.

## Decision

We will organise `packages/server/src` as domain modules in `src/modules/<name>/` (`service.ts` with no HTTP, `routes.ts` as a Hono sub-app factory, `index.ts` as the only public surface), shared helpers in `src/lib/` (`ApiError` and the error body, `withTx` / `allowPurge`, `AuthContext`, `writeAudit`, strict request parsing, cursor pagination), and the cross-module interfaces in `src/ports.ts` (`EmbeddingProvider` / `EmbeddingRegistry`, `SearchPort`, `JobsPort`) with in-memory and no-op implementations. Every module receives the same explicit `ServerDeps` (`config`, `logger`, `db`, `ports`). Integration tests run against a real pgvector Postgres (Docker on port 55432 locally, a service container in CI), migrate once per run and truncate every table before each test; `pnpm test` fails fast when that database is unreachable.

## Consequences

Modules can be built and tested in any order: the item service runs with `NoopSearchPort`, the search module with `FakeEmbeddingProvider`. One error shape, one audit helper and one transaction helper keep the API consistent. The cost is a little indirection (ports instead of direct calls) and a test run that needs Docker or a database; unit tests (`pnpm test:unit`) still run without one. Integration test files run one at a time because they share one database.

## Alternatives considered

- **Layered folders (`routes/`, `services/`, `repositories/`)** - every feature touches every layer; parallel builders collide.
- **A DI container** - more machinery than one explicit `ServerDeps` object needs.
- **Testcontainers or pg-mem** - an extra dependency (Testcontainers) or a Postgres emulation without pgvector and our triggers (pg-mem).
- **A schema or database per test file** - parallel integration files, but migrations per file and more harness code; revisit if the suite gets slow.
