import { describe, expect, it } from 'vitest'
import { spaces } from './frontmatter.js'
import {
  canonicalRef,
  formatHandle,
  HANDLE_KIND_SPACE,
  parseHandle,
  refHandle,
  SPACE_HANDLE_KIND,
} from './handles.js'

describe('parseHandle', () => {
  it('parses memory, doc and decision handles', () => {
    expect(parseHandle('m42')).toEqual({ kind: 'memory', number: 42, shared: false })
    expect(parseHandle('d7')).toEqual({ kind: 'doc', number: 7, shared: false })
    expect(parseHandle('ADR-0007')).toEqual({ kind: 'decision', number: 7, shared: false })
    expect(parseHandle('adr-12')).toEqual({ kind: 'decision', number: 12, shared: false })
  })
  it('parses the S: shared prefix', () => {
    expect(parseHandle('S:m4')).toEqual({ kind: 'memory', number: 4, shared: true })
    expect(parseHandle('S:ADR-0003')).toEqual({ kind: 'decision', number: 3, shared: true })
  })
  it('parses library handles in either case', () => {
    expect(parseHandle('L3')).toEqual({ kind: 'library', number: 3, shared: false })
    expect(parseHandle('l3')).toEqual({ kind: 'library', number: 3, shared: false })
    expect(parseHandle('S:L3')).toEqual({ kind: 'library', number: 3, shared: true })
    expect(parseHandle('S:l3')).toEqual({ kind: 'library', number: 3, shared: true })
  })
  it('rejects non handles', () => {
    for (const x of [
      '',
      'm',
      'x1',
      'M42',
      'M3',
      'D3',
      's:L3',
      'L',
      'L3x',
      'lab',
      'm4x',
      'use-postgres',
      's:m4',
      'ADR-',
      '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    ])
      expect(parseHandle(x), x).toBeNull()
  })
})

describe('formatHandle', () => {
  it('formats each kind', () => {
    expect(formatHandle('memory', 42)).toBe('m42')
    expect(formatHandle('doc', 7)).toBe('d7')
    expect(formatHandle('decision', 7)).toBe('ADR-0007')
    expect(formatHandle('decision', 12345)).toBe('ADR-12345')
    expect(formatHandle('doc', 2, true)).toBe('S:d2')
    expect(formatHandle('library', 3)).toBe('L3')
    expect(formatHandle('library', 3, true)).toBe('S:L3')
  })
  it('round-trips with parseHandle', () => {
    for (const h of ['m1', 'd99', 'ADR-0012', 'S:m4', 'S:ADR-0003', 'L3', 'S:L12']) {
      const p = parseHandle(h)
      expect(p && formatHandle(p.kind, p.number, p.shared)).toBe(h)
    }
  })
})

describe('canonicalRef', () => {
  it('unpads ADR refs', () => {
    for (const x of ['ADR-0007', 'adr-7', 'ADR-07']) expect(canonicalRef(x)).toBe('adr-7')
  })
  it('keeps m/d handles and slugifies the rest', () => {
    expect(canonicalRef('m42')).toBe('m42')
    expect(canonicalRef('d7')).toBe('d7')
    expect(canonicalRef('Session Store')).toBe('session-store')
  })
  it('lower-cases library handles', () => {
    expect(canonicalRef('L3')).toBe('l3')
    expect(canonicalRef('l3')).toBe('l3')
  })
})

describe('space and handle tables', () => {
  it('refHandle gives the canonical lower form for every space', () => {
    expect(refHandle('memories', 42, null)).toBe('m42')
    expect(refHandle('docs', 7, null)).toBe('d7')
    expect(refHandle('library', 3, null)).toBe('l3')
    expect(refHandle('decisions', 12, 7)).toBe('adr-7')
  })
  it('the two tables are inverse and cover every space', () => {
    for (const s of spaces) expect(HANDLE_KIND_SPACE[SPACE_HANDLE_KIND[s]]).toBe(s)
    expect(Object.keys(HANDLE_KIND_SPACE)).toHaveLength(spaces.length)
  })
  it('refHandle matches canonicalRef of the formatted handle', () => {
    // number 5 is the item number for m/d/L and the ADR number for decisions
    for (const s of spaces) {
      expect(canonicalRef(formatHandle(SPACE_HANDLE_KIND[s], 5))).toBe(
        refHandle(s, 5, s === 'decisions' ? 5 : null),
      )
    }
  })
})
