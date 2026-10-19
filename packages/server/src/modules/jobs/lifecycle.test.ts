// The lifecycle state machine of cleanup-and-jobs.md section 1 (incl. D9 and I43), driven by a fake clock.
import { SETTINGS_DEFAULTS } from '@spoor/shared'
import { describe, expect, it } from 'vitest'
import { FakeClock } from './clock.js'
import {
  type CleanupSettings,
  cleanupStep,
  contentUpdate,
  DAY_MS,
  daysToArchive,
  HOUR_MS,
  isArchiveDue,
  isExpiredDue,
  isStaleDue,
  type LifecycleState,
  manualArchive,
  pin,
  restore,
  unpin,
  use,
  usedSinceStale,
  verify,
} from './lifecycle.js'
import { SCENARIOS, scenarioSettings, scenarioState } from './lifecycle.scenarios.js'

const S: CleanupSettings = { ...SETTINGS_DEFAULTS.cleanup } // 30 / 90 / 7

function fact(now: number, over: Partial<LifecycleState> = {}): LifecycleState {
  return {
    space: 'memories',
    type: 'fact',
    status: 'active',
    lifecycle: 'active',
    pinned: false,
    lastVerifiedAt: now,
    updatedAt: now,
    lastUsedAt: null,
    expiresAt: null,
    staleSince: null,
    archivedAt: null,
    archiveReason: null,
    ...over,
  }
}

function observation(now: number, s = S): LifecycleState {
  return fact(now, { type: 'observation', expiresAt: now + s.observation_days * DAY_MS })
}

/** Run the cleanup job once per hour for `hours`, returning the item and the transitions with their time. */
function runHourly(clock: FakeClock, item: LifecycleState, hours: number, s = S) {
  const log: { at: number; t: string }[] = []
  let state = item
  for (let h = 0; h < hours; h++) {
    clock.advance(HOUR_MS)
    const r = cleanupStep(state, s, clock.now())
    if (r.transition) log.push({ at: clock.now(), t: r.transition })
    state = r.state
  }
  return { state, log }
}

describe('scenario table (shared with the SQL integration test)', () => {
  const now = Date.UTC(2026, 9, 19, 12)
  it.each(SCENARIOS.map((s) => [s.name, s] as const))('%s', (_name, s) => {
    expect(cleanupStep(scenarioState(s, now), scenarioSettings(s), now).transition).toBe(s.expect)
  })
})

describe('P_stale boundaries', () => {
  it('is strict: exactly stale_days after the last activity is not yet stale, 1 ms later it is', () => {
    const clock = new FakeClock()
    const t0 = clock.now()
    const i = fact(t0)
    clock.advance(30 * DAY_MS)
    expect(isStaleDue(i, S, clock.now())).toBe(false)
    clock.advance(1)
    expect(isStaleDue(i, S, clock.now())).toBe(true)
  })

  it('takes the latest of last_verified_at, updated_at and last_used_at', () => {
    const t = Date.UTC(2026, 0, 1)
    const now = t + 40 * DAY_MS
    const base = fact(t)
    expect(isStaleDue(base, S, now)).toBe(true)
    expect(isStaleDue({ ...base, lastVerifiedAt: now - DAY_MS }, S, now)).toBe(false)
    expect(isStaleDue({ ...base, updatedAt: now - DAY_MS }, S, now)).toBe(false)
    expect(isStaleDue({ ...base, lastUsedAt: now - DAY_MS }, S, now)).toBe(false)
  })

  it('never applies to stale or archived items, decisions, docs, observations, pinned or superseded memories', () => {
    const t = Date.UTC(2026, 0, 1)
    const now = t + 400 * DAY_MS
    const base = fact(t)
    expect(isStaleDue({ ...base, lifecycle: 'stale', staleSince: t }, S, now)).toBe(false)
    expect(
      isStaleDue({ ...base, lifecycle: 'archived', archivedAt: t, archiveReason: 'manual' }, S, now),
    ).toBe(false)
    expect(isStaleDue({ ...base, space: 'decisions', type: null, status: 'accepted' }, S, now)).toBe(false)
    expect(isStaleDue({ ...base, space: 'docs', type: null }, S, now)).toBe(false)
    expect(isStaleDue({ ...base, type: 'observation', expiresAt: now + DAY_MS }, S, now)).toBe(false)
    expect(isStaleDue({ ...base, pinned: true }, S, now)).toBe(false)
    expect(isStaleDue({ ...base, status: 'superseded' }, S, now)).toBe(false)
  })
})

