// Tiered retention and the schedule of ADR-0040, driven by simulated months of backups.
import { type BackupKind, type BackupTier, backupIdFor, maxKeptAutoBackups } from '@spoor/shared'
import { describe, expect, it } from 'vitest'
import {
  backupDue,
  cadenceEvery,
  currentSlot,
  isOverdue,
  isSlotDay,
  nextDueAt,
  nextSlotAfter,
  planRetention,
  protectedReasons,
  type RetentionBundle,
  tierBucket,
} from './retention.js'

const DAY = 86_400_000
const at = (iso: string) => new Date(iso)
const DEFAULT_TIERS: BackupTier[] = [
  { every: '24h', keep: 3 },
  { every: '7d', keep: 2 },
]

function bundle(
  iso: string,
  kind: BackupKind = 'auto',
  over: Partial<RetentionBundle> = {},
): RetentionBundle {
  const createdAt = at(iso)
  return { id: backupIdFor(createdAt, kind), kind, createdAt, verified: true, pinned: false, ...over }
}

/** One auto backup per scheduled day at 03:00 from `from` to `to`, pruning after each like the job does. */
function simulate(opts: {
  from: string
  to: string
  tiers: BackupTier[]
  /** Days (YYYY-MM-DD) without a backup (instance down). */
  skip?: string[]
  every?: number
  extra?: RetentionBundle[]
}): RetentionBundle[] {
  let kept: RetentionBundle[] = [...(opts.extra ?? [])]
  for (let t = at(`${opts.from}T03:00:00Z`).getTime(); t <= at(`${opts.to}T03:00:00Z`).getTime(); t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10)
    if (opts.skip?.includes(day)) continue
    const b = bundle(new Date(t + 5000).toISOString())
    kept.push(b)
    const plan = planRetention(kept, opts.tiers, new Date(t + 60_000))
    // the newest backup is always kept
    expect(plan.keep.has(b.id)).toBe(true)
    kept = kept.filter((k) => !plan.delete.includes(k.id))
  }
  return kept
}

const days = (bs: RetentionBundle[]) =>
  bs
    .filter((b) => b.kind === 'auto')
    .map((b) => b.createdAt.toISOString().slice(0, 10))
    .sort()

describe('tierBucket', () => {
  it.each([
    ['24h', '2026-11-26T00:00:00Z', '2026-11-26T23:59:59Z', true],
    ['24h', '2026-11-25T23:59:59Z', '2026-11-26T00:00:00Z', false],
    // epoch day 20782 (11-25) is even: 11-25 and 11-26 share a 48h bucket, 11-24 does not
    ['48h', '2026-11-25T01:00:00Z', '2026-11-26T23:00:00Z', true],
    ['48h', '2026-11-24T23:00:00Z', '2026-11-25T01:00:00Z', false],
    // ISO weeks run Monday to Sunday: 11-23 is a Monday
    ['7d', '2026-11-23T00:00:00Z', '2026-11-29T23:59:59Z', true],
    ['7d', '2026-11-22T23:59:59Z', '2026-11-23T00:00:00Z', false],
    ['7d', '1970-01-01T00:00:00Z', '1970-01-04T23:00:00Z', true],
    ['7d', '1970-01-04T23:00:00Z', '1970-01-05T00:00:00Z', false],
  ] as const)('%s: %s and %s same bucket = %s', (every, a, b, same) => {
    expect(tierBucket(every, at(a)) === tierBucket(every, at(b))).toBe(same)
  })
})

