---
adr: 41
title: "Markdown zips are async export tasks: a table, an in-process runner and an exports job"
status: proposed
date: 2026-11-26
deciders: [ladislav.soukup@gmail.com]
tags: [export, transfer, jobs, v0-8]
anchors: [packages/server/src/db/schema.ts, packages/server/src/modules/transfer, packages/shared/src/api/backups.ts, docs/design/api.md]
---
# Markdown zips are async export tasks: a table, an in-process runner and an exports job

Decided by the owner, Ladislav Soukup, on 2026-11-26 (BRIEF.md amendment "v0.8 Backups"). Bundle: ADR-0038.

## Context
People want to read a project, live or from a backup, as plain Markdown files. The existing export
(`GET …/export`) is synchronous, runs on the request thread and holds the one-at-a-time transfer flag; a large
project would hold a request and block imports for its whole duration. A Markdown zip from a backup must not parse
the database dump.

## Decision
1. **One code path**: `markdownZip(parsed: ParsedArchive, source)`. Live: `buildExport(history: false)` then
   `parseArchive`. From a backup: `projects/<slug>.zip` (sha256 checked first) then `parseArchive`.
2. **Flat, re-importable layout**, file `spoor-<slug>-markdown-<YYYYMMDD>.zip`: `README.md` (an index: project,
   source `live` or backup id, date, counts, tables grouped by space and memory type with handle, title, status and a
   relative link; inactive items listed separately), `memories/<slug>.md`, `decisions/<NNNN>-<slug>.md`,
   `docs/<slug>.md`, `library/<slug>.md`, each with the canonical export frontmatter and body. No manifest, so the
   importer treats it as a manifest-less archive; it skips a root `README.md`.
3. **Table `export_tasks`** (`id, project_id → projects SET NULL, backup_id, source_project_id, format CHECK
   ('markdown'), requested_by → users, status CHECK (queued|running|ready|failed|expired), file_name, size_bytes,
   sha256, error, heartbeat_at, created_at, finished_at, expires_at`). `POST` inserts `queued` and answers 202 with
   the task; an in-process runner (concurrency 1) claims rows with `FOR UPDATE SKIP LOCKED`. At most 3 open tasks per
   user (503 `too_many_pending`).
4. **Job `exports`, every minute**: picks up queued rows left after a restart, fails running rows whose heartbeat is
   older than 5 minutes, deletes ready files after 24 hours (status `expired`) and safety archives older than 14
   days.
5. **Files** in `<SPOOR_BACKUP_DIR>/exports/<id>.zip`, written as `.partial` and renamed. Without
   `SPOOR_BACKUP_DIR` they go to `os.tmpdir()/spoor-exports-<hash of the database>` (single replica only; one
   directory per database, refused unless owned by the server's user with mode 0700). Implementation note
   (2026-11-26, after review): files are opened `O_NOFOLLOW` (and the partial `O_EXCL`), a download streams the
   handle it checked; the runner re-checks the requester's access before it reads, and `get` / `download` re-check
   it for non-admins; every start nudges the runner, and a new task fails its user's stale running tasks. The runner never holds the
   transfer busy flag while zipping (only while `buildExport` reads).
6. **Download** `GET /api/v1/exports/:id/download`: a cookie GET with `Content-Disposition`, for the requester or an
   instance admin; a plain `<a download>` link in the SPA.

## Consequences
- Large zips no longer hold a request or block imports; the SPA polls the task list every 5 s while a task is
  open.
- The same zip format serves reading, sharing and re-import.
- A second table and a job to keep tidy; files outlive their database row only until the next `exports` run.
- With several replicas and no shared `SPOOR_BACKUP_DIR`, the download may land on a replica without the file;
  documented as single replica only.

## Alternatives considered
- A synchronous Markdown export like `GET …/export`: holds the request and the transfer flag.
- Generating the zip in the browser: would download the whole project as JSON first and duplicate the
  frontmatter code.
- Storing the zip in Postgres: against ADR-0020's spirit and bloats the database and its backups.
