// Canonical Markdown files: render, split, hash (data-model.md sections 5 and 8).

import { extrasOf, serializeMarkdown as renderMarkdown, splitFrontmatter } from '@spoor/shared'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/errors.js'
import { canonicalFrontmatter, sameContent } from '../items/index.js'
import { sha256Hex, readMarkdown as splitMarkdown } from './canonical.js'
import { contentFrom, exportFrontmatter } from './content.js'

describe('serializeMarkdown / readMarkdown', () => {
  const fm = {
    spoor_id: '5b1f6f5e-4b1e-4f46-9d57-0f6a2c2f7c11',
    title: 'Use: Postgres "quoted" # not a comment',
    tags: ['auth', 'a/b'],
    anchors: [],
    pinned: false,
    last_verified: '2026-10-19T12:00:00.000Z',
    relations: [{ kind: 'refines', to: 'shared:docs/style-guide' }],
    notes: 'line one\nline two',
    yes: 'yes',
    num: '42',
    nul: 'null',
    date: '2026-10-19',
  }

  it('round-trips frontmatter and body exactly, including tricky strings', () => {
    for (const body of [
      '',
      'plain',
      '\nstarts with a newline',
      'has\n---\nrule inside\n',
      'crlf\r\nbody\r\n',
      'ünïcödé ✓ 日本語\n',
    ]) {
      const text = renderMarkdown(fm, body)
      const out = splitMarkdown(text, 'x.md')
      expect(out.fm).toEqual(fm)
      expect(out.body).toBe(body)
      expect(renderMarkdown(out.fm, out.body)).toBe(text)
    }
  })

  it('keeps dates as strings (core schema)', () => {
    expect(splitMarkdown('---\ndate: 2026-10-19\n---\nx', 'x.md').fm.date).toBe('2026-10-19')
  })

  it('treats a file without frontmatter as all body and accepts BOM and empty frontmatter', () => {
    expect(splitMarkdown('# Title\ntext', 'x.md')).toEqual({ fm: {}, body: '# Title\ntext' })
    expect(splitMarkdown('﻿---\na: 1\n---\nb', 'x.md')).toEqual({ fm: { a: 1 }, body: 'b' })
    expect(splitMarkdown('---\n---\nbody', 'x.md')).toEqual({ fm: {}, body: 'body' })
  })

  it('rejects oversized, malformed and non-mapping frontmatter', () => {
    const code = (fn: () => unknown) => {
      try {
        fn()
        return 'ok'
      } catch (e) {
        return e instanceof ApiError ? e.code : 'other'
      }
    }
    expect(code(() => splitMarkdown(`---\nk: ${'x'.repeat(17_000)}\n---\n`, 'x.md'))).toBe('invalid_archive')
    expect(code(() => splitMarkdown('---\n: : [\n---\n', 'x.md'))).toBe('invalid_archive')
    expect(code(() => splitMarkdown('---\n- a\n- b\n---\n', 'x.md'))).toBe('invalid_archive')
  })

  it('refuses a YAML alias bomb', () => {
    const lines = ['a: &a [x, x, x, x]']
    for (let i = 0; i < 30; i++) lines.push(`k${i}: *a`)
    expect(() => splitMarkdown(`---\n${lines.join('\n')}\n---\n`, 'x.md')).toThrow(ApiError)
  })

  it('sha256Hex is over the exact bytes', () => {
    const a = renderMarkdown(fm, 'body')
    expect(sha256Hex(a)).toBe(sha256Hex(new TextEncoder().encode(a)))
    expect(sha256Hex(a)).not.toBe(sha256Hex(`${a} `))
    expect(sha256Hex(a)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('contentFrom', () => {
  const base = { path: 'memories/a.md', body: 'b', defaultStatus: 'active' }
  it('splits columns from extras and validates', () => {
    const c = contentFrom(
      'memories',
      { title: 'T', type: 'fact', tags: ['a'], pinned: true, deciders: ['x'], custom: { k: 1 } },
      base,
    )
    expect(c).toMatchObject({
      title: 'T',
      type: 'fact',
      confidence: 'medium',
      status: 'active',
      tags: ['a'],
      extras: { deciders: ['x'], custom: { k: 1 } },
    })
    expect(() => contentFrom('memories', { title: 'T' }, base)).toThrow(ApiError)
    expect(() => contentFrom('memories', { title: 'T', type: 'fact', tags: ['Bad Tag'] }, base)).toThrow(
      ApiError,
    )
    expect(() =>
      contentFrom('decisions', { title: 'T', status: 'active' }, { ...base, defaultStatus: 'accepted' }),
    ).toThrow(ApiError)
    expect(() => contentFrom('docs', {}, base)).toThrow(/title/)
  })

  it('strips control characters from the title', () => {
    expect(contentFrom('docs', { title: 'a‮b\nc' }, base).title).toBe('abc')
  })

  it('uses the item cleaners: code-point titles, normalised anchors, deduped tags (review C3)', () => {
    expect(contentFrom('docs', { title: '😀'.repeat(150) }, base).title).toHaveLength(300) // 150 code points
    const c = contentFrom('docs', { title: 'T', anchors: ['./src/a.ts'], tags: ['a', 'a'] }, base)
    expect(c.anchors).toEqual(['src/a.ts'])
    expect(c.tags).toEqual(['a'])
    for (const anchors of [['../etc/passwd'], ['src/{a,b}/{c,d}/{e,f}.ts']]) {
      expect(() => contentFrom('docs', { title: 'T', anchors }, base)).toThrow(ApiError)
    }
  })

  it('docs status is a known key, never an extra (review C1)', () => {
    const fm = { title: 'Old guide', status: 'superseded' }
    expect(extrasOf('docs', fm)).toEqual({})
    const out = exportFrontmatter({
      id: 'i',
      space: 'docs',
      title: 'Old guide',
      tags: [],
      anchors: [],
      pinned: false,
      lastVerifiedAt: new Date(0),
      type: null,
      confidence: null,
      status: 'active',
      expiresAt: null,
      adrNumber: null,
      decidedOn: null,
      // an extra stored before the fix must not override the column on export
      extras: { status: 'superseded', owner: 'x' },
      relations: [],
      supersedes: null,
      supersededBy: null,
      draftedFrom: [],
    })
    expect(out.status).toBeUndefined()
    expect(out.owner).toBe('x')
    expect(splitFrontmatter('---\nstatus: superseded\n---\nB').data.status).toBe('superseded')
  })

  it('revision snapshots and equality are the item module’s (status in the snapshot, date counts; review C6)', () => {
    const c = contentFrom(
      'decisions',
      { title: 'T', status: 'accepted' },
      { ...base, defaultStatus: 'accepted' },
    )
    const snap = canonicalFrontmatter({
      ...c,
      id: 'i',
      space: 'decisions',
      adrNumber: 7,
      decidedOn: '2026-01-01',
    })
    expect(snap).toMatchObject({ adr: 7, status: 'accepted', date: '2026-01-01' })
    expect(sameContent({ ...c, decidedOn: '2026-01-01' }, { ...c, decidedOn: '2026-02-02' })).toBe(false)
    const a = contentFrom('docs', { title: 'T', x: 1, y: 2 }, base)
    const b = contentFrom('docs', { title: 'T', y: 2, x: 1 }, base)
    expect(sameContent({ ...a, decidedOn: null }, { ...b, decidedOn: null })).toBe(true)
  })
})

describe('exportFrontmatter', () => {
  it('uses the canonical key order and puts extras last, sorted', () => {
    const fm = exportFrontmatter({
      id: 'i',
      space: 'decisions',
      title: 'T',
      tags: [],
      anchors: [],
      pinned: true,
      lastVerifiedAt: new Date('2026-01-01T00:00:00Z'),
      type: null,
      confidence: null,
      status: 'accepted',
      expiresAt: null,
      adrNumber: 7,
      decidedOn: '2026-01-02',
      extras: { zeta: 1, alpha: 2, deciders: ['a'] },
      relations: [],
      supersedes: 'old',
      supersededBy: null,
      draftedFrom: ['m1'],
    })
    expect(Object.keys(fm)).toEqual([
      'spoor_id',
      'title',
      'tags',
      'anchors',
      'pinned',
      'last_verified',
      'relations',
      'supersedes',
      'adr',
      'status',
      'date',
      'drafted_from',
      'alpha',
      'deciders',
      'zeta',
    ])
  })
})
