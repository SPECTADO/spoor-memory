/**
 * Schedule and tiered retention of backup bundles (ADR-0040). Pure functions, no I/O: the backup job asks
 * `backupDue` every 15 minutes, the list shows `nextDueAt` and `isOverdue`, and `planRetention` decides which
 * bundles a successful scheduled backup may prune.
 *
 * Buckets (UTC): `24h` = the epoch day, `48h` = the epoch day div 2, `7d` = the ISO week (Monday to Sunday).
 * The cadence is the smallest tier interval: every day, every even epoch day (48h) or every Monday (7d), at
 * `time_utc`.
 *
 * Keep set = per tier the newest bundle of each of the newest `keep` buckets that hold an auto bundle (a
 * verified one when the bucket has one) + the newest verified bundle of any kind (always) + pinned + ALL
 * manual + pre-restore younger than 14 days. Only auto bundles and older pre-restore bundles are ever deleted.
 */
import {
  BACKUP_TIER_HOURS,
  type BackupKind,
  type BackupSettings,
  type BackupTier,
  type BackupTierEvery,
  PRE_RESTORE_KEEP_DAYS,
} from '@spoor/shared'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** What retention needs of a bundle (from its backup.json). */
export interface RetentionBundle {
  id: string
  kind: BackupKind
  createdAt: Date
  /** `verified_at` is set: the bundle passed its last verify. */
  verified: boolean
  pinned: boolean
}

export type KeepReason =
  | `tier:${BackupTierEvery}`
  | 'newest_good'
  | 'pinned'
  | 'manual'
  | 'pre_restore_recent'
  /** Created after `now` (clock skew): never touched. */
  | 'future'

export interface RetentionPlan {
  /** Every kept bundle with why (a bundle may have several reasons). */
  keep: Map<string, KeepReason[]>
  /** Ids to delete, oldest first. */
  delete: string[]
}

export const epochDay = (d: Date): number => Math.floor(d.getTime() / DAY_MS)

/** The bucket of a time for a tier: UTC day, epoch-day pair, ISO week (1970-01-01 is a Thursday). */
export function tierBucket(every: BackupTierEvery, d: Date): number {
  const day = epochDay(d)
  if (every === '24h') return day
  if (every === '48h') return Math.floor(day / 2)
  return Math.floor((day + 3) / 7)
}

const byNewest = (a: RetentionBundle, b: RetentionBundle) =>
  b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** The ids one tier keeps: the newest (verified first) auto bundle of each of the newest `keep` buckets. */
export function tierKeeps(autos: readonly RetentionBundle[], tier: BackupTier): string[] {
  const buckets = new Map<number, RetentionBundle[]>()
  for (const b of [...autos].sort(byNewest)) {
    const k = tierBucket(tier.every, b.createdAt)
    const list = buckets.get(k)
    if (list) list.push(b)
    else buckets.set(k, [b])
  }
  // Map keeps insertion order: newest bucket first
  const out: string[] = []
  for (const list of buckets.values()) {
    if (out.length >= tier.keep) break
    const pick = list.find((b) => b.verified) ?? (list[0] as RetentionBundle)
    out.push(pick.id)
  }
  return out
}

/** The newest bundle that passed its verify (any kind); it is never pruned. */
export function newestGood(bundles: readonly RetentionBundle[]): RetentionBundle | null {
  return [...bundles].filter((b) => b.verified).sort(byNewest)[0] ?? null
}

/** Reasons a bundle is kept regardless of the tiers (`BackupItemJson.protected`); empty = tiers decide. */
export function protectedReasons(b: RetentionBundle, newestGoodId: string | null, now: Date): KeepReason[] {
  const r: KeepReason[] = []
  if (b.createdAt.getTime() > now.getTime()) r.push('future')
  if (b.id === newestGoodId) r.push('newest_good')
  if (b.pinned) r.push('pinned')
  if (b.kind === 'manual') r.push('manual')
  if (b.kind === 'pre-restore' && now.getTime() - b.createdAt.getTime() < PRE_RESTORE_KEEP_DAYS * DAY_MS) {
    r.push('pre_restore_recent')
  }
  return r
}

