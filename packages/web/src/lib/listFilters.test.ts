import { describe, expect, it } from 'vitest'
import {
  activeFilterCount,
  DEFAULT_FILTERS,
  normalizeTag,
  parseFilters,
  toApiFilters,
  toSearchParams,
  withoutTag,
  withTag,
} from './listFilters'

const parse = (space: 'memories' | 'decisions' | 'docs', qs: string) =>
  parseFilters(space, new URLSearchParams(qs))

describe('parseFilters', () => {
  it('gives the defaults for an empty URL', () => {
    expect(parse('memories', '')).toEqual(DEFAULT_FILTERS)
  })

  it('reads every filter and drops invalid values', () => {
    const f = parse(
      'memories',
      'type=fact&status=superseded&lifecycle=archived&tag=Auth&tag=bad tag&tag=auth&pinned=1&anchor=%20src/a.ts&sort=verified&dir=asc',
    )
    expect(f).toEqual({
      type: 'fact',
      status: 'superseded',
      lifecycle: 'archived',
      tags: ['auth'],
      pinned: true,
      anchor: 'src/a.ts',
      sort: 'verified',
      dir: 'asc',
    })
    const bad = parse('memories', 'type=nope&status=zzz&lifecycle=x&sort=y&dir=up')
    expect(bad).toEqual(DEFAULT_FILTERS)
  })

  it('ignores the memory type filter in other spaces and checks status per space', () => {
    expect(parse('decisions', 'type=fact&status=accepted')).toMatchObject({ type: '', status: 'accepted' })
    expect(parse('decisions', 'status=active').status).toBe('')
    expect(parse('docs', 'status=active').status).toBe('')
  })

  it('keeps at most five tags', () => {
    expect(parse('docs', 'tag=a&tag=b&tag=c&tag=d&tag=e&tag=f').tags).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})

describe('toSearchParams / toApiFilters', () => {
  it('omits defaults from the URL and round-trips the rest', () => {
    expect(toSearchParams(DEFAULT_FILTERS).toString()).toBe('')
    const f = {
      ...DEFAULT_FILTERS,
      type: 'fact' as const,
      tags: ['a', 'b'],
      pinned: true,
      lifecycle: 'all' as const,
    }
    expect(parseFilters('memories', toSearchParams(f))).toEqual(f)
  })

  it('sends only what is set; the lifecycle default is left to the server', () => {
    expect(toApiFilters(DEFAULT_FILTERS)).toEqual({ sort: 'updated', dir: 'desc' })
    expect(
      toApiFilters({
        ...DEFAULT_FILTERS,
        type: 'procedure',
        lifecycle: 'stale',
        tags: ['x'],
        anchor: 'src/',
      }),
    ).toEqual({
      sort: 'updated',
      dir: 'desc',
      type: ['procedure'],
      lifecycle: ['stale'],
      tag: ['x'],
      anchor: 'src/',
    })
  })
})

describe('tags and counts', () => {
  it('normalises a typed tag', () => {
    expect(normalizeTag(' #Auth/Login ')).toBe('auth/login')
    expect(normalizeTag('two words')).toBeNull()
    expect(normalizeTag('')).toBeNull()
  })

  it('adds a tag once and removes it', () => {
    const a = withTag(DEFAULT_FILTERS, 'Auth')
    expect(a.tags).toEqual(['auth'])
    expect(withTag(a, 'auth')).toBe(a)
    expect(withTag(a, 'not valid')).toBe(a)
    expect(withoutTag(a, 'auth').tags).toEqual([])
  })

  it('counts filters but not sorting', () => {
    expect(activeFilterCount({ ...DEFAULT_FILTERS, sort: 'created', dir: 'asc' })).toBe(0)
    expect(activeFilterCount({ ...DEFAULT_FILTERS, type: 'fact', tags: ['a', 'b'], pinned: true })).toBe(4)
  })
})
