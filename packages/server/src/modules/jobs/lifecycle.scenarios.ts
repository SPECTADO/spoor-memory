/**
 * One scenario table for both sides of the cleanup rules: lifecycle.test.ts runs it through the TypeScript
 * model, cleanup.integration.test.ts through the SQL predicates against Postgres. Both must reach the
 * expected transition, so the two implementations cannot drift apart. Times are days relative to "now";
 * no scenario sits within ~15 minutes of a boundary (exact boundaries are unit-tested separately).
 */
import { SETTINGS_DEFAULTS } from '@spoor/shared'
import { type CleanupSettings, type CleanupTransition, DAY_MS, type LifecycleState } from './lifecycle.js'

export interface ScenarioItem {
  space?: 'memories' | 'decisions' | 'docs'
  type?: 'decision' | 'fact' | 'procedure' | 'observation'
  status?: string
  lifecycle?: 'active' | 'stale' | 'archived'
  pinned?: boolean
  verifiedDaysAgo: number
  updatedDaysAgo: number
  usedDaysAgo?: number | null
  /** Observations: days from now until `expires_at` (negative = past). */
  expiresInDays?: number
  staleDaysAgo?: number
  archivedDaysAgo?: number
}

export interface Scenario {
  name: string
  settings?: Partial<CleanupSettings>
  item: ScenarioItem
  expect: CleanupTransition | null
}

const old = { verifiedDaysAgo: 400, updatedDaysAgo: 400 }

