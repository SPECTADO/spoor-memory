import { describe, expect, it } from 'vitest'
import { isFiltered, parseGraphState, toGraphParams, toGraphSearchParams, toggle } from './graphState'

const parse = (qs: string) => parseGraphState(new URLSearchParams(qs))

describe('graph URL state', () => {
  it('fills the defaults and sends nothing for them', () => {
    const s = parse('')
    expect(s).toMatchObject({
      spaces: ['memories', 'decisions', 'docs', 'library'],
      lifecycle: ['active', 'stale'],
      superseded: false,
      unlinked: false,
      q: '',
      focus: '',
      depth: 2,
      view: 'map',
    })
    expect(s.kinds).toHaveLength(7)
    expect(toGraphParams(s)).toEqual({})
    expect(toGraphSearchParams(s).toString()).toBe('')
    expect(isFiltered(s)).toBe(false)
  })

  it('round-trips the filters and keeps canonical order', () => {
    const s = parse(
      'spaces=docs,memories,bogus&kinds=wikilink,refines&lifecycle=archived&superseded=1&unlinked=1&q=auth&focus=m12&depth=1&view=list',
    )
    expect(s.spaces).toEqual(['memories', 'docs'])
    expect(s.kinds).toEqual(['refines', 'wikilink'])
    expect(toGraphParams(s)).toEqual({
      spaces: ['memories', 'docs'],
      kinds: ['refines', 'wikilink'],
      lifecycle: ['archived'],
      include_superseded: true,
      focus: 'm12',
      depth: 1,
    })
    expect(toGraphSearchParams(s).toString()).toBe(
      'spaces=memories%2Cdocs&kinds=refines%2Cwikilink&lifecycle=archived&superseded=1&unlinked=1&q=auth&focus=m12&depth=1&view=list',
    )
    expect(isFiltered(s)).toBe(true)
  })

  it('sends depth 2 with a focus but leaves it out of the URL; drops depth without focus', () => {
    const s = parse('focus=m12')
    expect(toGraphParams(s)).toEqual({ focus: 'm12', depth: 2 })
    expect(toGraphSearchParams(s).toString()).toBe('focus=m12')
    expect(toGraphSearchParams(parse('depth=1')).toString()).toBe('')
    expect(isFiltered(s)).toBe(false)
  })

  it('sends unlinked only to the server for the whole project, never with a focus (a 400)', () => {
    const s = parse('unlinked=1')
    expect(toGraphParams(s)).toEqual({ unlinked: true })
    expect(isFiltered(s)).toBe(true)
    const focused = parse('unlinked=1&focus=m12')
    expect(toGraphParams(focused)).toEqual({ focus: 'm12', depth: 2 })
    expect(isFiltered(focused)).toBe(false)
  })

  it('an empty or unknown list falls back to the default', () => {
    expect(parse('spaces=').spaces).toHaveLength(4)
    expect(parse('lifecycle=nope').lifecycle).toEqual(['active', 'stale'])
  })

  it('toggle keeps order and never empties the list', () => {
    const all = ['a', 'b', 'c'] as const
    expect(toggle(['a', 'c'], 'b', all)).toEqual(['a', 'b', 'c'])
    expect(toggle(['a', 'b'], 'a', all)).toEqual(['b'])
    expect(toggle(['b'], 'b', all)).toEqual(['b'])
  })
})
