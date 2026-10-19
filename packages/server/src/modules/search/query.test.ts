import { describe, expect, it } from 'vitest'
import {
  buildTsQuery,
  makeSnippet,
  mergeScopes,
  normalizeQuery,
  queryTokens,
  RRF_K,
  rrfFuse,
} from './query.js'

describe('FTS sanitiser (input is the output of spoor_unaccent)', () => {
  it('normalises: trim, 500 chars, NFC, lower-case', () => {
    expect(normalizeQuery('  Příliš ŽLUŤOUČKÝ  ')).toBe('příliš žluťoučký')
    expect(normalizeQuery('é')).toBe('é') // NFC
    expect([...normalizeQuery('a'.repeat(600))].length).toBe(500)
  })
  it('prefix-matches tokens of 3+ chars, keeps short ones bare, ORs them', () => {
    expect(buildTsQuery('session expiry 14 d')).toBe('session:* | expiry:* | 14 | d')
  })
  it('unaccent outputs that would be tsquery syntax become plain separators', () => {
    // ʼ → ', ŉ → 'n, ⑴ → (1), ½ → " 1/2", ː → :, ʺ → " (unaccent.rules), then tokenised
    expect(buildTsQuery("п'ять")).toBe('п | ять:*')
    expect(buildTsQuery("'n")).toBe('n')
    expect(buildTsQuery('(1)')).toBe('1')
    expect(buildTsQuery(' 1/2')).toBe('1 | 2')
    expect(buildTsQuery('a:b')).toBe('a | b')
    expect(buildTsQuery('"quoted"')).toBe('quoted:*')
    expect(buildTsQuery("a & !b | c <-> d:* ' ")).toBe('a | b | c | d')
  })
  it('Czech text after unaccent', () => {
    expect(buildTsQuery('prilis zlutoucky kun')).toBe('prilis:* | zlutoucky:* | kun:*')
  })
  it('output alphabet is only letters, digits, _, :* and |', () => {
    const q = buildTsQuery('weird \' " ( ) : * & ! | <-> \\ text_1 číslo ½')
    expect(q).toMatch(/^[\p{L}\p{N}_]+(:\*)?( \| [\p{L}\p{N}_]+(:\*)?)*$/u)
  })
  it('caps at 16 tokens of 64 chars and dedupes', () => {
    const toks = queryTokens(Array.from({ length: 30 }, (_, i) => `t${i}`).join(' '))
    expect(toks).toHaveLength(16)
    expect(queryTokens('x'.repeat(100))[0]).toHaveLength(64)
    expect(queryTokens('a a a')).toEqual(['a'])
  })
  it('no tokens gives an empty tsquery', () => {
    expect(buildTsQuery('  !!! ')).toBe('')
  })
})

describe('RRF', () => {
  it('k is 60', () => expect(RRF_K).toBe(60))
  it('fuses hand-built rank lists; an item scores with its best chunk', () => {
    const fts = [
      { itemId: 'A', chunkId: 1 },
      { itemId: 'B', chunkId: 2 },
      { itemId: 'C', chunkId: 3 },
    ]
    const vec = [
      { itemId: 'B', chunkId: 2 },
      { itemId: 'A', chunkId: 4 },
    ]
    const out = rrfFuse([fts, vec])
    // B: 1/62 + 1/61; A best of chunk 1 (1/61) and chunk 4 (1/62); C: 1/63
    expect(out.map((h) => h.itemId)).toEqual(['B', 'A', 'C'])
    expect(out[0]?.score).toBeCloseTo(1 / 62 + 1 / 61, 12)
    expect(out[1]).toMatchObject({ chunkId: 1 })
    expect(out[1]?.score).toBeCloseTo(1 / 61, 12)
    expect(out[2]?.score).toBeCloseTo(1 / 63, 12)
  })
  it('one list only keeps its order', () => {
    expect(
      rrfFuse([
        [
          { itemId: 'x', chunkId: 9 },
          { itemId: 'y', chunkId: 8 },
        ],
      ]).map((h) => h.itemId),
    ).toEqual(['x', 'y'])
  })
})

describe('mergeScopes', () => {
  it('merges by score; a tie goes to the project item; cuts to limit', () => {
    const project = [
      { id: 'p1', score: 0.03 },
      { id: 'p2', score: 0.01 },
    ]
    const shared = [
      { id: 's1', score: 0.03 },
      { id: 's2', score: 0.02 },
    ]
    expect(mergeScopes(project, shared, 3).map((h) => h.id)).toEqual(['p1', 's1', 's2'])
  })
})

describe('makeSnippet', () => {
  it('removes the heading prefix line', () => {
    expect(makeSnippet('Title › H1\nShort body.', ['body'])).toBe('Short body.')
  })
  it('cuts 160 chars around the first token hit, accent-insensitively', () => {
    const body = `${'a '.repeat(150)}Používáme session tabulku ${'b '.repeat(150)}`
    const s = makeSnippet(`T\n${body}`, ['pouzivame'])
    expect([...s].length).toBeLessThanOrEqual(160)
    expect(s).toContain('Používáme')
    expect(s.startsWith('…')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
  })
  it('falls back to the first 160 chars', () => {
    const s = makeSnippet(`T\n${'word '.repeat(100)}`, ['zzz'])
    expect([...s].length).toBe(160)
    expect(s.endsWith('…')).toBe(true)
  })
})
