/**
 * The memory lifecycle of docs/design/cleanup-and-jobs.md section 1 as pure functions over one item's
 * lifecycle columns and a clock value. This is the reference model:
 *
 * - `isStaleDue`, `isArchiveDue`, `isExpiredDue` are the TypeScript twins of the SQL predicates
 *   `P_stale`, `P_archive`, `P_expired` that the cleanup job runs (cleanup.ts). The integration test runs
 *   the same scenario table through both and requires identical outcomes.
 * - `cleanupStep` is one run of the job: the three predicates in job order (expired, stale, archive).
 * - `verify`, `pin`, `contentUpdate`, `restore`, `manualArchive`, `use` are the human / agent edges of the
 *   state machine; the items module implements them in SQL and must match these.
 * - `daysToArchive` is the review-queue column "days to auto-archive" (with the D9 not-used guard).
 *
 * Time is milliseconds since the epoch so tests can drive it with a fake clock.
 */
import type { ProjectSettings } from '@spoor/shared'

export const DAY_MS = 86_400_000
export const HOUR_MS = 3_600_000

export type CleanupSettings = ProjectSettings['cleanup']
export type Lifecycle = 'active' | 'stale' | 'archived'
export type ArchiveReason = 'stale' | 'expired' | 'manual'

/** The columns of `items` the lifecycle reads and writes (data-model.md section 3). */
export interface LifecycleState {
  space: 'memories' | 'decisions' | 'docs'
  /** Memories only; `null` elsewhere. */
  type: 'decision' | 'fact' | 'procedure' | 'observation' | null
  /** Domain status: memories `active | superseded`, decisions `proposed | accepted | superseded | deprecated`. */
  status: string
  lifecycle: Lifecycle
  pinned: boolean
  lastVerifiedAt: number
  /** Set only by content writes (a new revision). */
  updatedAt: number
  lastUsedAt: number | null
  /** Observations only (hard expiry). */
  expiresAt: number | null
  staleSince: number | null
  archivedAt: number | null
  archiveReason: ArchiveReason | null
}

const days = (n: number) => n * DAY_MS

/** `P_stale`: an active, unpinned, non-observation memory unverified, unchanged and unused for `stale_days`. */
export function isStaleDue(i: LifecycleState, s: CleanupSettings, now: number): boolean {
  return (
    i.space === 'memories' &&
    i.lifecycle === 'active' &&
    i.status === 'active' &&
    !i.pinned &&
    i.type !== 'observation' &&
    Math.max(i.lastVerifiedAt, i.updatedAt, i.lastUsedAt ?? Number.NEGATIVE_INFINITY) <
      now - days(s.stale_days)
  )
}

/**
 * `P_archive` with the D9 guard: stale for more than `archive_days` AND not used within the last
 * `stale_days`. A stale memory agents still reach for stays in the review queue.
 */
export function isArchiveDue(i: LifecycleState, s: CleanupSettings, now: number): boolean {
  return (
    i.space === 'memories' &&
    i.lifecycle === 'stale' &&
    !i.pinned &&
    i.staleSince !== null &&
    i.staleSince < now - days(s.archive_days) &&
    (i.lastUsedAt ?? Number.NEGATIVE_INFINITY) < now - days(s.stale_days)
  )
}

/** `P_expired`: an observation past its hard expiry that is not archived yet (pinning does not stop it). */
export function isExpiredDue(i: LifecycleState, now: number): boolean {
  return (
    i.space === 'memories' &&
    i.type === 'observation' &&
    i.lifecycle !== 'archived' &&
    i.expiresAt !== null &&
    i.expiresAt <= now
  )
}

export type CleanupTransition = 'expire' | 'stale' | 'archive'

/**
 * What one cleanup run does to the item: the three statements run in the order expired, stale, archive.
 * At most one applies per run (a memory staled in this run has `stale_since = now`, which is not old
 * enough to archive, and observations are never staled).
 */
export function cleanupStep(
  i: LifecycleState,
  s: CleanupSettings,
  now: number,
): { state: LifecycleState; transition: CleanupTransition | null } {
  if (isExpiredDue(i, now)) return { state: archived(i, now, 'expired'), transition: 'expire' }
  if (isStaleDue(i, s, now))
    return { state: { ...i, lifecycle: 'stale', staleSince: now }, transition: 'stale' }
  if (isArchiveDue(i, s, now)) return { state: archived(i, now, 'stale'), transition: 'archive' }
  return { state: i, transition: null }
}

