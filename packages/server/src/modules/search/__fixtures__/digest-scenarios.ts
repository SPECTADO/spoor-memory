/**
 * Deterministic digest inputs without library pages. `digest-no-library.json` holds `buildDigest` output for
 * each scenario, captured before the Library tier (tier 0) existed; digest.test.ts asserts the output is still
 * byte-identical (plan §1.4: zero library pages give the same digest as before).
 */
import type { DigestCandidate } from '../digest.js'

export type LegacyTier = 1 | 2 | 3 | 4 | 5

export interface Scenario {
  name: string
  slug: string
  budget: number
  decisionWindowDays: number
  query: string | null
  tiers: Record<LegacyTier, DigestCandidate[]>
}

/** mulberry32: a tiny seeded PRNG, so the scenarios never change between runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = [
  'session',
  'store',
  'Кириллица',
  '中文标题',
  'pgvector',
  'emoji 🚀',
  'retry',
  'cache',
  'auth',
  'deploy',
]
const TYPES = ['fact', 'procedure', 'observation', 'decision'] as const

function pool(seed: number, n: number): DigestCandidate[] {
  const r = rng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T
  return Array.from({ length: n }, (_, i) => {
    const roll = r()
    const shared = r() < 0.2
    const words = Array.from({ length: 1 + Math.floor(r() * 14) }, () => pick(WORDS)).join(' ')
    const base = { id: `id-${seed}-${i}`, agent: r() < 0.3, title: `${words} ${i}`, anchor: null }
    if (roll < 0.2) {
      const status = r() < 0.8 ? 'accepted' : 'proposed'
      return {
        ...base,
        agent: false,
        handle: `${shared ? 'S:' : ''}ADR-${String(i + 1).padStart(4, '0')}`,
        space: 'decisions',
        type: null,
        status,
        confidence: null,
        decidedOn: status === 'accepted' ? `2026-10-${String(1 + (i % 28)).padStart(2, '0')}` : null,
        expiresAt: null,
      }
    }
    if (roll < 0.35) {
      return {
        ...base,
        handle: `${shared ? 'S:' : ''}d${i + 1}`,
        space: 'docs',
        type: null,
        status: 'active',
        confidence: null,
        decidedOn: null,
        expiresAt: null,
      }
    }
    const type = pick(TYPES)
    return {
      ...base,
      handle: `${shared ? 'S:' : ''}m${i + 1}`,
      space: 'memories',
      type,
      status: 'active',
      confidence: pick(['low', 'medium', 'high', null]),
      decidedOn: null,
      expiresAt: type === 'observation' && r() < 0.7 ? new Date(Date.UTC(2026, 10, 1 + (i % 27), 12)) : null,
    }
  })
}

function scenario(seed: number, budget: number, sizes: Record<LegacyTier, number>, query: boolean): Scenario {
  const all = pool(seed, 200)
  const r = rng(seed * 7 + 1)
  const take = (n: number) =>
    Array.from({ length: n }, () => all[Math.floor(r() * all.length)] as DigestCandidate)
  const dedupe = (xs: DigestCandidate[]) => xs.filter((c, i) => xs.findIndex((x) => x.id === c.id) === i)
  return {
    name: `seed${seed}-b${budget}-${Object.values(sizes).join('.')}${query ? '-q' : ''}`,
    slug: 'acme',
    budget,
    decisionWindowDays: 30,
    query: query ? `session "expiry" ${seed}` : null,
    tiers: {
      1: dedupe(take(sizes[1])),
      2: dedupe(all.filter((c) => c.space === 'decisions' && c.status === 'accepted')).slice(0, sizes[2]),
      3: dedupe(take(sizes[3])).map((c, i) => ({ ...c, anchor: `src/mod${i % 9}/` })),
      4: dedupe(take(sizes[4])),
      5: dedupe(take(sizes[5])),
    },
  }
}

export function scenarios(): Scenario[] {
  const out: Scenario[] = []
  const shapes: [Record<LegacyTier, number>, boolean][] = [
    [{ 1: 50, 2: 20, 3: 30, 4: 15, 5: 60 }, true],
    [{ 1: 50, 2: 20, 3: 0, 4: 0, 5: 60 }, false],
    [{ 1: 5, 2: 3, 3: 30, 4: 0, 5: 60 }, false],
    [{ 1: 0, 2: 20, 3: 0, 4: 15, 5: 0 }, true],
    [{ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, false],
    [{ 1: 3, 2: 0, 3: 0, 4: 0, 5: 4 }, false],
  ]
  let seed = 1
  for (const [sizes, query] of shapes) {
    for (const budget of [125, 200, 577, 1500, 3000, 8000]) out.push(scenario(seed++, budget, sizes, query))
  }
  for (let budget = 200; budget <= 8000; budget += 377) {
    out.push(scenario(seed++, budget, { 1: 50, 2: 20, 3: 30, 4: 15, 5: 60 }, true))
  }
  return out
}
