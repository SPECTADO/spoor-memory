import { estimateTokens } from '@spoor/shared'
import { describe, expect, it } from 'vitest'
import {
  buildDigest,
  type DigestCandidate,
  type DigestInput,
  FRAMING_LINE,
  formatDigestLine,
  TIER_SHARE,
  type TierId,
  tierCap,
  truncateTitle,
} from './digest.js'

let seq = 0
function cand(over: Partial<DigestCandidate> = {}): DigestCandidate {
  const n = ++seq
  return {
    id: `id-${n}`,
    handle: `m${n}`,
    agent: false,
    space: 'memories',
    type: 'fact',
    status: 'active',
    title: `Fact number ${n} about the session store and its pruning schedule`,
    confidence: 'medium',
    decidedOn: null,
    expiresAt: null,
    ...over,
  }
}

const empty = (): Record<TierId, DigestCandidate[]> => ({ 1: [], 2: [], 3: [], 4: [], 5: [] })

function input(
  tiers: Partial<Record<TierId, DigestCandidate[]>>,
  over: Partial<DigestInput> = {},
): DigestInput {
  return {
    slug: 'acme',
    budget: 1500,
    decisionWindowDays: 30,
    query: null,
    tiers: { ...empty(), ...tiers },
    ...over,
  }
}

/** Σ est(line + '\n') over the emitted lines: the quantity the guarantee is built on. */
const lineSum = (text: string) =>
  text
    .split('\n')
    .slice(0, -1)
    .reduce((n, l) => n + estimateTokens(`${l}\n`), 0)

describe('line format', () => {
  it('handle, ~ marker, tag, title, suffixes', () => {
    expect(formatDigestLine(cand({ handle: 'm42', title: 'Sessions are server-side' }), 1)).toBe(
      'm42 [fact] Sessions are server-side',
    )
    expect(
      formatDigestLine(
        cand({
          handle: 'm61',
          agent: true,
          type: 'observation',
          title: 'Flaky test',
          expiresAt: new Date('2026-10-21T10:00:00Z'),
          anchor: 'src/auth/',
          confidence: 'low',
        }),
        3,
      ),
    ).toBe('m61~ [obs] Flaky test (low conf) (exp 10-21) @src/auth/')
    expect(
      formatDigestLine(
        cand({
          handle: 'ADR-0012',
          space: 'decisions',
          type: null,
          status: 'accepted',
          decidedOn: '2026-10-02',
          title: 'Use pgvector',
        }),
        2,
      ),
    ).toBe('ADR-0012 [accepted 2026-10-02] Use pgvector')
    expect(formatDigestLine(cand({ handle: 'S:d3', space: 'docs', type: null, title: 'Org TS' }), 1)).toBe(
      'S:d3 [doc] Org TS',
    )
    expect(formatDigestLine(cand({ handle: 'm1', type: 'procedure', title: 'P' }), 5)).toBe('m1 [proc] P')
    expect(formatDigestLine(cand({ handle: 'm2', type: 'decision', title: 'D' }), 5)).toBe('m2 [dec] D')
    // the anchor suffix only in tier 3
    expect(formatDigestLine(cand({ handle: 'm3', title: 'X', anchor: 'a.ts' }), 5)).toBe('m3 [fact] X')
  })
  it('titles are cut to 90 chars with … and lose control/bidi characters', () => {
    const t = truncateTitle('x'.repeat(200))
    expect([...t]).toHaveLength(90)
    expect(t.endsWith('…')).toBe(true)
    expect(truncateTitle('a‮b\u0007c')).toBe('abc')
  })
})