describe('P_archive boundaries and the D9 guard', () => {
  const t = Date.UTC(2026, 0, 1)
  const stale = fact(t, { lifecycle: 'stale', staleSince: t, lastVerifiedAt: t - 31 * DAY_MS })

  it('archives strictly after archive_days of staleness', () => {
    expect(isArchiveDue(stale, S, t + 90 * DAY_MS)).toBe(false)
    expect(isArchiveDue(stale, S, t + 90 * DAY_MS + 1)).toBe(true)
  })

  it('keeps a stale memory used within the last stale_days, until that use is stale_days old', () => {
    const used = { ...stale, lastUsedAt: t + 80 * DAY_MS }
    expect(isArchiveDue(used, S, t + 100 * DAY_MS)).toBe(false)
    expect(isArchiveDue(used, S, t + 110 * DAY_MS)).toBe(false)
    expect(isArchiveDue(used, S, t + 110 * DAY_MS + 1)).toBe(true)
  })

  it('never archives a pinned, active or non-memory item', () => {
    const now = t + 400 * DAY_MS
    expect(isArchiveDue({ ...stale, pinned: true }, S, now)).toBe(false)
    expect(isArchiveDue({ ...stale, lifecycle: 'active', staleSince: null }, S, now)).toBe(false)
    expect(isArchiveDue({ ...stale, space: 'docs', type: null }, S, now)).toBe(false)
  })
})

describe('P_expired', () => {
  it('fires at expires_at (inclusive), for active and stale observations, pinned or not', () => {
    const clock = new FakeClock()
    const o = observation(clock.now())
    clock.advance(7 * DAY_MS - 1)
    expect(isExpiredDue(o, clock.now())).toBe(false)
    clock.advance(1)
    expect(isExpiredDue(o, clock.now())).toBe(true)
    expect(isExpiredDue({ ...o, pinned: true }, clock.now())).toBe(true)
    expect(isExpiredDue({ ...o, lifecycle: 'stale', staleSince: 0 }, clock.now())).toBe(true)
    expect(
      isExpiredDue({ ...o, lifecycle: 'archived', archivedAt: 0, archiveReason: 'manual' }, clock.now()),
    ).toBe(false)
    expect(isExpiredDue({ ...o, type: 'fact', expiresAt: null }, clock.now())).toBe(false)
  })
})

describe('job transitions over time (hourly runs)', () => {
  it('active -> stale after stale_days -> archived(stale) after archive_days more', () => {
    const clock = new FakeClock()
    const t0 = clock.now()
    const { state, log } = runHourly(clock, fact(t0), 24 * 125)
    expect(log.map((l) => l.t)).toEqual(['stale', 'archive'])
    expect(log[0]?.at).toBe(t0 + 30 * DAY_MS + HOUR_MS)
    expect(log[1]?.at).toBe(t0 + 120 * DAY_MS + 2 * HOUR_MS)
    expect(state).toMatchObject({ lifecycle: 'archived', archiveReason: 'stale', staleSince: null })
    expect(state.archivedAt).toBe(log[1]?.at)
  })

  it('each transition happens once: re-running the job is a no-op', () => {
    const clock = new FakeClock()
    const t0 = clock.now()
    const first = runHourly(clock, fact(t0), 24 * 31)
    expect(first.log).toHaveLength(1)
    const again = cleanupStep(first.state, S, clock.now())
    expect(again.transition).toBeNull()
    expect(again.state).toEqual(first.state)
  })

  it('D9: use while stale postpones archiving until the use itself is stale_days old', () => {
    const clock = new FakeClock()
    const t0 = clock.now()
    let { state } = runHourly(clock, fact(t0), 24 * 31) // stale at ~day 30
    expect(state.lifecycle).toBe('stale')
    clock.advance(69 * DAY_MS) // day ~100: an agent fetches it
    state = use(state, clock.now())
    const usedAt = clock.now()
    expect(state.lifecycle).toBe('stale') // use does not restore
    expect(usedSinceStale(state)).toBe(true)
    const r = runHourly(clock, state, 24 * 40)
    expect(r.log.map((l) => l.t)).toEqual(['archive'])
    expect(r.log[0]?.at).toBeGreaterThan(usedAt + 30 * DAY_MS)
    expect(r.log[0]?.at).toBeLessThanOrEqual(usedAt + 30 * DAY_MS + HOUR_MS)
  })

  it('observation -> archived(expired) after observation_days, even when verified and pinned', () => {
    const clock = new FakeClock()
    let o = observation(clock.now())
    clock.advance(6 * DAY_MS)
    o = pin(verify(o, clock.now()), clock.now())
    const { state, log } = runHourly(clock, o, 48)
    expect(log.map((l) => l.t)).toEqual(['expire'])
    expect(state).toMatchObject({ lifecycle: 'archived', archiveReason: 'expired', pinned: true })
  })

  it('uses the per-project settings', () => {
    const s = { stale_days: 5, archive_days: 3, observation_days: 2 }
    const clock = new FakeClock()
    const t0 = clock.now()
    const { log } = runHourly(clock, fact(t0), 24 * 10, s)
    expect(log.map((l) => l.t)).toEqual(['stale', 'archive'])
    expect(log[0]?.at).toBe(t0 + 5 * DAY_MS + HOUR_MS)
    expect(log[1]?.at).toBe(t0 + 8 * DAY_MS + 2 * HOUR_MS)
  })
})