export const SCENARIOS: Scenario[] = [
  // ---- P_stale -------------------------------------------------------------------------------------
  { name: 'fresh fact stays active', item: { verifiedDaysAgo: 1, updatedDaysAgo: 1 }, expect: null },
  {
    name: 'fact unverified, unchanged and unused for 31 days goes stale',
    item: { verifiedDaysAgo: 31, updatedDaysAgo: 31 },
    expect: 'stale',
  },
  {
    name: 'recent verification keeps it active',
    item: { verifiedDaysAgo: 29, updatedDaysAgo: 40 },
    expect: null,
  },
  {
    name: 'recent content update keeps it active',
    item: { verifiedDaysAgo: 40, updatedDaysAgo: 29 },
    expect: null,
  },
  {
    name: 'recent use keeps it active',
    item: { verifiedDaysAgo: 40, updatedDaysAgo: 40, usedDaysAgo: 29 },
    expect: null,
  },
  {
    name: 'old use does not keep it active',
    item: { verifiedDaysAgo: 40, updatedDaysAgo: 40, usedDaysAgo: 31 },
    expect: 'stale',
  },
  { name: 'pinned memory never goes stale', item: { ...old, pinned: true }, expect: null },
  { name: 'superseded memory never goes stale', item: { ...old, status: 'superseded' }, expect: null },
  {
    name: 'procedure goes stale like a fact',
    item: { ...old, type: 'procedure' },
    expect: 'stale',
  },
  {
    name: 'observation never goes stale (it expires instead)',
    item: { ...old, type: 'observation', expiresInDays: 1 },
    expect: null,
  },
  {
    name: 'decisions never auto-expire',
    item: { ...old, space: 'decisions', status: 'accepted' },
    expect: null,
  },
  { name: 'docs never auto-expire', item: { ...old, space: 'docs' }, expect: null },
  {
    name: 'per-project stale_days (7) applies',
    settings: { stale_days: 7 },
    item: { verifiedDaysAgo: 8, updatedDaysAgo: 8 },
    expect: 'stale',
  },
  {
    name: 'per-project stale_days (60) applies',
    settings: { stale_days: 60 },
    item: { verifiedDaysAgo: 45, updatedDaysAgo: 45 },
    expect: null,
  },
  // ---- P_archive (with the D9 not-used guard) --------------------------------------------------------
  {
    name: 'stale for 91 days and never used is archived',
    item: { ...old, lifecycle: 'stale', staleDaysAgo: 91 },
    expect: 'archive',
  },
  {
    name: 'stale for 89 days stays stale',
    item: { ...old, lifecycle: 'stale', staleDaysAgo: 89 },
    expect: null,
  },
  {
    name: 'D9: stale for 91 days but used 10 days ago stays stale',
    item: { ...old, lifecycle: 'stale', staleDaysAgo: 91, usedDaysAgo: 10 },
    expect: null,
  },
  {
    name: 'D9: stale for 91 days and last used 31 days ago is archived',
    item: { ...old, lifecycle: 'stale', staleDaysAgo: 91, usedDaysAgo: 31 },
    expect: 'archive',
  },
  {
    name: 'pinned stale memory is not archived',
    item: { ...old, lifecycle: 'stale', staleDaysAgo: 200, pinned: true },
    expect: null,
  },
  {
    name: 'superseded stale memory is archived like any stale one',
    item: { ...old, status: 'superseded', lifecycle: 'stale', staleDaysAgo: 91 },
    expect: 'archive',
  },
  {
    name: 'per-project archive_days (10) applies',
    settings: { archive_days: 10 },
    item: { ...old, lifecycle: 'stale', staleDaysAgo: 11 },
    expect: 'archive',
  },
  {
    name: 'per-project stale_days widens the D9 guard',
    settings: { stale_days: 60, archive_days: 10 },
    item: { ...old, lifecycle: 'stale', staleDaysAgo: 11, usedDaysAgo: 45 },
    expect: null,
  },
  // ---- P_expired -------------------------------------------------------------------------------------
  {
    name: 'observation past its expiry is archived as expired',
    item: { verifiedDaysAgo: 8, updatedDaysAgo: 8, type: 'observation', expiresInDays: -1 / 24 },
    expect: 'expire',
  },
  {
    name: 'verifying does not extend an observation (hard expiry)',
    item: { verifiedDaysAgo: 0.1, updatedDaysAgo: 8, type: 'observation', expiresInDays: -0.05 },
    expect: 'expire',
  },
  {
    name: 'pinning does not stop expiry',
    item: { ...old, type: 'observation', pinned: true, expiresInDays: -2 },
    expect: 'expire',
  },
  {
    name: 'stale observation past expiry is archived as expired',
    item: { ...old, type: 'observation', lifecycle: 'stale', staleDaysAgo: 3, expiresInDays: -1 },
    expect: 'expire',
  },
  {
    name: 'superseded observation past expiry is archived as expired',
    item: { ...old, type: 'observation', status: 'superseded', expiresInDays: -1 },
    expect: 'expire',
  },
  {
    name: 'observation not yet expired stays',
    item: { verifiedDaysAgo: 3, updatedDaysAgo: 3, type: 'observation', expiresInDays: 0.5 },
    expect: null,
  },
  // ---- archived is final for the job -----------------------------------------------------------------
  {
    name: 'archived memory is left alone',
    item: { ...old, lifecycle: 'archived', archivedDaysAgo: 5 },
    expect: null,
  },
  {
    name: 'archived expired observation is left alone',
    item: { ...old, type: 'observation', lifecycle: 'archived', archivedDaysAgo: 5, expiresInDays: -6 },
    expect: null,
  },
]

export function scenarioSettings(s: Scenario): CleanupSettings {
  return { ...SETTINGS_DEFAULTS.cleanup, ...s.settings }
}

/** The scenario's item as model state at `now`. */
export function scenarioState(s: Scenario, now: number): LifecycleState {
  const i = s.item
  const ago = (d: number) => now - d * DAY_MS
  const space = i.space ?? 'memories'
  const type = space === 'memories' ? (i.type ?? 'fact') : null
  return {
    space,
    type,
    status: i.status ?? (space === 'decisions' ? 'accepted' : 'active'),
    lifecycle: i.lifecycle ?? 'active',
    pinned: i.pinned ?? false,
    lastVerifiedAt: ago(i.verifiedDaysAgo),
    updatedAt: ago(i.updatedDaysAgo),
    lastUsedAt: i.usedDaysAgo === undefined || i.usedDaysAgo === null ? null : ago(i.usedDaysAgo),
    expiresAt: type === 'observation' ? now + (i.expiresInDays ?? 7) * DAY_MS : null,
    staleSince: i.lifecycle === 'stale' ? ago(i.staleDaysAgo ?? 0) : null,
    archivedAt: i.lifecycle === 'archived' ? ago(i.archivedDaysAgo ?? 0) : null,
    archiveReason: i.lifecycle === 'archived' ? 'manual' : null,
  }
}