describe('buildDigest', () => {
  it('header, framing line, sections in tier order, first tier wins', () => {
    const shared = cand({ title: 'In both tiers' })
    const out = buildDigest(
      input({ 1: [shared], 3: [{ ...shared, anchor: 'x.ts' }, cand({ anchor: 'y.ts' })], 5: [cand()] }),
    )
    const lines = out.text.split('\n')
    expect(lines[0]).toMatch(
      /^Spoor digest acme \(spoor_context output\) · 3 items · ~\d+\/1500 tok · details: spoor_get <id>$/,
    )
    expect(lines[1]).toBe(FRAMING_LINE)
    expect(lines.filter((l) => l.startsWith('## '))).toEqual([
      '## Pinned',
      '## Anchored',
      '## Recently verified',
    ])
    expect(out.text.split(shared.handle).length - 1).toBe(1)
    expect(out.items).toHaveLength(3)
    expect(out.dropped).toBe(0)
  })

  it('a tiny budget returns the header only', () => {
    const out = buildDigest(input({ 1: [cand(), cand()] }, { budget: 125 }))
    expect(out.text.split('\n').filter(Boolean)).toHaveLength(2)
    expect(estimateTokens(out.text)).toBeLessThanOrEqual(125)
    expect(out.items).toHaveLength(0)
  })

  it('relevant section names the query', () => {
    const out = buildDigest(input({ 4: [cand()] }, { query: 'session "expiry"' }))
    expect(out.text).toContain(`## Relevant: "session 'expiry'"`)
  })

  it('synthetic large project at 1500: >= 10 anchored lines and est(output) <= 1500', () => {
    const pinned = Array.from({ length: 50 }, () =>
      cand({
        space: 'docs',
        type: null,
        title: `Pinned doc ${seq} with a long descriptive title about conventions and practices`,
      }),
    )
    const decisions = Array.from({ length: 40 }, (_, i) =>
      cand({
        handle: `ADR-${String(100 + i).padStart(4, '0')}`,
        space: 'decisions',
        type: null,
        status: 'accepted',
        decidedOn: '2026-10-01',
        title: `Decision ${i}: adopt a reasonably long-winded architectural approach for subsystem ${i}`,
      }),
    )
    const anchored = Array.from({ length: 200 }, (_, i) => cand({ anchor: `src/module${i}/` }))
    const verified = Array.from({ length: 60 }, () => cand())
    const out = buildDigest(input({ 1: pinned, 2: decisions, 3: anchored.slice(0, 30), 5: verified }))
    const anchoredLines = out.text
      .split('## Anchored\n')[1]
      ?.split('\n## ')[0]
      ?.split('\n')
      .filter((l) => /^m\d+/.test(l))
    expect(anchoredLines?.length ?? 0).toBeGreaterThanOrEqual(10)
    expect(estimateTokens(out.text)).toBeLessThanOrEqual(1500)
    expect(lineSum(out.text)).toBeLessThanOrEqual(1500)
    expect(out.text).toMatch(/\+\d+ more pinned: spoor_search/)
    expect(out.text).toMatch(/\+\d+ more decisions \(30d\): spoor_search space=decisions/)
    expect(out.text).toMatch(/\(\+\d+ more: spoor_search\)\n$/)
    expect(out.dropped).toBeGreaterThan(0)
  })

  it('never exceeds the budget across budgets and scripts (property check)', () => {
    const scripts = ['Latin title', 'Кириллический заголовок', '中文标题很长', 'Emoji 🚀🚀🚀 title']
    for (let budget = 200; budget <= 8000; budget += 377) {
      const mk = (n: number) =>
        Array.from({ length: n }, (_, i) =>
          cand({ title: `${scripts[i % 4]} ${'x'.repeat(i % 120)}`, agent: i % 3 === 0 }),
        )
      const out = buildDigest(
        input(
          {
            1: mk(50),
            2: mk(20),
            3: mk(30).map((c) => ({ ...c, anchor: 'src/x.ts' })),
            4: mk(15),
            5: mk(60),
          },
          { budget, query: 'q' },
        ),
      )
      expect(estimateTokens(out.text)).toBeLessThanOrEqual(budget)
      expect(lineSum(out.text)).toBeLessThanOrEqual(budget)
      const header = Number(/~(\d+)\//.exec(out.text)?.[1])
      expect(header).toBeGreaterThanOrEqual(estimateTokens(out.text))
    }
  })

  it('without files or query the pinned and decision caps still leave room for tier 5', () => {
    const pinned = Array.from({ length: 50 }, () => cand())
    const out = buildDigest(input({ 1: pinned, 5: Array.from({ length: 60 }, () => cand()) }))
    expect(out.text).toContain('## Recently verified')
  })
})

describe('tierCap', () => {
  const has = (t: Partial<Record<TierId, boolean>>) => ({
    1: false,
    2: false,
    3: false,
    4: false,
    5: false,
    ...t,
  })
  it('caps pinned at 30 % and decisions at 25 % while later tiers have candidates', () => {
    expect(tierCap(1, 1000, 0, has({ 1: true, 5: true }))).toBe(Math.floor(1000 * TIER_SHARE.pinned))
    expect(tierCap(2, 1000, 100, has({ 2: true, 3: true }))).toBe(250)
  })
  it('a tier with nothing after it takes everything left', () => {
    expect(tierCap(1, 1000, 0, has({ 1: true }))).toBe(1000)
    expect(tierCap(5, 1000, 400, has({ 5: true }))).toBe(600)
  })
  it('tiers 1 and 2 together leave 35 % for anchored/relevant', () => {
    expect(tierCap(2, 1000, 500, has({ 2: true, 4: true }))).toBe(150)
  })
})

describe('dropped counts (phase-2 review SC4)', () => {
  it('an item listed by several tiers is counted once in the roll-ups and the footer', () => {
    const all = Array.from({ length: 30 }, () => cand())
    const pinned = all.slice(0, 20)
    const out = buildDigest(input({ 1: pinned, 5: all }, { budget: 300 }))
    const shown = out.items.length
    expect(out.dropped).toBe(30 - shown)
    const rolled = [...out.text.matchAll(/^\+(\d+) more /gm)].reduce((n, m) => n + Number(m[1]), 0)
    expect(rolled).toBeLessThanOrEqual(30 - shown)
    const footer = /\(\+(\d+) more: spoor_search\)\n$/.exec(out.text)
    expect(Number(footer?.[1])).toBe(30 - shown)
  })
})
