---
adr: 40
title: "Instance-wide settings live in an instance_settings table; scheduled backups use tiered retention and are off by default"
status: proposed
date: 2026-11-26
deciders: [ladislav.soukup@gmail.com]
tags: [backup, settings, jobs, v0-8]
anchors: [packages/server/src/db/schema.ts, packages/shared/src/api/backups.ts, packages/server/src/modules/backup/retention.ts, packages/server/src/modules/jobs/definitions.ts]
---
# Instance-wide settings live in an instance_settings table; scheduled backups use tiered retention and are off by default

Decided by the owner, Ladislav Soukup, on 2026-11-26 (BRIEF.md amendment "v0.8 Backups"). Bundle: ADR-0038.

## Context
The backup schedule must be edited in the web UI by an instance admin, so it cannot be an env var. Until 0.8 every
setting was either env (instance) or `projects.settings` (per project). Operators want a few recent backups plus a
few older ones without doing date arithmetic, and a failed or broken backup must never cost them the good ones.

## Decision
1. **Table `instance_settings(key text PK, value jsonb, updated_at, updated_by → users ON DELETE SET NULL)`.** Key
   `backup` holds the shared zod `BackupSettings`: `enabled` (default false), `time_utc` `HH:MM` (default `03:00`),
   `tiers` (1 to 3, each `every` of `24h | 48h | 7d` at most once, `keep` 1 to 90; default 3 × 24h and 2 × 7d),
   `project_archives` (default true). A stored value that fails validation falls back field by field to the
   defaults. A full restore writes the live value back (ADR-0039), so restoring never changes the schedule.
2. **Off until an instance admin enables it.** The form is prefilled with the defaults.
3. **Job `backup`, every 15 minutes** (cadence stays a design constant), lease renewed while working. The handler
   decides: enabled, directory usable, now past today's `time_utc` slot, and no auto backup since the due slot. The
   cadence is the smallest tier interval (`48h` = every other epoch day). "Back up now" makes a `manual` backup.
4. **Pruning is a pure function**, run only after a new backup succeeded and verified. Per tier, auto backups are
   bucketed (UTC day for `24h`, epoch-day div 2 for `48h`, ISO week for `7d`); the newest per bucket is kept until
   `keep` buckets are filled. The keep set is the union of the tiers plus the newest verified backup (always),
   pinned backups, pre-restore backups younger than 14 days and every manual backup. Only `auto` bundles (and
   pre-restore bundles older than 14 days) with a valid `backup.json` are ever deleted. A failed run never prunes.
5. Audit rows: `backup.create` and `backup.prune` (system actor), `backup.delete`, `backup.pin`,
   `backup.settings`. The Status page warns when backups are enabled and the newest good one is older than twice
   the cadence.

## Consequences
- One generic place for future instance-wide settings, without new env vars or restarts.
- "Keeps up to N backups" is a simple sum the UI can preview; buckets of different tiers may share a backup.
- Manual backups accumulate until deleted by hand; that is deliberate (they were asked for).
- Disk use is bounded by the tiers only for auto backups.

## Alternatives considered
- Env vars for the schedule: not editable in the UI, needs a restart.
- A `settings` key on the `_shared` project: mixes instance and project settings and is restored with the database.
- Plain "keep the last N": loses all older restore points after one bad day.