export function planRetention(
  bundles: readonly RetentionBundle[],
  tiers: readonly BackupTier[],
  now: Date,
): RetentionPlan {
  const keep = new Map<string, KeepReason[]>()
  const add = (id: string, reason: KeepReason) => {
    const list = keep.get(id)
    if (list) {
      if (!list.includes(reason)) list.push(reason)
    } else keep.set(id, [reason])
  }
  const past = bundles.filter((b) => b.createdAt.getTime() <= now.getTime())
  const autos = past.filter((b) => b.kind === 'auto')
  for (const tier of tiers) for (const id of tierKeeps(autos, tier)) add(id, `tier:${tier.every}`)
  const good = newestGood(bundles)?.id ?? null
  for (const b of bundles) for (const r of protectedReasons(b, good, now)) add(b.id, r)
  const del = bundles
    .filter((b) => !keep.has(b.id) && (b.kind === 'auto' || b.kind === 'pre-restore'))
    .sort((a, b) => -byNewest(a, b))
    .map((b) => b.id)
  return { keep, delete: del }
}

// ---- schedule -------------------------------------------------------------------------------------------

/** The smallest tier interval: how often a scheduled backup is made. */
export function cadenceEvery(tiers: readonly BackupTier[]): BackupTierEvery {
  let best: BackupTierEvery = '7d'
  for (const t of tiers) if (BACKUP_TIER_HOURS[t.every] < BACKUP_TIER_HOURS[best]) best = t.every
  return best
}

/** Whether an epoch day carries a slot: every day (24h), even epoch days (48h), Mondays (7d). */
export function isSlotDay(every: BackupTierEvery, day: number): boolean {
  if (every === '24h') return true
  if (every === '48h') return day % 2 === 0
  return (((day + 3) % 7) + 7) % 7 === 0
}

function slotOn(day: number, timeUtc: string): Date {
  const [h, m] = timeUtc.split(':').map(Number)
  return new Date(day * DAY_MS + (h ?? 0) * HOUR_MS + (m ?? 0) * 60_000)
}

/** The newest slot at or before `now`. */
export function currentSlot(settings: Pick<BackupSettings, 'tiers' | 'time_utc'>, now: Date): Date {
  const every = cadenceEvery(settings.tiers)
  for (let day = epochDay(now); ; day--) {
    if (!isSlotDay(every, day)) continue
    const slot = slotOn(day, settings.time_utc)
    if (slot.getTime() <= now.getTime()) return slot
  }
}

/** The first slot strictly after `t`. */
export function nextSlotAfter(settings: Pick<BackupSettings, 'tiers' | 'time_utc'>, t: Date): Date {
  const every = cadenceEvery(settings.tiers)
  for (let day = epochDay(t); ; day++) {
    if (!isSlotDay(every, day)) continue
    const slot = slotOn(day, settings.time_utc)
    if (slot.getTime() > t.getTime()) return slot
  }
}

export interface DueInput {
  settings: Pick<BackupSettings, 'enabled' | 'tiers' | 'time_utc'>
  now: Date
  /** The newest auto bundle's start time, null when there is none. */
  lastAutoAt: Date | null
}

/**
 * A scheduled backup is due when the schedule is on, `now` is past the current slot and no auto backup started
 * at or after that slot. A missed slot (instance down, backups unavailable) is made up at the next look.
 */
export function backupDue({ settings, now, lastAutoAt }: DueInput): { due: boolean; slot: Date | null } {
  if (!settings.enabled) return { due: false, slot: null }
  const slot = currentSlot(settings, now)
  return { due: lastAutoAt === null || lastAutoAt.getTime() < slot.getTime(), slot }
}

/** When the next scheduled backup runs: the current slot while it is due (made up soon), else the next one. */
export function nextDueAt(input: DueInput): Date | null {
  const { due, slot } = backupDue(input)
  if (!input.settings.enabled) return null
  if (due && slot) return slot
  return nextSlotAfter(input.settings, input.now)
}

/**
 * The Status page warning: the schedule is on and the newest good backup (or, before the first one, the time
 * the schedule was saved) is older than twice the cadence.
 */
export function isOverdue(input: {
  enabled: boolean
  tiers: readonly BackupTier[]
  lastGoodAt: Date | null
  /** `instance_settings.updated_at` of the `backup` row. */
  settingsUpdatedAt: Date | null
  now: Date
}): boolean {
  if (!input.enabled) return false
  // the settings time only stands in before the first good backup: saving the settings (even unchanged) must
  // not hide an old last good backup
  const refDate = input.lastGoodAt ?? input.settingsUpdatedAt
  if (!refDate) return false
  const ref = refDate.getTime()
  const limit = 2 * BACKUP_TIER_HOURS[cadenceEvery(input.tiers)] * HOUR_MS
  return input.now.getTime() - ref > limit
}
