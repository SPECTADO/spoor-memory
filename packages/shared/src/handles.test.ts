import { describe, expect, it } from 'vitest'
import { canonicalRef, formatHandle, parseHandle } from './handles.js'

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
  it('rejects non handles', () => {
    for (const x of [
      '',
      'm',
      'x1',
      'M42',
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
  })
  it('round-trips with parseHandle', () => {
    for (const h of ['m1', 'd99', 'ADR-0012', 'S:m4', 'S:ADR-0003']) {
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
})
