import { describe, expect, it } from 'vitest'
import { extractWikilinks, pickRefTarget, spaceRank, stripCode } from './wikilinks.js'

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
    space: 'memories' | 'decisions' | 'docs',
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
    expect(spaceRank('memories', 'docs')).toBe(1)
    expect(spaceRank('memories', 'decisions')).toBe(2)
  })
})
