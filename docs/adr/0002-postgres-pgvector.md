# ADR-0002: Postgres with pgvector as the only store

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Ladislav Soukup (owner), Claude (Fable 5.1, architect)
- **Tags:** database, schema

## Context

Spoor stores items, chunks, full-text indexes, vectors, jobs, sessions, tokens and an audit trail for small self-hosted teams. Operating several stores would burden self-hosters. Source: `docs/design/data-model.md`, `deployment.md`, `docs/research/postgres-pgvector-drizzle.md`.

## Decision

We will use PostgreSQL 17 with pgvector as the single store, running as the pinned image `pgvector/pgvector:0.8.7-pg17` (D3, not the floating `pg17` tag). Full text, vectors, job leases and web sessions all live in it. Two roles (I40): a superuser used only for `CREATE EXTENSION` and migrations, and a `NOSUPERUSER` runtime role `spoor_app` that owns the tables. History is append-only (I6, I7): `item_revisions` and `audit_log` reject UPDATE and DELETE through triggers, except inside the human hard-delete and project-delete transactions, which set `SET LOCAL spoor.allow_purge='on'`; only content changes create revisions. An `spoor_edge_scope` trigger enforces project scope of edges (I42). Imported history is marked `via='import'` (I41).

## Consequences

One backup, one transaction boundary: a write, its chunks and its revision commit atomically. Operations are simple. The price is that vector search shares CPU and memory with OLTP and that purge logic needs a controlled trigger bypass that must be tested. Upgrading pgvector is a deliberate image bump.

## Alternatives considered

- **Floating `pg17` tag** - silently upgrades pgvector (D3).
- **SQLite or a dedicated vector DB** - second store, no shared transactions, weaker multi-user concurrency.
- **Elasticsearch or Redis for jobs/sessions** - extra services for little gain at this scale.
- **Mutable history with soft deletes only** - cannot honour real deletion yet keep an honest audit trail.
