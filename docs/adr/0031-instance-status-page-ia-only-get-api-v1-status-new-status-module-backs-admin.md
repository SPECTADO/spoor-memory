---
spoor_id: be9fd264-2951-4f8a-9724-3cfc6811d2cf
adr: 31
title: "Instance status page: IA-only GET /api/v1/status (new status module) backs /admin/status"
status: proposed
date: 2026-11-10
deciders: [ladislav.soukup@gmail.com]
drafted_from: [m50]
tags: [status, admin, web-ui]
anchors: [packages/server/src/modules/status/service.ts, packages/web/src/pages/admin/StatusPage.tsx, docs/design/api.md]
---
# Instance status page: IA-only GET /api/v1/status (new status module) backs /admin/status

## Context
The owner asked for a "deploy status" page. The status view had to be read-only and free of secrets. It also reports hostname, table sizes, and usage counts, so it must be limited to instance administrators. The status module reads the MCP session count and scheduler state through `StatusSources` callbacks instead of reaching into other modules' internals.

## Decision
We will add a status module that serves a read-only, secret-free instance snapshot at `GET /api/v1/status`, limited to instance admins. The admin UI at `/admin/status` renders that snapshot.

## Consequences
- Operators can see version, uptime, embedding configuration, record counts, and Postgres health in one view.
- The status module depends only on the `StatusSources` callbacks, so it does not depend on other modules' internals.
- Trade-off: table sizes are `reltuples` estimates, not exact counts.
- Trade-off: each new value that comes from another module needs a new callback to be wired in.
- Trade-off: non-admin users cannot see the page, which is the cost of protecting the hostname and usage data.
- The endpoint is documented in `docs/design/api.md` §10.4, and the UI in `docs/design/web-ui.md`.

## Alternatives considered
- Read the MCP session count and scheduler state directly from module internals.
