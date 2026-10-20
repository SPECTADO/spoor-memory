import { describe, expect, it } from 'vitest'
import { spaces } from './frontmatter.js'
import { extractWikilinks, pickRefTarget, refTarget, spaceRank, stripCode } from './wikilinks.js'

describe('extractWikilinks', () => {
  it('canonicalises targets and keeps shared: links apart', () => {
    const links = extractWikilinks(
      'See [[Auth Flow]], [[ADR-0007|the ADR]], [[m42#x]] and [[shared:style-guide]].',
    )
    expect(links.map((l) => l.dstRef)).toEqual(['auth-flow', 'adr-7', 'm42', 'shared:style-guide'])
    expect(links[3]).toMatchObject({ shared: true, ref: 'style-guide' })
  })
  it('ignores links in fenced and inline code, and duplicates', () => {
    const body = '[[a]] `[[b]]` ``x [[c]] x``\n```\n[[d]]\n```\n~~~\n[[e]]\n~~~\n[[a]] [[f]]'
    expect(extractWikilinks(body).map((l) => l.dstRef)).toEqual(['a', 'f'])
  })
  it('handles indented, double-backtick, unclosed and longer fences (phase-2 review C2)', () => {
    for (const body of [
      '  ```\n[[in-code]]\n  ```',
      '``[[in-code]]``',
      '```\n[[in-code]]',
      '````\n```\n[[in-code]]\n````',
    ]) {
      expect(extractWikilinks(body)).toEqual([])
    }
    expect(stripCode('a\n```\nb\n```\nc')).toBe('a\n\n\n\nc')
  })
})

describe('resolution order', () => {
  const c = (
    space: 'memories' | 'decisions' | 'docs' | 'library',
    slug: string,
    number = 1,
    adrNumber: number | null = null,
  ) => ({
    space,
    slug,
    number,
    adrNumber,
  })
  it('handle forms by number, then slug in the own space, docs, decisions, memories', () => {
    const cands = [c('memories', 'x', 4), c('docs', 'x', 2), c('decisions', 'x', 3, 7)]
    expect(pickRefTarget(cands, 'memories', 'x')?.space).toBe('memories')
    expect(pickRefTarget(cands, 'decisions', 'x')?.space).toBe('decisions')
    expect(pickRefTarget([cands[2], cands[0]] as typeof cands, 'docs', 'x')?.space).toBe('decisions')
    expect(pickRefTarget(cands, 'docs', 'adr-7')?.space).toBe('decisions')
    expect(pickRefTarget(cands, 'docs', 'm4')?.space).toBe('memories')
    expect(pickRefTarget(cands, 'docs', 'd2')?.space).toBe('docs')
    expect(pickRefTarget(cands, 'docs', 'm9')).toBeNull()
    // the own space, then docs, decisions, memories (rank 0 belongs to library, see below)
    expect(spaceRank('memories', 'memories')).toBe(1)
    expect(spaceRank('memories', 'docs')).toBe(2)
    expect(spaceRank('memories', 'decisions')).toBe(3)
    expect(spaceRank('docs', 'decisions')).toBeLessThan(spaceRank('docs', 'memories'))
    expect(spaceRank('decisions', 'docs')).toBeLessThan(spaceRank('decisions', 'memories'))
  })

  it('refTarget reads library handles', () => {
    expect(refTarget('l3')).toEqual({ kind: 'library', number: 3 })
    expect(refTarget('lab')).toEqual({ kind: 'slug', slug: 'lab' })
  })

  it('a library page wins a slug over every other space, for every source space', () => {
    for (const src of spaces) {
      expect(spaceRank(src, 'library')).toBe(0)
      const cands = [
        c('docs', 'x', 2),
        c('library', 'x', 5),
        c('memories', 'x', 4),
        c('decisions', 'x', 3, 7),
      ]
      expect(pickRefTarget(cands, src, 'x')?.space, src).toBe('library')
    }
  })

  it('a library source resolves handles and slugs in any space (owner amendment, ADR-0014)', () => {
    const cands = [
      c('docs', 'some-doc', 2),
      c('memories', 'm', 5),
      c('decisions', 'd', 6, 7),
      c('library', 'g', 8),
    ]
    expect(pickRefTarget(cands, 'library', 'some-doc')?.space).toBe('docs')
    expect(pickRefTarget(cands, 'library', 'm5')?.space).toBe('memories')
    expect(pickRefTarget(cands, 'library', 'd2')?.space).toBe('docs')
    expect(pickRefTarget(cands, 'library', 'adr-7')?.space).toBe('decisions')
    expect(pickRefTarget(cands, 'library', 'l8')?.space).toBe('library')
    expect(pickRefTarget(cands, 'library', 'l5')).toBeNull()
    expect(pickRefTarget(cands, 'library', 'missing')).toBeNull()
    // from a library page: docs, decisions, memories after the library
    const twins = [c('memories', 'y', 1), c('decisions', 'y', 2, 1), c('docs', 'y', 3)]
    expect(pickRefTarget(twins, 'library', 'y')?.space).toBe('docs')
    expect(pickRefTarget(twins.slice(0, 2), 'library', 'y')?.space).toBe('decisions')
  })

  it('[[L3]] in a body resolves to the library page', () => {
    const [link] = extractWikilinks('see [[L3]]')
    expect(link?.ref).toBe('l3')
    expect(
      pickRefTarget([c('library', 'guide', 3), c('docs', 'l3', 9)], 'docs', link?.ref ?? '')?.space,
    ).toBe('library')
  })
})
