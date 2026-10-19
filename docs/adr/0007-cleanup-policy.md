# ADR-0007: Cleanup policy: stale, archive, expire, human delete

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Ladislav Soukup (owner), Claude (Fable 5.1, architect)
- **Tags:** lifecycle, jobs

## Context

Memories rot, but silently deleting knowledge is worse than clutter. Source: `docs/design/cleanup-and-jobs.md`; settles D9, I8, I9, I43 and the in-process scheduler topic of `deviations.md` section D.

## Decision

We will use exact SQL predicates evaluated per job transaction. `P_stale`: an active, unpinned, non-observation memory whose newest of verified, updated or used time is older than `stale_days` (30). `P_archive`: stale for `archive_days` (90) and also not used within `stale_days` (D9, a deliberate deviation from the brief's unconditional archive; used items stay in the review queue). `P_expired`: observations past `expires_at` (7 days default) are archived. `last_used_at` is bumped only by `spoor_get`, a near-dup hit and `spoor_relate` targets, never by digest or search (I9). Pin counts as verification; decisions and docs never auto-stale (I8, I43). Nothing is auto-deleted: hard delete is a human web action and the audit row survives. Jobs run in an in-process scheduler (`setInterval` 60 s with jitter) holding DB leases in `job_locks`, renewed per batch, released on SIGTERM.

## Consequences

Live knowledge is never hidden from search, and a crashed instance simply loses its lease. Review queues may grow if humans ignore them. Scheduler logic is tested in-process, which assumes few instances.

## Alternatives considered

- **Literal brief rule (archive regardless of use)** - hides knowledge agents used yesterday (D9).
- **Reads bump `last_used`** from digest/search - everything stays fresh forever (I9).
- **External cron or queue (pg-boss, Redis)** - extra moving parts.
- **Auto-delete expired items** - irreversible.
