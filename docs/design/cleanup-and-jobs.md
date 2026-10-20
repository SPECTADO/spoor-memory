# Self-cleanup and background jobs

Status: design, 2026-10-19. Columns are defined in [data-model.md](data-model.md) §3. The defaults
come from `projects.settings.cleanup`: `stale_days` 30, `archive_days` 90, `observation_days` 7.

## 1. Lifecycle state machine

Two separate axes:
- `status` is domain status. Memories: `active` or `superseded`. Decisions: `proposed`, `accepted`,
  `superseded` or `deprecated`.
- `lifecycle` is housekeeping: `active`, `stale` or `archived`.

Only memories become stale automatically. Decisions and docs change lifecycle only by hand, and
otherwise are only superseded (BRIEF.md). Library pages (ADR-0014) are `active` or `archived` and move between the two only by a human with the library right: they are never stale, never expire, are not pinned or verified, and are outside every cleanup predicate (the job predicates are memories-only; a scenario test keeps an old, unused library page active). Their `status` is always `active`.

```
            job: P_stale                     job: P_archive
  active ──────────────────────▶ stale ──────────────────────▶ archived(reason=stale)
    ▲  ▲                           │                                 │
    │  └ verify/pin/content update ┘                                 │
    │                                                                │
    └──────────── human restore (web) ◀──────────────────────────────┘
  active|stale ── job: P_expired (observations) ──▶ archived(reason=expired)
  active|stale ── human archive (web) ───────────▶ archived(reason=manual)
  any ── human hard-delete (web, PA/IA; SE/IA in shared) ──▶ gone (audit row kept)
```

Exact predicates, evaluated in SQL with `now()` of the job transaction:

| name | predicate |
|---|---|
| `P_stale` | `space='memories' AND lifecycle='active' AND status='active' AND NOT pinned AND type <> 'observation' AND greatest(last_verified_at, updated_at, coalesce(last_used_at,'-infinity')) < now() - make_interval(days => stale_days)` |
| `P_archive` | `space='memories' AND lifecycle='stale' AND NOT pinned AND stale_since < now() - make_interval(days => archive_days) AND coalesce(last_used_at,'-infinity') < now() - make_interval(days => stale_days)` |
| `P_expired` | `space='memories' AND type='observation' AND lifecycle <> 'archived' AND expires_at <= now()` |

Notes on the predicates:
- "Unverified" uses `last_verified_at`. That column is set at creation (creating an item counts as
  verifying it), by `spoor_verify`, and by web verify/restore.
- A content update (a new revision) also counts as verification, through `updated_at`. Only the
  content statement (data-model.md §3) sets `updated_at`; operational updates never do.
- Pinning an item stops both staling and archiving. It does not stop the hard expiry of observations.
  A human pin also counts as verification: `pin` sets `lifecycle='active'`, `stale_since=NULL` and
  `last_verified_at=now()`, so a pinned item is never stuck as stale and out of the pinned digest tier.
- An item agents keep using is not "unused" (BRIEF): `P_archive` skips stale items with
  `last_used_at` inside the last `stale_days`, so they stay in the review queue ("used since stale")
  until a human verifies or archives them.
- Superseded memories are already out of the digest and search, so they are never staled.
- Leaving `stale`:
  - Explicit `spoor_verify` or web Verify sets `lifecycle='active'`, `stale_since=NULL` and
    `last_verified_at=now()`.
  - A content update does the same, inside the content statement itself (data-model.md §3), not in a
    separate statement that could be forgotten.
  - A plain read (`spoor_get`) bumps `last_used_at` but does **not** restore. Use is not proof of
    correctness. The review queue flags "used since stale".
- Restoring from `archived` is a human action. It sets `lifecycle='active'`, clears `archived_*` and
  `stale_since`, and sets `last_verified_at=now()`.
- Settings changes apply at the next job run. Changing `observation_days` affects only new
  observations.

## 2. Observation expiry

- `expires_at = now() + observation_days`, set on create and when `type` changes to `observation`
  (never `created_at + …`, which would make an older memory expire at once).