describe('planRetention', () => {
  it('3x24h + 2x7d over three months of daily backups keeps the 3 newest days and the last two weeks', () => {
    const kept = simulate({ from: '2026-09-01', to: '2026-11-26', tiers: DEFAULT_TIERS })
    // Thu 11-26: dailies 24/25/26; this week's newest is 11-26, last week's (16..22) newest is Sun 11-22
    expect(days(kept)).toEqual(['2026-11-22', '2026-11-24', '2026-11-25', '2026-11-26'])
    expect(kept.length).toBeLessThanOrEqual(maxKeptAutoBackups(DEFAULT_TIERS))
  })

  it('on a Monday the previous Sunday is both a daily and a weekly', () => {
    const kept = simulate({ from: '2026-10-01', to: '2026-11-23', tiers: DEFAULT_TIERS })
    expect(days(kept)).toEqual(['2026-11-21', '2026-11-22', '2026-11-23'])
  })

  it('gaps: the tiers count buckets that hold a backup, not calendar days', () => {
    const kept = simulate({
      from: '2026-11-01',
      to: '2026-11-26',
      tiers: DEFAULT_TIERS,
      skip: ['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24'],
    })
    // dailies 20, 25, 26; weekly: this week (23..) newest 11-26, last week newest 11-20
    expect(days(kept)).toEqual(['2026-11-20', '2026-11-25', '2026-11-26'])
  })

  it('a whole missing week: the 7d tier reaches back to the newest week that has a backup', () => {
    const kept = simulate({
      from: '2026-11-01',
      to: '2026-11-26',
      tiers: [
        { every: '24h', keep: 1 },
        { every: '7d', keep: 3 },
      ],
      skip: [
        '2026-11-16',
        '2026-11-17',
        '2026-11-18',
        '2026-11-19',
        '2026-11-20',
        '2026-11-21',
        '2026-11-22',
      ],
    })
    // weeks: 23.. (26), 16..22 empty, 9..15 (15), 2..8 (8)
    expect(days(kept)).toEqual(['2026-11-08', '2026-11-15', '2026-11-26'])
  })

  it('48h buckets: epoch-day pairs', () => {
    const kept = simulate({ from: '2026-11-01', to: '2026-11-26', tiers: [{ every: '48h', keep: 2 }] })
    // pairs (even epoch day first): (25, 26) and (23, 24) -> newest of each
    expect(days(kept)).toEqual(['2026-11-24', '2026-11-26'])
  })

  it('a single 24h tier keeps exactly `keep` backups', () => {
    for (const keep of [1, 2, 7]) {
      const kept = simulate({ from: '2026-10-01', to: '2026-11-26', tiers: [{ every: '24h', keep }] })
      expect(kept).toHaveLength(keep)
    }
  })

  it('pinned, manual and young pre-restore bundles survive; old pre-restore ones go', () => {
    const now = at('2026-11-26T03:01:00Z')
    const pinned = bundle('2026-09-15T03:00:05Z', 'auto', { pinned: true })
    const manual = bundle('2026-08-01T12:00:00Z', 'manual')
    const manualUnverified = bundle('2026-08-02T12:00:00Z', 'manual', { verified: false })
    const young = bundle('2026-11-13T10:00:00Z', 'pre-restore')
    const old = bundle('2026-11-11T10:00:00Z', 'pre-restore')
    const oldPinned = bundle('2026-10-01T10:00:00Z', 'pre-restore', { pinned: true })
    const autos = [20, 21, 22, 23, 24, 25, 26].map((d) => bundle(`2026-11-${d}T03:00:05Z`))
    const all = [pinned, manual, manualUnverified, young, old, oldPinned, ...autos]
    const plan = planRetention(all, DEFAULT_TIERS, now)
    expect(plan.keep.get(pinned.id)).toEqual(['pinned'])
    expect(plan.keep.get(manual.id)).toEqual(['manual'])
    expect(plan.keep.get(manualUnverified.id)).toEqual(['manual'])
    expect(plan.keep.get(young.id)).toEqual(['pre_restore_recent'])
    expect(plan.keep.get(oldPinned.id)).toEqual(['pinned'])
    expect(plan.delete).toContain(old.id)
    expect(plan.delete).toEqual([old.id, autos[0]?.id, autos[1]?.id, autos[3]?.id])
    expect(plan.keep.get(autos[6]?.id as string)).toEqual(['tier:24h', 'tier:7d', 'newest_good'])
  })

  it('the newest verified backup is kept even when no tier wants it', () => {
    const now = at('2026-11-26T10:00:00Z')
    const good = bundle('2026-11-25T03:00:05Z')
    const broken = bundle('2026-11-26T03:00:05Z', 'auto', { verified: false })
    const plan = planRetention([good, broken], [{ every: '24h', keep: 1 }], now)
    expect(plan.keep.get(broken.id)).toEqual(['tier:24h'])
    expect(plan.keep.get(good.id)).toEqual(['newest_good'])
    expect(plan.delete).toEqual([])
  })

  it('the newest good backup may be a manual one; autos are then pruned by the tiers alone', () => {
    const now = at('2026-11-26T10:00:00Z')
    const autos = [23, 24, 25].map((d) => bundle(`2026-11-${d}T03:00:05Z`))
    const manual = bundle('2026-11-26T09:00:00Z', 'manual')
    const plan = planRetention([...autos, manual], [{ every: '24h', keep: 1 }], now)
    expect(plan.keep.get(manual.id)).toEqual(['newest_good', 'manual'])
    expect(plan.delete).toEqual([autos[0]?.id, autos[1]?.id])
  })

  it('within a bucket a verified backup wins over a newer unverified one', () => {
    const now = at('2026-11-26T20:00:00Z')
    const good = bundle('2026-11-26T03:00:05Z')
    const bad = bundle('2026-11-26T15:00:00Z', 'auto', { verified: false })
    const plan = planRetention([good, bad], [{ every: '24h', keep: 1 }], now)
    expect(plan.delete).toEqual([bad.id])
  })

  it('never deletes manual bundles, and never bundles from the future (clock skew)', () => {
    const now = at('2026-11-26T03:01:00Z')
    const manuals = [1, 2, 3, 4, 5].map((d) =>
      bundle(`2026-10-0${d}T10:00:00Z`, 'manual', { verified: false }),
    )
    const future = bundle('2026-11-27T03:00:05Z', 'auto', { verified: false })
    const plan = planRetention([...manuals, future], [{ every: '24h', keep: 1 }], now)
    expect(plan.delete).toEqual([])
    expect(plan.keep.get(future.id)).toContain('future')
  })

  it('an empty catalog prunes nothing', () => {
    expect(planRetention([], DEFAULT_TIERS, new Date()).delete).toEqual([])
  })

  it('protectedReasons marks what pruning keeps whatever the tiers say', () => {
    const now = at('2026-11-26T03:01:00Z')
    expect(protectedReasons(bundle('2026-11-01T03:00:00Z'), null, now)).toEqual([])
    const b = bundle('2026-11-01T03:00:00Z')
    expect(protectedReasons(b, b.id, now)).toEqual(['newest_good'])
    expect(protectedReasons(bundle('2026-11-20T03:00:00Z', 'pre-restore'), null, now)).toEqual([
      'pre_restore_recent',
    ])
  })
})

