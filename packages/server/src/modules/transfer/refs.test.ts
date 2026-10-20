import { describe, expect, it } from 'vitest'
import { RefIndex } from './refs.js'

describe('RefIndex', () => {
  const idx = new RefIndex([
    { id: 'm1', space: 'memories', number: 1, adrNumber: null, slug: 'auth-flow' },
    { id: 'd2', space: 'docs', number: 2, adrNumber: null, slug: 'auth-flow' },
    { id: 'a3', space: 'decisions', number: 3, adrNumber: 7, slug: 'use-postgres' },
  ])
  it('resolves handle forms by number', () => {
    expect(idx.resolveWikilink('m1', 'docs')).toBe('m1')
    expect(idx.resolveWikilink('d2', 'memories')).toBe('d2')
    expect(idx.resolveWikilink('ADR-0007', 'docs')).toBe('a3')
    expect(idx.resolveWikilink('m2', 'docs')).toBeUndefined()
    expect(idx.resolveWikilink('d3', 'docs')).toBeUndefined()
  })
  it('resolves slugs: same space first, then docs, decisions, memories', () => {
    expect(idx.resolveWikilink('Auth Flow', 'memories')).toBe('m1')
    expect(idx.resolveWikilink('auth-flow', 'decisions')).toBe('d2')
    expect(idx.resolveWikilink('use postgres', 'memories')).toBe('a3')
    expect(idx.resolveWikilink('nothing', 'docs')).toBeUndefined()
  })
  it('looks up exact space/slug', () => {
    expect(idx.bySpaceSlug('docs/auth-flow')).toBe('d2')
    expect(idx.bySpaceSlug('docs/use-postgres')).toBeUndefined()
    expect(idx.rowOf('a3')?.slug).toBe('use-postgres')
  })
})

describe('RefIndex with library pages', () => {
  const idx = new RefIndex([
    { id: 'm1', space: 'memories', number: 1, adrNumber: null, slug: 'guide' },
    { id: 'd2', space: 'docs', number: 2, adrNumber: null, slug: 'runbook' },
    { id: 'l3', space: 'library', number: 3, adrNumber: null, slug: 'guide' },
  ])
  it('resolves l3 / L3 to the library page, never m3 or d3', () => {
    expect(idx.resolveWikilink('l3', 'memories')).toBe('l3')
    expect(idx.resolveWikilink('L3', 'docs')).toBe('l3')
    expect(idx.resolveWikilink('l1', 'docs')).toBeUndefined()
    expect(idx.resolveWikilink('m3', 'library')).toBeUndefined()
  })
  it('a library page wins a slug for every source; a library source resolves any space', () => {
    expect(idx.resolveWikilink('guide', 'memories')).toBe('l3')
    expect(idx.resolveWikilink('guide', 'library')).toBe('l3')
    expect(idx.resolveWikilink('runbook', 'library')).toBe('d2')
    expect(idx.resolveWikilink('m1', 'library')).toBe('m1')
    expect(idx.bySpaceSlug('library/guide')).toBe('l3')
  })
})
