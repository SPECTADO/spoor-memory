import { describe, expect, it } from 'vitest'
import { extrasOf, knownKeys } from './frontmatter.js'
import { FrontmatterError, serializeMarkdown, splitFrontmatter } from './markdown.js'

describe('splitFrontmatter', () => {
  it('splits frontmatter and keeps the body byte for byte', () => {
    const src = '---\ntitle: Hello\ntags: [a, b]\nlast_verified: 2026-10-19\n---\n# H\n\nbody\n'
    const p = splitFrontmatter(src)
    expect(p.hasFrontmatter).toBe(true)
    // core schema: dates stay strings
    expect(p.data).toEqual({ title: 'Hello', tags: ['a', 'b'], last_verified: '2026-10-19' })
    expect(p.body).toBe('# H\n\nbody\n')
  })
  it('handles BOM, CRLF, trailing blanks on the fence, empty frontmatter and no frontmatter', () => {
    expect(splitFrontmatter('﻿---\r\ntitle: X\r\n---\r\nbody').data).toEqual({ title: 'X' })
    expect(splitFrontmatter('--- \ntitle: X\n---\nbody\n')).toEqual({
      data: { title: 'X' },
      body: 'body\n',
      hasFrontmatter: true,
    })
    expect(splitFrontmatter('---\n---\nbody')).toEqual({ data: {}, body: 'body', hasFrontmatter: true })
    expect(splitFrontmatter('# just text\n')).toEqual({
      data: {},
      body: '# just text\n',
      hasFrontmatter: false,
    })
  })
  it('rejects non-mappings, duplicate keys, broken YAML, alias bombs and frontmatter over 16 KB', () => {
    expect(() => splitFrontmatter('---\n- a\n- b\n---\n')).toThrow(FrontmatterError)
    expect(() => splitFrontmatter('---\na: 1\na: 2\n---\n')).toThrow(FrontmatterError)
    expect(() => splitFrontmatter('---\na: [1\n---\n')).toThrow(FrontmatterError)
    expect(() => splitFrontmatter(`---\nk: ${'x'.repeat(17_000)}\n---\n`)).toThrow(FrontmatterError)
    const lines = ['a: &a [x, x]']
    for (let i = 0; i < 30; i++) lines.push(`b${i}: &b${i} [*a, *a]`)
    expect(() => splitFrontmatter(`---\n${lines.join('\n')}\n---\n`)).toThrow(FrontmatterError)
  })
  it('round-trips through serializeMarkdown; empty frontmatter is ---\\n---', () => {
    const fm = { spoor_id: 'x', title: 'T: colon', tags: ['a'], date: '2026-10-19' }
    const text = serializeMarkdown(fm, 'body\n')
    expect(splitFrontmatter(text)).toEqual({ data: fm, body: 'body\n', hasFrontmatter: true })
    expect(serializeMarkdown({}, 'B')).toBe('---\n---\nB')
  })
})

describe('known keys', () => {
  it('extras are the unknown keys; deciders stays an extra; status is known in every space', () => {
    expect(extrasOf('decisions', { adr: 1, title: 't', deciders: ['ann'], owner: 'x' })).toEqual({
      deciders: ['ann'],
      owner: 'x',
    })
    // docs `status` is output only (export writes it), never an extra (phase-2 review C1)
    expect(extrasOf('docs', { status: 'superseded', owner: 'x' })).toEqual({ owner: 'x' })
    for (const space of ['memories', 'decisions', 'docs'] as const)
      expect(knownKeys(space).has('status')).toBe(true)
  })
})
