---
spoor_id: 90426e3b-b9c5-458a-9c62-ebcbe84c4b0d
---
# ADR-0018: An agent request log, kept 14 days, readable by admins

- **Status:** Accepted
- **Date:** 2026-10-21
- **Deciders:** Ladislav Soukup (owner), Claude (Opus 5.5)
- **Tags:** observability, privacy, data-model, web

## Context

The owner wants the project dashboard to show the last read and the last write, and wants admins to see who read and wrote
memory: agent, token, time, memory type and more. The audit log (data-model.md §4) records only writes, keeps rows forever and is
readable by every member. It has no reads at all: a `spoor_search`, `spoor_get` or the SessionStart digest leaves no trace except
`items.last_used_at`.

## Decision

- A new table `request_log` holds one row per **agent request**: every `spoor_*` MCP tool call (recorded by the tool wrapper
  `guarded`) and every call of the bearer REST API `/p/:slug/api/*` used by the spoor CLI and its hooks (a middleware after the
  bearer guards). `GET /whoami` is skipped (a login check, not memory access). Web UI requests are not logged: their writes are
  already in the audit log.
- A row carries: time, project, `kind` (`read` | `write`), `surface` (`mcp` | `cli`), `operation` (tool name or `METHOD /path`),
  the actor (user id and label), the token (id, name, prefix), the agent (`client_name`), the space and memory type, the handles
  read or written (at most 50), the search or digest query (at most 200 characters), the outcome (`ok` or the error code), the
  duration and a small `data` object (digest files, tags, HTTP status).
- Rows are kept **14 days**: the hourly `purge-ephemeral` job deletes older ones. Rows go with their project (FK cascade). Actor
  and token columns are snapshots without FKs, like `audit_log`.
- **Project admins and instance admins** read the log (`GET /api/v1/projects/:slug/requests`, permission `requests.read`); other
  members get 403. `_shared` has no log (tokens never target it). The dashboard shows **every member** only the newest read and
  the newest write (`last_requests`).
- Writing a row never fails the request: an insert error is logged and dropped.

## Alternatives rejected

- **Reads in the audit log.** It is append-only, kept forever and readable by every member; a read on every tool call would
  swamp the change history and keep search queries indefinitely.
- **Logging web UI traffic too.** Much noisier, and the question asked is what agents do.
- **No free text.** Storing only structured fields hides what agents look for; a truncated query, purged after 14 days, was
  chosen instead.

## Consequences

- One extra insert per tool call and per CLI call; the table stays small because of the 14-day purge.
- Search queries typed by agents are visible to project admins for 14 days. The user guide says so.
- A new permission row (`requests.read`) in the matrix of auth-and-security.md §7.
