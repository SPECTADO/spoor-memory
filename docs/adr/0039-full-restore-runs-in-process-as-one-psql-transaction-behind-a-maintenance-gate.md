---
adr: 39
title: "A full restore runs in the app process as one psql transaction behind a maintenance gate"
status: proposed
date: 2026-11-26
deciders: [ladislav.soukup@gmail.com]
tags: [backup, restore, v0-8, operations]
anchors: [packages/server/src/modules/backup/restore.ts, packages/server/src/db/client.ts, packages/shared/src/api/backups.ts, docs/design/api.md]
---
# A full restore runs in the app process as one psql transaction behind a maintenance gate

Decided by the owner, Ladislav Soukup, on 2026-11-26 (BRIEF.md amendment "v0.8 Backups"). Bundle: ADR-0038.

## Context
An instance admin must be able to put the whole database back to a backup from the web UI. The app runs as the
`spoor_app` role, which owns every table but is not a superuser, and it holds the only connection pool. A restore
that fails half-way must leave the old database intact; a restore that succeeds must not leave the running process
with stale sessions, a running scheduler or open MCP sessions. Several app containers may share one database.

## Decision
1. **Two steps, two confirmations.** `POST /api/v1/backups/:id/restore/prepare` checks the sha256 of the dump and
   that `pg_restore` can list it, refuses a backup with more migrations than this image knows (409
   `backup_too_new`) and a database with other Spoor app instances connected (409 `other_instances`), and returns
   the warnings, a summary, a 5-minute in-memory token bound to the session and the backup, and the phrase to type
   (`RESTORE 2026-11-20 03:00`). `POST /api/v1/backups/:id/restore {token, password, phrase}` checks the admin's
   password and the phrase (403 `confirmation_failed`) and answers 202; the restore runs in the background.
2. **Other instances are seen through `application_name`.** Every pool and the migration client set
   `application_name = 'spoor:<host>:<pid>:<random>'`; prepare and the restore look in `pg_stat_activity` for other values
   with that prefix.
3. **Execution, in order:** a synchronous pre-restore backup (abort when it fails); `restore-state.json`
   `{phase, nonce, …}` in the backup directory; the maintenance gate (every route except `/healthz` and
   `GET /api/v1/backups/restore-status` answers 503 `maintenance`; `/healthz` stays 200 so orchestrators do not
   restart the container); stop the scheduler, close MCP sessions, wait up to 30 s for requests in flight; then
   **one transaction**: `psql -X -1 -v ON_ERROR_STOP=1` reading on stdin a prelude, the `pg_restore` script and an
   epilogue. The prelude sets `lock_timeout` and drops schema `drizzle` and every table, function and type in
   `public` owned by the current user that is not an extension member. The epilogue truncates sessions and device
   codes, resets `job_locks`, marks running `job_runs` interrupted, re-applies the token revocations captured before
   the restore, and inserts an `instance.restore` audit row carrying the nonce (the commit proof; it tolerates an
   older schema). Then the startup steps run again (migrations forward for an older dump, `ensureSharedProject`,
   seed, `bootstrapAdmin`, `syncEmbeddingTargets`, scheduler start), the live `instance_settings` `backup` value is
   written back, and the gate opens.
4. **Failure leaves the old database.** Any error rolls the transaction back. At boot, `restore-state.json` plus
   the presence of the nonce's audit row decide `done` or `interrupted`; the UI shows which.
5. Everyone logs in again afterwards.

## Implementation notes (2026-11-26, worked out against PostgreSQL 17)
These refine point 3; the decision itself is unchanged.
- **No `psql -1`.** The prelude says `BEGIN` and only the epilogue, appended after `pg_restore` exited 0 and the bytes it
  read matched `backup.json`, says `COMMIT`. `psql -1` would COMMIT at the end of its input, so a dump stream cut in the
  middle (even inside a `COPY`) would commit half a database; without `-1` an input that ends without `COMMIT` rolls
  back. psql exits 0 in that case too, which is why the nonce row is the only commit proof.
- **`pg_restore -n public -n drizzle`.** The script then holds no `CREATE SCHEMA` and no `COMMENT ON SCHEMA public` (which a
  non-owner may not run). So the prelude keeps schema `drizzle` and drops what is in it instead of the schema itself (no
  `CREATE` on the database needed).
- **The prelude drops without CASCADE**, in this order: views, materialized views, tables (one `DROP TABLE a, b, …`, so
  foreign keys between them are fine), standalone sequences, routines, domains, other types; only objects the current
  role owns that are not extension members, in `public` and `drizzle`. An object of another role that depends on them stops
  the restore (and it rolls back) instead of being dropped.
- **`GET /api/v1/backups/restore-status` during maintenance** is answered by the gate itself, without a session lookup,
  with the redacted status for every caller.
- **A failure after the commit** (a startup step) keeps the gate on and asks for a restart; the next start resolves the
  state from the nonce. Writes made between the end of the pre-restore backup and the gate are in neither database.
- **The live `backup` settings are kept in `restore-state.json`** (captured before the transaction, with
  `settings_written_back: false`). A process that dies or fails after the commit leaves the flag false; the next start
  writes the settings back before it reports `done` (or stays `failed`, naming the settings).
- **Credentials are captured, not only token revocations** (2026-11-26, Ladislav Soukup with Claude, after review): the
  epilogue re-applies live token revocations, `users.disabled_at`, newer password hashes (`password_changed_at`) and
  invite revocations, revokes restored invites used live, and, when the restored database holds the live `_shared`
  project id (a backup of this same instance), revokes restored tokens absent live (deleted, also by cascade with their
  user or project), revokes invites absent live and disables users absent live. Without that check a backup of another
  instance (a move to a new server) would come back with every user disabled. Prepare warns with code `security`.
- **`application_name` is `spoor:<host>:<pid>:<8 random hex>`** (the host is cut to fit 63 bytes; two pods with long
  names and pid 1 still differ), and the runtime pool keeps one connection (`min: 1`), so an idle instance stays visible
  in `pg_stat_activity`. A connection lost to an error comes back with the next query (the 15 s health check).

## Consequences
- No superuser URL and no second database are needed; the restore is atomic because Postgres DDL is
  transactional.
- The instance is unavailable for the duration (seconds to minutes); `/healthz` stays green on purpose.
- The restore needs exclusive use of the database: with several replicas, the others must be stopped first.
- Credentials revoked, disabled, changed or deleted after the backup stay that way (see the implementation notes);
  tokens created after it are gone. Roles and memberships are rewound with the data.
- The approach depends on `pg_restore` emitting a plain SQL script that `psql` can run in one transaction, which
  holds for the custom format without `--create`.

## Alternatives considered
- `pg_restore --clean` straight into the database: not atomic, leaves a mixed database on error.
- Restore into a scratch database and rename: needs CREATEDB or a superuser, and every connection must move.
- A restore CLI outside the app: no web UI, and the running process would keep stale state.