function archived(i: LifecycleState, now: number, reason: ArchiveReason): LifecycleState {
  // items_stale_check: stale_since is set exactly while lifecycle = 'stale'
  return { ...i, lifecycle: 'archived', archivedAt: now, archiveReason: reason, staleSince: null }
}

const reactivated = (i: LifecycleState, now: number): LifecycleState => ({
  ...i,
  lifecycle: 'active',
  staleSince: null,
  lastVerifiedAt: now,
})

// ---- human and agent edges of the state machine (implemented by the items module) -------------------

/** `spoor_verify` / web Verify on an active or stale item. Does not extend an observation's expiry. */
export function verify(i: LifecycleState, now: number): LifecycleState {
  if (i.lifecycle === 'archived') return i // archived items come back only through restore
  return reactivated(i, now)
}

/** A human pin counts as verification (I43): stale → active, `last_verified_at = now`. */
export function pin(i: LifecycleState, now: number): LifecycleState {
  if (i.lifecycle === 'archived') return { ...i, pinned: true }
  return { ...reactivated(i, now), pinned: true }
}

export function unpin(i: LifecycleState): LifecycleState {
  return { ...i, pinned: false }
}

/**
 * A content write (new revision): `updated_at = now`, and a stale item becomes active in the same
 * statement. A type change to `observation` sets `expires_at = now + observation_days` (never relative to
 * `created_at`); a change away from it clears `expires_at`.
 */
export function contentUpdate(
  i: LifecycleState,
  now: number,
  s: CleanupSettings,
  change: { type?: LifecycleState['type'] } = {},
): LifecycleState {
  let next: LifecycleState = { ...i, updatedAt: now }
  if (i.lifecycle === 'stale') next = { ...next, lifecycle: 'active', staleSince: null, lastVerifiedAt: now }
  if (change.type !== undefined && change.type !== i.type) {
    next = {
      ...next,
      type: change.type,
      expiresAt: change.type === 'observation' ? now + days(s.observation_days) : null,
    }
  }
  return next
}

/** Human restore from `archived`: active again, archive columns cleared, counts as verification. */
export function restore(i: LifecycleState, now: number): LifecycleState {
  if (i.lifecycle !== 'archived') return i
  return { ...reactivated(i, now), archivedAt: null, archiveReason: null }
}

/** Human "Archive now" from active or stale. */
export function manualArchive(i: LifecycleState, now: number): LifecycleState {
  if (i.lifecycle === 'archived') return i
  return archived(i, now, 'manual')
}

/**
 * A deliberate read (`spoor_get`, duplicate hit, `spoor_relate` target): bumps `last_used_at` at most once
 * per hour. Use is not proof of correctness, so it never changes the lifecycle.
 */
export function use(i: LifecycleState, now: number): LifecycleState {
  if (i.lastUsedAt !== null && i.lastUsedAt >= now - HOUR_MS) return i
  return { ...i, lastUsedAt: now }
}

// ---- review queue ------------------------------------------------------------------------------------

/**
 * Whole days until the cleanup job may archive this stale memory: the later of `stale_since + archive_days`
 * and (D9) `last_used_at + stale_days`, rounded up, never negative. `null` when it never will (not stale,
 * pinned, or not a memory).
 */
export function daysToArchive(i: LifecycleState, s: CleanupSettings, now: number): number | null {
  if (i.space !== 'memories' || i.lifecycle !== 'stale' || i.pinned || i.staleSince === null) return null
  const due = Math.max(
    i.staleSince + days(s.archive_days),
    i.lastUsedAt === null ? Number.NEGATIVE_INFINITY : i.lastUsedAt + days(s.stale_days),
  )
  return Math.max(0, Math.ceil((due - now) / DAY_MS))
}

/** The review badge "used since stale". */
export function usedSinceStale(i: Pick<LifecycleState, 'lastUsedAt' | 'staleSince'>): boolean {
  return i.lastUsedAt !== null && i.staleSince !== null && i.lastUsedAt > i.staleSince
}