- The expiry is **hard**: `spoor_verify` does not extend it.
- Changing `type` away from `observation` clears `expires_at`. This is a content revision; the review
  queue calls it "Promote to fact".
- Reads exclude expired observations immediately (`expires_at > now()`) in digest, search and
  dedupe, so nothing waits for the job.
- The job only moves them to `archived(reason=expired)`. Nothing is deleted.

## 3. `last_used_at`: what counts as use

Use means an agent deliberately reached for the item. Reads that bump `last_used_at` (no revision,
no audit row, written at most once per hour per item):

| read | bumps? |
|---|---|
| `spoor_get` (each returned item) | yes |
| near-duplicate hit on create (the existing item) | yes |
| `to` of `spoor_relate` (add) | yes |
| `spoor_context` digest, any tier | **no** |
| `spoor_search` results | **no** |
| REST `context`, web UI views, exports | no |

The digest must not bump anything. It returns about 25 items at every session start, and if each
return counted as use, every item already in the digest would stay fresh forever, which defeats
cleanup. Search results are candidates, not use; the agent following up with `spoor_get` is the
signal. The write:
```sql
UPDATE items SET last_used_at = now()
WHERE id = ANY($1) AND (last_used_at IS NULL OR last_used_at < now() - interval '1 hour');
```

## 4. Scheduler

The scheduler is in-process and needs no library (docs/research/server-stack.md §10).
- `setInterval(tick, 60_000).unref()` runs with 0–10 s jitter. The first tick comes 30 s after
  startup.
- Startup seeds the lock rows with
  `INSERT INTO job_locks(name) VALUES (…) ON CONFLICT DO NOTHING`.
- Each tick, for each registered job, it tries to take the lease. Due-ness and lock-freeness are
  checked in one atomic statement, so two containers sharing a DB never run a job twice:
```sql
UPDATE job_locks
SET locked_until = now() + $lease, locked_by = $instance, last_run_at = now()
WHERE name = $name AND locked_until < now()
  AND (last_run_at IS NULL OR last_run_at <= now() - $every)
RETURNING name;
```
- If the statement returns a row, this process owns the run. It inserts a `job_runs(status='running')`
  row (`embed-pending` and `reembed`, which run every minute, do so only when there was work or the run
  failed) and runs the handler with an `AbortSignal`.
- Long handlers renew the lease after each batch:
  `UPDATE job_locks SET locked_until = now() + $lease WHERE name=$name AND locked_by=$instance`.
  If 0 rows come back, the lease was lost and the handler aborts.
- When the handler finishes:
  `UPDATE job_locks SET locked_until='-infinity', last_status=$s, last_error=$e WHERE name=$name AND locked_by=$instance`
  and `job_runs` gets `finished_at`, `status` and `stats`. Errors are logged; `last_error` holds the
  message only, never a secret.
- SIGTERM stops ticking, signals abort, waits up to 25 s for the running handler, then releases the
  lease. A crashed holder's lease simply runs out. A handler stopped by the abort or by a lost lease ends
  its run as `error` with the stats gathered so far. The server's shutdown order (scheduler and HTTP server
  together, then background import work, then the pool) is in deployment.md §4.
- The scheduler is created by the server's composition root (`packages/server/src/runtime.ts`), which also
  binds it as the `JobsPort`; `enqueue(name)` is an early nudge that skips the due check, still under the
  lease. `SPOOR_JOBS=off` disables ticking, nudges and the admin trigger, but the lock rows are still
  seeded. Instance admins can start a job at once with `POST /api/v1/jobs/:name/run` (api.md §10,
  deviations.md G1).

