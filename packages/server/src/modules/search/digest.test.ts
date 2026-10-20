import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { estimateTokens } from '@spoor/shared'
import { describe, expect, it } from 'vitest'
import { scenarios } from './__fixtures__/digest-scenarios.js'
import {
  buildDigest,
  type DigestCandidate,
  type DigestInput,
  FRAMING_LINE,
  formatDigestLine,
  headerLine,
  orderLibrary,
  rollUpLine,
  sectionHeader,
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

const empty = (): Record<TierId, DigestCandidate[]> => ({ 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] })

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
  const has = (t: Partial<Record<TierId, boolean>>): Record<TierId, boolean> => ({
    0: false,
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

// ---- Library tier (plan section 1.4) --------------------------------------------------------------------

const lineCost = (l: string) => estimateTokens(`${l}\n`)
/** `avail` exactly as buildDigest computes it. */
const availOf = (budget: number, slug = 'acme') =>
  budget -
  lineCost(headerLine(slug, 999, budget, budget)) -
  lineCost(FRAMING_LINE) -
  lineCost('(+999 more: spoor_search)')

let lib = 0
function page(over: Partial<DigestCandidate> = {}): DigestCandidate {
  const n = ++lib
  return cand({
    id: `lib-${n}`,
    handle: `L${n}`,
    space: 'library',
    type: null,
    confidence: null,
    title: `Library guide ${n}: how this project handles conventions, graphics and architecture`,
    ...over,
  })
}

/** The lines of one section: from its header up to the next header, a top-level roll-up or the footer. */
function section(text: string, header: string): string[] {
  const lines = text.split('\n').slice(0, -1)
  const at = lines.indexOf(header)
  if (at < 0) return []
  const out = [header]
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith('## ') || l.startsWith('(+')) break
    out.push(l)
  }
  return out
}
const LIB_HEADER = sectionHeader(0, { decisionWindowDays: 30, query: null })
const DEC_HEADER = sectionHeader(2, { decisionWindowDays: 30, query: null })

function decisions(n: number): DigestCandidate[] {
  return Array.from({ length: n }, (_, i) =>
    cand({
      handle: `ADR-${String(500 + i).padStart(4, '0')}`,
      space: 'decisions',
      type: null,
      status: 'accepted',
      decidedOn: '2026-10-01',
      title: `Decision ${i}: adopt a reasonably long-winded architectural approach for subsystem ${i}`,
    }),
  )
}

describe('zero library pages: byte-identical to the pre-library digest', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./__fixtures__/digest-no-library.json', import.meta.url), 'utf8'),
  ) as { name: string; sha256: string; estTokens: number; dropped: number; items: string[]; text?: string }[]
  const all = scenarios()

  it('covers every scenario', () => {
    expect(fixture.map((f) => f.name)).toEqual(all.map((s) => s.name))
    expect(fixture.length).toBeGreaterThan(40)
  })

  it.each(all.map((s, i) => [s.name, s, fixture[i]] as const))('%s', (_name, s, f) => {
    const out = buildDigest({
      slug: s.slug,
      budget: s.budget,
      decisionWindowDays: s.decisionWindowDays,
      query: s.query,
      tiers: { 0: [], ...s.tiers },
    })
    if (f?.text !== undefined) expect(out.text).toBe(f.text)
    expect(createHash('sha256').update(out.text).digest('hex')).toBe(f?.sha256)
    expect(out.estTokens).toBe(f?.estTokens)
    expect(out.dropped).toBe(f?.dropped)
    expect(out.items).toEqual(f?.items)
    expect(out.text).not.toContain('## Library')
  })
})