describe('human and agent transitions', () => {
  const clock = new FakeClock()
  const t0 = clock.now()
  const stale = fact(t0 - 40 * DAY_MS, { lifecycle: 'stale', staleSince: t0 - 5 * DAY_MS })

  it('stale -> active by verify (last_verified_at = now)', () => {
    const v = verify(stale, t0)
    expect(v).toMatchObject({ lifecycle: 'active', staleSince: null, lastVerifiedAt: t0 })
    expect(isStaleDue(v, S, t0 + 30 * DAY_MS)).toBe(false)
    expect(isStaleDue(v, S, t0 + 30 * DAY_MS + 1)).toBe(true)
  })

  it('stale -> active by pin, which counts as verification (I43); pinned items never go stale', () => {
    const p = pin(stale, t0)
    expect(p).toMatchObject({ lifecycle: 'active', staleSince: null, lastVerifiedAt: t0, pinned: true })
    expect(isStaleDue(p, S, t0 + 1000 * DAY_MS)).toBe(false)
    const u = unpin(p)
    expect(isStaleDue(u, S, t0 + 30 * DAY_MS + 1)).toBe(true)
  })

  it('stale -> active by a content update (updated_at = now) in the same write', () => {
    const c = contentUpdate(stale, t0, S)
    expect(c).toMatchObject({ lifecycle: 'active', staleSince: null, updatedAt: t0 })
  })

  it('a content update of an active item only moves updated_at', () => {
    const a = fact(t0 - 10 * DAY_MS)
    const c = contentUpdate(a, t0, S)
    expect(c).toEqual({ ...a, updatedAt: t0 })
  })

  it('a type change to observation sets expires_at = now + observation_days; away clears it', () => {
    const a = fact(t0 - 100 * DAY_MS)
    const o = contentUpdate(a, t0, S, { type: 'observation' })
    expect(o.expiresAt).toBe(t0 + 7 * DAY_MS) // never relative to created_at
    expect(isExpiredDue(o, t0 + 7 * DAY_MS - 1)).toBe(false)
    const promoted = contentUpdate(o, t0 + DAY_MS, S, { type: 'fact' })
    expect(promoted).toMatchObject({ type: 'fact', expiresAt: null })
  })

  it('verify does not extend an observation', () => {
    const o = observation(t0)
    expect(verify(o, t0 + 6 * DAY_MS).expiresAt).toBe(o.expiresAt)
  })

  it('use bumps last_used_at at most once per hour and never changes the lifecycle', () => {
    const a = use(stale, t0)
    expect(a.lastUsedAt).toBe(t0)
    expect(a.lifecycle).toBe('stale')
    expect(use(a, t0 + HOUR_MS)).toBe(a) // strict, like `last_used_at < now() - interval '1 hour'`
    expect(use(a, t0 + HOUR_MS + 1).lastUsedAt).toBe(t0 + HOUR_MS + 1)
  })

  it('active|stale -> archived(manual) by a human; archived -> active only by restore', () => {
    const fromActive = manualArchive(fact(t0), t0)
    const fromStale = manualArchive(stale, t0)
    for (const a of [fromActive, fromStale]) {
      expect(a).toMatchObject({
        lifecycle: 'archived',
        archiveReason: 'manual',
        archivedAt: t0,
        staleSince: null,
      })
      expect(verify(a, t0 + 1)).toBe(a)
      const r = restore(a, t0 + DAY_MS)
      expect(r).toMatchObject({
        lifecycle: 'active',
        archivedAt: null,
        archiveReason: null,
        staleSince: null,
        lastVerifiedAt: t0 + DAY_MS,
      })
    }
  })

  it('restore of a stale-archived item counts as verification, so it does not re-stale at once', () => {
    const clock2 = new FakeClock()
    const { state } = runHourly(clock2, fact(clock2.now()), 24 * 125)
    expect(state.lifecycle).toBe('archived')
    const r = restore(state, clock2.now())
    expect(cleanupStep(r, S, clock2.now() + HOUR_MS).transition).toBeNull()
  })
})

describe('daysToArchive (review queue)', () => {
  const t = Date.UTC(2026, 0, 1)
  const stale = fact(t - 40 * DAY_MS, { lifecycle: 'stale', staleSince: t })

  it('counts down archive_days from stale_since, rounded up, never below 0', () => {
    expect(daysToArchive(stale, S, t)).toBe(90)
    expect(daysToArchive(stale, S, t + 0.5 * DAY_MS)).toBe(90)
    expect(daysToArchive(stale, S, t + 89.5 * DAY_MS)).toBe(1)
    expect(daysToArchive(stale, S, t + 200 * DAY_MS)).toBe(0)
  })

  it('a use while stale pushes the date to last_used_at + stale_days (D9)', () => {
    const used = { ...stale, lastUsedAt: t + 80 * DAY_MS }
    expect(daysToArchive(used, S, t + 85 * DAY_MS)).toBe(25)
  })

  it('is null for items the job will never archive', () => {
    expect(daysToArchive(fact(t), S, t)).toBeNull()
    expect(daysToArchive({ ...stale, pinned: true }, S, t)).toBeNull()
  })

  it('usedSinceStale compares last_used_at with stale_since', () => {
    expect(usedSinceStale(stale)).toBe(false)
    expect(usedSinceStale({ ...stale, lastUsedAt: t - 1 })).toBe(false)
    expect(usedSinceStale({ ...stale, lastUsedAt: t + 1 })).toBe(true)
  })
})
