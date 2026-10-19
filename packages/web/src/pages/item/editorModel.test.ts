import { describe, expect, it } from 'vitest'
import {
  createBody,
  emptyValues,
  isChanged,
  parseAnchors,
  patchBody,
  validate,
  valuesFromItem,
} from './editorModel'
import { itemFixture } from './testFixtures'

describe('editor validation', () => {
  it('requires a one-line title of at most 200 characters', () => {
    expect(validate(emptyValues(), 'memories', 'create').title).toBe('A title is required.')
    expect(validate(emptyValues({ title: '   ' }), 'docs', 'create').title).toBe('A title is required.')
    expect(validate(emptyValues({ title: 'x'.repeat(201) }), 'docs', 'create').title).toMatch(/200/)
    // 200 emoji are 200 code points (400 UTF-16 units): allowed, like the server counts
    expect(validate(emptyValues({ title: '🙂'.repeat(200) }), 'docs', 'create').title).toBeUndefined()
    expect(validate(emptyValues({ title: 'Sessions' }), 'docs', 'create')).toEqual({})
  })

  it('checks tags against the shared tag pattern', () => {
    const e = validate(emptyValues({ title: 't', tags: ['auth', 'Bad Tag'] }), 'memories', 'edit')
    expect(e.tags).toMatch(/"Bad Tag" is not a valid tag/)
    const many = Array.from({ length: 21 }, (_, i) => `t${i}`)
    expect(validate(emptyValues({ title: 't', tags: many }), 'memories', 'edit').tags).toMatch(/At most 20/)
  })

  it('normalises anchors with the shared normaliser and reports the first bad line', () => {
    expect(parseAnchors('./src//auth/\n\n  docs/*.md \nsrc/auth/')).toEqual({
      anchors: ['src/auth/', 'docs/*.md'],
      error: null,
    })
    expect(parseAnchors('src/\n../etc/passwd').error).toMatch(/^Line 2: /)
    expect(parseAnchors('src/***/x').error).toMatch(/three or more consecutive/)
    expect(validate(emptyValues({ title: 't', anchors: 'a/{b,{c}}' }), 'docs', 'create').anchors).toMatch(
      /^Line 1: nested/,
    )
  })

  it('checks slug shape on create only, and decision date and ADR number', () => {
    expect(validate(emptyValues({ title: 't', slug: 'Bad Slug' }), 'docs', 'create').slug).toBeDefined()
    expect(validate(emptyValues({ title: 't', slug: 'Bad Slug' }), 'docs', 'edit').slug).toBeUndefined()
    const d = validate(
      emptyValues({ title: 't', decided_on: '2026-13-45', adr_number: '0' }),
      'decisions',
      'create',
    )
    expect(d.decided_on).toBeDefined()
    expect(d.adr_number).toBeDefined()
  })

  it('rejects a body over 200,000 characters', () => {
    expect(validate(emptyValues({ title: 't', body: 'x'.repeat(200_001) }), 'docs', 'edit').body).toMatch(
      /200,000/,
    )
  })
})

describe('request bodies', () => {
  it('PATCH sends only the changed fields with the base revision', () => {
    const base = valuesFromItem(itemFixture())
    expect(patchBody(base, base, 3, 'memories')).toEqual({ revision: 3 })
    const v = { ...base, title: ' New title ', anchors: './src/auth/\nsrc/db/', confidence: 'high' as const }
    expect(patchBody(v, base, 3, 'memories')).toEqual({
      revision: 3,
      title: 'New title',
      anchors: ['src/auth/', 'src/db/'],
      confidence: 'high',
    })
    // "save my version over r7": same changes, newer revision
    expect(patchBody(v, base, 7, 'memories').revision).toBe(7)
    expect(isChanged(v, base)).toBe(true)
    expect(isChanged({ ...base, tags: [...base.tags] }, base)).toBe(false)
  })

  it('a cleared decision date is sent as null', () => {
    const base = valuesFromItem(
      itemFixture({ space: 'decisions', status: 'proposed', decided_on: '2026-10-01' }),
    )
    expect(patchBody({ ...base, decided_on: '', status: 'accepted' }, base, 2, 'decisions')).toEqual({
      revision: 2,
      decided_on: null,
      status: 'accepted',
    })
  })

  it('create sends space-specific fields only', () => {
    const v = emptyValues({
      title: 'T',
      tags: ['a'],
      anchors: 'src/',
      allow_duplicate: true,
      adr_number: '7',
    })
    expect(createBody(v, 'memories')).toEqual({
      title: 'T',
      body: '',
      tags: ['a'],
      anchors: ['src/'],
      type: 'fact',
      confidence: 'medium',
      allow_duplicate: true,
    })
    expect(createBody(v, 'decisions')).toEqual({
      title: 'T',
      body: '',
      tags: ['a'],
      anchors: ['src/'],
      status: 'proposed',
      adr_number: 7,
    })
  })
})
