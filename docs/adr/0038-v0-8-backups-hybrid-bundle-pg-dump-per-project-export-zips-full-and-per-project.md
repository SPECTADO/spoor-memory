---
spoor_id: 6e24f3d3-26e9-49a6-93db-69d97d53307c
adr: 38
title: "v0.8 backups: hybrid bundle (pg_dump + per-project export zips), full and per-project restore from the web UI, async Markdown zip"
status: proposed
date: 2026-11-26
deciders: [ladislav.soukup@gmail.com]
drafted_from: [m65]
tags: [backup, v0-8, deployment, data]
anchors: [packages/server/src/modules/backup/pgtools.ts, packages/shared/src/api/backups.ts, Dockerfile, docker-compose.yml, docs/design/api.md]
---
# v0.8 backups: hybrid bundle (pg_dump + per-project export zips), full and per-project restore from the web UI, async Markdown zip

Decided by the owner, Ladislav Soukup, on 2026-11-26 (BRIEF.md amendment "v0.8 Backups"). Restore mechanics:
ADR-0039. Schedule and retention: ADR-0040. Markdown zips: ADR-0041.

## Context
Backups must cover both the whole database and individual projects. Until 0.7 an operator had only `pg_dump` by
hand and the per-project export zip. Running pg_dump into a scratch database to restore one project would need the
superuser URL at runtime. An app-level NDJSON archive of every table would mean more custom code and its own
migration replay. The raw database dump holds password, session and token hashes, so it must stay out of the web
UI. ADR-0002 made Postgres the only store, and ADR-0020 rules out file and attachment storage.

## Decision
1. **A directory bundle per backup** in `SPOOR_BACKUP_DIR/backups/<id>/`, id `YYYYMMDDTHHMMSSZ-auto|manual|pre-restore`
   (validated on every route, so no path traversal). It holds:
   - `database.dump`: `pg_dump -Fc -Z6 --no-owner --no-privileges -n public -n drizzle --lock-wait-timeout=60s`, without
     the data of `sessions`, `device_codes`, `request_log` and `resource_samples`, run as the runtime role. Extensions
     are not in it (superuser-owned; they already exist in the target).
   - `projects/<slug>.zip`: one `spoor-export/1` archive per project including `_shared`, built by the existing
     `buildExport(history: true)`; over the size cap it retries with `history: false`; a project busy with an import
     or export is retried 3 times and then recorded as skipped (restorable only by a full restore). User-facing
     exports and imports are delayed at most briefly.
   - `backup.json` (`spoor-backup/1`): id, kind, created_at, Spoor version, migration count and last tag, server and
     pg_dump versions, every file with size and sha256, the projects with their archive or skip reason, `pinned`,
     `verified_at`.
2. **Written safely**: under `.tmp/<id>/` (directories 0700, files 0600) after a free-space check, verified
   (`pg_restore` reads the dump to a null sink, sha256 of every file), fsynced, then renamed into `backups/`. A `.tmp`
   entry older than 24 hours is swept. A directory without a valid `backup.json` is never listed and never pruned.
3. **The directory is the catalog.** No database table lists backups, so restoring the database cannot rewind the
   list; `pinned` lives in `backup.json`.
4. **The pg client tools are in the image**: `postgresql-client-17` from the PGDG apt repo (key pinned by checksum,
   `signed-by`, major pinned), `SPOOR_PG_BIN_DIR=/usr/lib/postgresql/17/bin`. They are spawned without a shell; the
   connection goes only through `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE` (+`PGSSLMODE`) and data only
   through stdin and stdout pipes (no URL or file path in argv). Missing tools, or a server major newer than the
   tools, make backups `unavailable` with a reason; the app still starts.
5. **One heavy operation at a time** (backup, restore) across containers: an advisory lock plus an in-process flag;
   a second one gets 503 `busy`.
6. **`database.dump` is never downloadable from the web UI.** Operators copy it from the volume.

### Reconciling with "Postgres is the only state" (ADR-0002) and ADR-0020
Postgres stays the only store of the application's data: no request reads its answer from the backup directory
except the backup routes themselves. The directory is operator state next to the database, like the pgdata volume:
it holds copies of the database and of projects, the Markdown zips of ADR-0041 and safety archives, all with an
expiry. ADR-0020 is not superseded: users still cannot store files or attachments in Spoor, and nothing in the
backup directory is user content that exists nowhere else.

## Consequences
- Full database restore and single-project restore (as a copy or by overwrite) become possible from the web UI,
  without a superuser URL at runtime and without parsing the dump in the app.
- The image grows by the pg client and the deployment gains a second volume (`spoor-backups`) or a bind
  mount writable by uid 1000.
- The tools' major must follow the database's major; an upgrade of Postgres needs a new image.
- Tests run the real tools when they exist (CI installs `postgresql-client-17`) and otherwise a `docker exec` shim
  into the test database container (`packages/server/test/pg-shim`), which the pipes-only rule makes possible.
- A backup on the same disk as the database protects against mistakes and bad migrations, not against losing the
  host; operators copy the bundles elsewhere (operations.md).

## Alternatives considered
- pg_dump plus a scratch database for single-project restore: needs the superuser URL at runtime.
- An app-level NDJSON archive of every table: more custom code and its own migration replay.
- A `backups` table as the catalog: a database restore would rewind it, and it would list bundles that no longer
  exist on disk.
- Downloading the dump from the web UI: it holds password and token hashes; a browser download spreads them.
