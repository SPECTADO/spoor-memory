import { describe, expect, it } from 'vitest'
import { isValidProjectSlug, itemSlug, SLUG_MAX, SLUG_RE, slugify, uniqueSlug } from './slug.js'

describe('slugify', () => {
  it('lower-cases, strips diacritics and collapses runs', () => {
    expect(slugify('Použij PostgreSQL!  (ADR)')).toBe('pouzij-postgresql-adr')
  })
  it('returns item for empty results', () => {
    expect(slugify('')).toBe('item')
    expect(slugify('日本語')).toBe('item')
  })
  it('cuts at the last dash boundary within 80 chars', () => {
    const s = slugify(`${'word '.repeat(30)}`)
    expect(s.length).toBeLessThanOrEqual(SLUG_MAX)
    expect(SLUG_RE.test(s)).toBe(true)
    expect(s.endsWith('-')).toBe(false)
  })
  it('hard-cuts a single long token', () => expect(slugify('a'.repeat(200))).toHaveLength(SLUG_MAX))
})

describe('itemSlug', () => {
  it('prefixes shapes that would shadow handles', () => {
    expect(itemSlug('m42')).toBe('x-m42')
    expect(itemSlug('d7')).toBe('x-d7')
    expect(itemSlug('ADR 7')).toBe('x-adr-7')
    expect(itemSlug('3fa85f64-5717-4562-b3fc-2c963f66afa6')).toBe('x-3fa85f64-5717-4562-b3fc-2c963f66afa6')
  })
  it('leaves ordinary slugs alone', () => expect(itemSlug('Session store')).toBe('session-store'))
})

describe('uniqueSlug', () => {
  it('appends -2, -3 on collision', () => {
    expect(uniqueSlug('a', new Set())).toBe('a')
    expect(uniqueSlug('a', new Set(['a']))).toBe('a-2')
    expect(uniqueSlug('a', new Set(['a', 'a-2']))).toBe('a-3')
  })
  it('keeps the 80 char cap', () => {
    const long = 'a'.repeat(SLUG_MAX)
    const u = uniqueSlug(long, new Set([long]))
    expect(u).toHaveLength(SLUG_MAX)
    expect(u.endsWith('-2')).toBe(true)
  })
})

describe('isValidProjectSlug', () => {
  it('accepts normal slugs and rejects reserved or malformed ones', () => {
    expect(isValidProjectSlug('acme')).toBe(true)
    expect(isValidProjectSlug('a')).toBe(true)
    for (const x of ['api', 'login', '-a', 'a-', 'A', '_shared', 'a'.repeat(41)])
      expect(isValidProjectSlug(x), x).toBe(false)
  })
})