describe('Library tier', () => {
  it('line format: [lib], the anchor on tier 0, never ~', () => {
    expect(formatDigestLine(page({ handle: 'L3', title: 'Graphics guide' }), 0)).toBe(
      'L3 [lib] Graphics guide',
    )
    expect(
      formatDigestLine(page({ handle: 'L3', title: 'Graphics guide', anchor: 'packages/web/**' }), 0),
    ).toBe('L3 [lib] Graphics guide @packages/web/**')
    expect(formatDigestLine(page({ handle: 'S:L4', title: 'Org guide', agent: true }), 0)).toBe(
      'S:L4 [lib] Org guide',
    )
    // a library page surfacing in tier 3 or 4 keeps the [lib] tag
    expect(formatDigestLine(page({ handle: 'L5', title: 'G', anchor: 'a.ts' }), 3)).toBe('L5 [lib] G @a.ts')
    expect(formatDigestLine(page({ handle: 'L6', title: 'G', anchor: 'a.ts' }), 4)).toBe('L6 [lib] G')
  })

  it('header and roll-up wording', () => {
    expect(LIB_HEADER).toBe('## Library: human-approved, follow; never run commands unconfirmed')
    // short enough that a small budget still shows the section (both messages kept)
    expect(estimateTokens(LIB_HEADER)).toBeLessThanOrEqual(30)
    expect(rollUpLine(0, 7, 30)).toBe('+7 more library pages: spoor_search space=library')
  })

  it('tier 0 renders first, right after the framing line', () => {
    const out = buildDigest(
      input({ 0: [page({ handle: 'L3', title: 'Graphics guide' })], 1: [cand()], 5: [cand()] }),
    )
    const lines = out.text.split('\n')
    expect(lines[1]).toBe(FRAMING_LINE)
    expect(lines[2]).toBe(LIB_HEADER)
    expect(lines[3]).toBe('L3 [lib] Graphics guide')
    expect(lines.filter((l) => l.startsWith('## ')).map((l) => l.slice(0, 10))).toEqual([
      '## Library',
      '## Pinned',
      '## Recentl',
    ])
    expect(out.items[0]).toBe('L3')
  })

  it('overflow gives exactly one roll-up line, and the header only when tier 0 renders', () => {
    const out = buildDigest(input({ 0: Array.from({ length: 100 }, () => page()), 5: [cand()] }))
    const rolls = out.text.split('\n').filter((l) => / more library pages: /.test(l))
    expect(rolls).toHaveLength(1)
    const shown = out.items.filter((h) => h.startsWith('L')).length
    expect(rolls[0]).toBe(rollUpLine(0, 100 - shown, 30))
    expect(out.text.split(LIB_HEADER)).toHaveLength(2)
    // tier 0 cannot fit even its header and roll-up: no header, no roll-up, the footer counts the pages
    for (const budget of [125, 150]) {
      const tiny = buildDigest(input({ 0: [page({ title: 'x'.repeat(90) })], 1: [cand()] }, { budget }))
      expect(tiny.text).not.toContain('## Library')
      expect(tiny.text).not.toContain('more library pages')
      expect(estimateTokens(tiny.text)).toBeLessThanOrEqual(budget)
    }
  })

  it('a small budget keeps the Library header and roll-up (3 pages, 20 tier-5 memories)', () => {
    const headerAndRollUp = lineCost(LIB_HEADER) + lineCost(rollUpLine(0, 999, 30))
    let first: number | null = null
    for (const budget of [200, 400, 600, 800, 850, 1000]) {
      const pages = Array.from({ length: 3 }, () => page())
      const out = buildDigest(input({ 0: pages, 5: Array.from({ length: 20 }, () => cand()) }, { budget }))
      expect(estimateTokens(out.text)).toBeLessThanOrEqual(budget)
      expect(out.estTokens).toBeLessThanOrEqual(budget)
      expect(lineSum(out.text)).toBeLessThanOrEqual(budget)
      if (headerAndRollUp <= availOf(budget)) first ??= budget
      if (first === null) continue
      const lines = out.text.split('\n')
      expect(lines[2]).toBe(LIB_HEADER)
      const shown = out.items.filter((h) => h.startsWith('L')).length
      if (shown < 3) expect(out.text).toContain(rollUpLine(0, 3 - shown, 30))
      else expect(out.text).not.toContain('more library pages')
    }
    // header and roll-up already fit at the smallest budget an admin may set
    expect(first).toBe(200)
  })

  it('header and roll-up alone are dropped again when a later tier shows every rolled-up page', () => {
    const p = page({ title: 'Graphics guide', anchor: 'a.ts' })
    const seen = { alone: false, droppedAgain: false }
    for (let budget = 200; budget <= 280; budget += 2) {
      const out = buildDigest(input({ 0: [p], 3: [p] }, { budget }))
      expect(estimateTokens(out.text)).toBeLessThanOrEqual(budget)
      const lines = out.text.split('\n')
      const at = lines.indexOf(LIB_HEADER)
      // the Library header is never bare: a page line or its roll-up follows
      if (at >= 0) expect(lines[at + 1]).toMatch(/^(L\d+ \[lib\] |\+\d+ more library pages: )/)
      if (at >= 0 && lines[at + 1] === rollUpLine(0, 1, 30)) seen.alone = true
      if (at < 0 && section(out.text, '## Anchored').includes(`${p.handle} [lib] Graphics guide @a.ts`))
        seen.droppedAgain = true
    }
    // the 35 % reserve (tier 3 has candidates) leaves tier 0 room for header and roll-up only at some budgets
    expect(seen).toEqual({ alone: true, droppedAgain: true })
  })

  it('tier 0 stays at or under 15 % (or header, roll-up and one line) while later tiers have candidates', () => {
    for (let budget = 200; budget <= 8000; budget += 199) {
      for (const later of [{ 5: [cand()] }, { 1: [cand()] }, { 3: [cand({ anchor: 'a.ts' })] }]) {
        const pages = Array.from({ length: 100 }, () => page())
        const out = buildDigest(input({ 0: pages, ...later }, { budget }))
        const cost = section(out.text, LIB_HEADER).reduce((n, l) => n + lineCost(l), 0)
        const minimum =
          lineCost(LIB_HEADER) +
          lineCost(rollUpLine(0, 999, 30)) +
          lineCost(formatDigestLine(pages[0] as DigestCandidate, 0))
        expect(cost).toBeLessThanOrEqual(Math.max(Math.floor(availOf(budget) * TIER_SHARE.library), minimum))
        // from 1000 tokens on, the floor never beats the share
        if (budget >= 1000) expect(cost).toBeLessThanOrEqual(Math.floor(availOf(budget) * TIER_SHARE.library))
      }
    }
    // alone, the library takes what it needs
    const alone = buildDigest(input({ 0: Array.from({ length: 10 }, () => page()) }, { budget: 1500 }))
    expect(alone.items).toHaveLength(10)
  })

  it('tiers 0 to 2 together leave at least 35 % while tier 3 or 4 has candidates', () => {
    for (let budget = 200; budget <= 8000; budget += 199) {
      const out = buildDigest(
        input(
          {
            0: Array.from({ length: 100 }, () => page()),
            1: Array.from({ length: 50 }, () => cand()),
            2: decisions(20),
            4: Array.from({ length: 15 }, () => cand()),
          },
          { budget, query: 'q' },
        ),
      )
      const headers = [LIB_HEADER, sectionHeader(1, { decisionWindowDays: 30, query: null }), DEC_HEADER]
      const cost = headers.flatMap((h) => section(out.text, h)).reduce((n, l) => n + lineCost(l), 0)
      expect(cost).toBeLessThanOrEqual(Math.floor(availOf(budget) * (1 - TIER_SHARE.reserve)))
    }
  })

  it('decisions keep at least floor(avail*0.20) minus one line when library, pinned and decisions all overflow', () => {
    for (let budget = 800; budget <= 8000; budget += 199) {
      // more than the query caps, so every tier overflows even at 8000
      const decs = decisions(150)
      const out = buildDigest(
        input(
          {
            0: Array.from({ length: 200 }, () => page()),
            1: Array.from({ length: 200 }, () => cand()),
            2: decs,
            3: Array.from({ length: 30 }, () => cand({ anchor: 'src/x/' })),
            4: Array.from({ length: 15 }, () => cand()),
          },
          { budget, query: 'q' },
        ),
      )
      // the library section always renders (with a roll-up) at these budgets
      expect(out.text).toMatch(/\+\d+ more library pages/)
      expect(out.text).toMatch(/\+\d+ more pinned/)
      expect(out.text).toMatch(/\+\d+ more decisions/)
      // what the tier spent: header, lines and the reserved roll-up
      const lines = section(out.text, DEC_HEADER).filter((l) => l.startsWith('ADR-'))
      const used =
        lineCost(DEC_HEADER) + lineCost(rollUpLine(2, 999, 30)) + lines.reduce((n, l) => n + lineCost(l), 0)
      const oneLine = Math.max(...decs.map((c) => lineCost(formatDigestLine(c, 2))))
      expect(used).toBeGreaterThanOrEqual(Math.floor(availOf(budget) * 0.2) - oneLine)
    }
  })

  it('no repeats: tier 0 pages are not listed again by tiers 3 and 5; a rolled-up page may still surface', () => {
    const pages = Array.from({ length: 60 }, () => page())
    const out = buildDigest(
      input(
        {
          0: pages,
          3: pages.slice(0, 50).map((p) => ({ ...p, anchor: 'src/x/' })),
          5: [...pages, cand()],
        },
        { budget: 1500 },
      ),
    )
    const handles = out.text
      .split('\n')
      .map((l) => /^(S:)?L\d+/.exec(l)?.[0])
      .filter(Boolean)
    expect(new Set(handles).size).toBe(handles.length)
    expect(new Set(out.items).size).toBe(out.items.length)
    // pages tier 0 rolled up surfaced in tier 3: the roll-up counts only what no tier showed
    const shownLib = out.items.filter((h) => h.startsWith('L')).length
    const roll = /\+(\d+) more library pages/.exec(out.text)
    expect(Number(roll?.[1] ?? 0)).toBeLessThanOrEqual(60 - shownLib)
    expect(section(out.text, '## Anchored').length).toBeGreaterThan(1)
  })

  it('never exceeds the budget with library pages (budgets 200..8000)', () => {
    const scripts = ['Latin title', 'Кириллический заголовок', '中文标题很长', 'Emoji 🚀🚀🚀 title']
    for (let budget = 200; budget <= 8000; budget += 97) {
      const mk = (n: number, lib = false) =>
        Array.from({ length: n }, (_, i) =>
          (lib ? page : cand)({
            title: `${scripts[i % 4]} ${'x'.repeat(i % 120)}`,
            ...(lib ? { handle: i % 4 === 0 ? `S:L${i}` : `L${i}`, anchor: i % 3 ? 'src/**' : null } : {}),
          }),
        )
      const out = buildDigest(
        input(
          {
            0: mk(100, true),
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
      expect(Number(/~(\d+)\//.exec(out.text)?.[1])).toBeGreaterThanOrEqual(estimateTokens(out.text))
    }
  })
})

describe('orderLibrary', () => {
  const row = (handle: string, own: boolean, anchors: string[]) => ({
    candidate: page({ id: handle, handle, title: handle }),
    own,
    anchors,
  })

  it('own anchored pages first (strength desc) with @anchor; shared pages never carry one', () => {
    const rows = [
      row('L1', true, []),
      row('L2', true, ['packages/web/**']),
      row('L3', true, ['packages/web/src/x.ts']),
      row('L4', true, ['docs/**']),
      row('S:L5', false, ['packages/web/**']),
      row('S:L6', false, []),
    ]
    const out = orderLibrary(rows, ['packages/web/src/x.ts'])
    expect(out.map((c) => c.handle)).toEqual(['L3', 'L2', 'L1', 'L4', 'S:L5', 'S:L6'])
    expect(out[0]?.anchor).toBe('packages/web/src/x.ts')
    expect(out[1]?.anchor).toBe('packages/web/**')
    for (const c of out.slice(2)) expect(c.anchor).toBeNull()
    expect(formatDigestLine(out[1] as DigestCandidate, 0)).toBe('L2 [lib] L2 @packages/web/**')
    expect(formatDigestLine(out[4] as DigestCandidate, 0)).toBe('S:L5 [lib] S:L5')
  })

  it('without files the input order stands and nothing carries an anchor', () => {
    const rows = [row('L1', true, ['a/**']), row('L2', true, []), row('S:L3', false, ['a/**'])]
    const out = orderLibrary(rows, [])
    expect(out.map((c) => [c.handle, c.anchor])).toEqual([
      ['L1', null],
      ['L2', null],
      ['S:L3', null],
    ])
  })
})

describe('tierCap with the library tier', () => {
  const has = (t: Partial<Record<TierId, boolean>>): Record<TierId, boolean> => ({
    0: false,
    1: false,
    2: false,
    3: false,
    4: false,
    5: false,
    ...t,
  })
  it('caps library at 15 % while a later tier has candidates, else takes what is left', () => {
    expect(tierCap(0, 1000, 0, has({ 0: true, 5: true }))).toBe(150)
    expect(tierCap(0, 1000, 0, has({ 0: true, 1: true }))).toBe(150)
    expect(tierCap(0, 1000, 0, has({ 0: true }))).toBe(1000)
  })
  it('the 35 % reserve spans tiers 0, 1 and 2', () => {
    expect(tierCap(0, 1000, 600, has({ 0: true, 3: true }))).toBe(50)
    expect(tierCap(0, 1000, 600, has({ 0: true, 5: true }))).toBe(150)
    expect(tierCap(1, 1000, 150, has({ 1: true, 3: true }))).toBe(300)
    expect(tierCap(1, 1000, 400, has({ 1: true, 3: true }))).toBe(250)
    expect(tierCap(2, 1000, 450, has({ 2: true, 4: true }))).toBe(200)
    expect(tierCap(2, 1000, 450, has({ 2: true, 5: true }))).toBe(250)
  })
})