| job | every | lease | handler |
|---|---|---|---|
| `cleanup` | 1 h | 10 min | for each project (including shared): one transaction applying `P_expired`, `P_stale`, `P_archive` in that order, each with its audit rows (§5); a project whose transaction fails is rolled back and skipped, the others are still cleaned, and the run ends as `error`; a per-project `job_runs` row is written only for projects where something changed or failed. Then the chunk consistency sweep (search-and-digest.md §3), which checks the abort signal and the budget and renews the lease between items like every batch job. A failure stores only a safe message in `job_runs.error` (a database error is `database error <SQLSTATE>`, never the query or its parameters); the detail goes to the server log |
| `embed-pending` | 1 min | 5 min | fill `chunks.embedding IS NULL`, 64 per batch, until empty or 4 min (search-and-digest.md §3) |
| `reembed` | 1 min | 5 min, renewed per 16-item batch | per project with `embedding_target`: create index → re-chunk/embed → cut over → drop old chunks/index (search-and-digest.md §3) |
| `purge-ephemeral` | 1 h | 5 min | delete sessions past either expiry; device codes 1 day past `expires_at` (the instance-wide cap also evicts oldest pending codes on insert, auth-and-security.md §6); invites used, revoked or expired for > 30 days; `job_runs` > 30 days |
| `mcp-session-sweep` | 5 min | none (in-memory, per process) | close MCP sessions idle > 30 min |

## 5. Idempotency

- Every transition is a predicate-guarded `UPDATE`. Re-running a job, or running it after a crash,
  only touches rows that still match.
- The state change and its audit rows are written in one statement, so they cannot diverge:
```sql
WITH s AS (
  UPDATE items SET lifecycle = 'stale', stale_since = now()
  WHERE project_id = $1 AND <P_stale with $stale_days>
  RETURNING id, number)
INSERT INTO audit_log (project_id, actor_label, via, action, item_id, item_handle, summary)
SELECT $1, 'system', 'system', 'item.stale', id, 'm' || number,
       'unverified and unused for ' || $2 || ' days'
FROM s;
```
  The handle snapshot is relative to the row's project, so it is plain in the shared project too (api.md
  §0.6, §10). `item.archive` (`P_archive`, reason `stale`) and `item.expire` (`P_expired`, reason `expired`)
  follow the same shape.
- `embed-pending` writes with `AND embedding IS NULL`. `reembed` finds work by the
  `(model, item_revision)` comparison, and its cut-over re-checks under a row lock. Index DDL uses
  `IF [NOT] EXISTS`.
- `purge-ephemeral` deletes only rows past fixed cutoffs, and only from tables that are not
  append-only.

## 6. Review queue

Page `/projects/:slug/review`. The dashboard shows a count for each section. Library pages are excluded everywhere in the queue: from the stale and archived sections, from the counts and from the project list's review total. Every action is audited
(`via='web'`). Shown to project members; actions need editor or above (hard delete: PA or IA; in
shared: SE or IA).

| section | rows (sorted) | columns | actions |
|---|---|---|---|
| Stale memories | `lifecycle='stale'`, by `stale_since` asc | handle, type, title, stale since, last verified, last used (badge "used since stale" when `last_used_at > stale_since`), days to auto-archive | **Verify** (→ active), **Edit** (save = revision → active), **Supersede** (new item; old → superseded), **Archive now** (reason manual), **Delete** (PA/IA, confirm with the handle) |
| Recently archived | `lifecycle='archived' AND archived_at > now() - 30 d`, by `archived_at` desc | handle, title, reason (`stale` / `expired` / `manual`), archived at | **Restore** (→ active, `last_verified_at=now()`); for an expired observation, restore also requires **Promote to fact** in the same action, because its expiry is past. **Delete** |
| Observations expiring | `type='observation' AND lifecycle='active' AND expires_at < now() + 48 h` | handle, title, expires in | **Promote to fact** (type change, revision, clears expiry), **Archive now**, or no action (expires on schedule) |
| Conflicts | `conflicts_with` edges of this project where both ends are `lifecycle <> 'archived'` and `status` active or accepted; in `_shared`, only edges whose two ends are both shared | both handles and titles | **Supersede one** (pick the winner; only when both ends are in this project), **Remove relation**, **Verify both** |
| Push conflicts | mirrored items with `push_conflict_at` set (a repo push was refused because the item was edited in Spoor), by `push_conflict_at` desc | handle, title, source path, edited by / via, refused at | none in the UI: the row says to run `spoor adr push --force <file>` (or `docs push`) from a terminal, or to bring the file in line and push; the next accepted push clears it |

Bulk selection works for Verify and Archive now. Nothing in the queue deletes anything automatically.