describe('schedule', () => {
  const s = (over: Partial<{ enabled: boolean; time_utc: string; tiers: BackupTier[] }> = {}) => ({
    enabled: true,
    time_utc: '03:00',
    tiers: DEFAULT_TIERS,
    ...over,
  })

  it('the cadence is the smallest tier interval', () => {
    expect(cadenceEvery(DEFAULT_TIERS)).toBe('24h')
    expect(cadenceEvery([{ every: '7d', keep: 1 }])).toBe('7d')
    expect(
      cadenceEvery([
        { every: '7d', keep: 1 },
        { every: '48h', keep: 1 },
      ]),
    ).toBe('48h')
  })

  it('slot days: every day, even epoch days, Mondays', () => {
    expect(isSlotDay('24h', 20783)).toBe(true)
    expect(isSlotDay('48h', 20782)).toBe(true)
    expect(isSlotDay('48h', 20783)).toBe(false)
    expect(isSlotDay('7d', 20780)).toBe(true) // 2026-11-23, a Monday
    expect(isSlotDay('7d', 20783)).toBe(false)
  })

  it.each([
    // [label, settings, now, lastAutoAt, due]
    ['off', s({ enabled: false }), '2026-11-26T10:00:00Z', null, false],
    ['first ever, past the slot', s(), '2026-11-26T03:00:00Z', null, true],
    ['before today’s slot, yesterday done', s(), '2026-11-26T02:59:59Z', '2026-11-25T03:00:05Z', false],
    ['at the slot, yesterday done', s(), '2026-11-26T03:00:00Z', '2026-11-25T03:00:05Z', true],
    ['today done', s(), '2026-11-26T03:15:00Z', '2026-11-26T03:00:05Z', false],
    ['made up later in the day', s(), '2026-11-26T22:00:00Z', '2026-11-25T03:00:05Z', true],
    ['late time', s({ time_utc: '23:30' }), '2026-11-26T23:29:00Z', '2026-11-25T23:30:05Z', false],
    // 48h: 11-26 is odd, so the slot is 11-25 03:00
    [
      '48h odd day, slot done',
      s({ tiers: [{ every: '48h', keep: 2 }] }),
      '2026-11-26T10:00:00Z',
      '2026-11-25T03:00:05Z',
      false,
    ],
    [
      '48h odd day, slot missed',
      s({ tiers: [{ every: '48h', keep: 2 }] }),
      '2026-11-26T10:00:00Z',
      '2026-11-23T03:00:05Z',
      true,
    ],
    // 7d: Mondays; Thursday 11-26 after Monday's backup
    [
      '7d mid-week, done',
      s({ tiers: [{ every: '7d', keep: 2 }] }),
      '2026-11-26T10:00:00Z',
      '2026-11-23T03:00:05Z',
      false,
    ],
    [
      '7d mid-week, missed',
      s({ tiers: [{ every: '7d', keep: 2 }] }),
      '2026-11-26T10:00:00Z',
      '2026-11-16T03:00:05Z',
      true,
    ],
    // a manual backup does not count: lastAutoAt is auto only (the caller filters)
  ] as const)('%s', (_label, settings, now, lastAutoAt, due) => {
    const r = backupDue({ settings, now: at(now), lastAutoAt: lastAutoAt ? at(lastAutoAt) : null })
    expect(r.due).toBe(due)
  })

  it('currentSlot and nextSlotAfter', () => {
    expect(currentSlot(s(), at('2026-11-26T02:00:00Z')).toISOString()).toBe('2026-11-25T03:00:00.000Z')
    expect(currentSlot(s(), at('2026-11-26T03:00:00Z')).toISOString()).toBe('2026-11-26T03:00:00.000Z')
    expect(nextSlotAfter(s(), at('2026-11-26T03:00:00Z')).toISOString()).toBe('2026-11-27T03:00:00.000Z')
    const weekly = s({ tiers: [{ every: '7d', keep: 1 }] })
    expect(nextSlotAfter(weekly, at('2026-11-26T03:00:00Z')).toISOString()).toBe('2026-11-30T03:00:00.000Z')
    expect(currentSlot(weekly, at('2026-11-26T03:00:00Z')).toISOString()).toBe('2026-11-23T03:00:00.000Z')
  })

  it('nextDueAt: null when off, the current slot while due, else the next slot', () => {
    const now = at('2026-11-26T10:00:00Z')
    expect(nextDueAt({ settings: s({ enabled: false }), now, lastAutoAt: null })).toBeNull()
    expect(nextDueAt({ settings: s(), now, lastAutoAt: null })?.toISOString()).toBe(
      '2026-11-26T03:00:00.000Z',
    )
    expect(nextDueAt({ settings: s(), now, lastAutoAt: at('2026-11-26T03:00:05Z') })?.toISOString()).toBe(
      '2026-11-27T03:00:00.000Z',
    )
  })

  it('isOverdue: on, and the newest good backup is older than twice the cadence', () => {
    const now = at('2026-11-26T10:00:00Z')
    const base = { enabled: true, tiers: DEFAULT_TIERS, settingsUpdatedAt: at('2026-01-01T00:00:00Z'), now }
    expect(isOverdue({ ...base, lastGoodAt: at('2026-11-25T03:00:00Z') })).toBe(false)
    expect(isOverdue({ ...base, lastGoodAt: at('2026-11-24T09:59:00Z') })).toBe(true)
    expect(isOverdue({ ...base, enabled: false, lastGoodAt: null })).toBe(false)
    // no backup yet: measured from when the schedule was saved
    expect(isOverdue({ ...base, lastGoodAt: null, settingsUpdatedAt: at('2026-11-26T09:00:00Z') })).toBe(
      false,
    )
    expect(isOverdue({ ...base, lastGoodAt: null })).toBe(true)
    // saving the settings does not hide an old last good backup
    expect(
      isOverdue({
        ...base,
        lastGoodAt: at('2026-11-16T10:00:00Z'),
        settingsUpdatedAt: at('2026-11-26T09:00:00Z'),
      }),
    ).toBe(true)
    // weekly cadence: 14 days
    const weekly = { ...base, tiers: [{ every: '7d' as const, keep: 2 }] }
    expect(isOverdue({ ...weekly, lastGoodAt: at('2026-11-13T10:00:00Z') })).toBe(false)
    expect(isOverdue({ ...weekly, lastGoodAt: at('2026-11-12T09:00:00Z') })).toBe(true)
  })
})
