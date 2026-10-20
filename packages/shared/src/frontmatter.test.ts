import { describe, expect, it } from 'vitest'
import { extrasOf, frontmatterSchemas, knownKeys, spaces } from './frontmatter.js'
import { projectSettings } from './settings.js'

describe('frontmatter schemas', () => {
  it('applies memory defaults and keeps unknown keys', () => {
    const r = frontmatterSchemas.memories.parse({ type: 'fact', extra: 1 })
    expect(r.confidence).toBe('medium')
    expect(r.tags).toEqual([])
    expect(r.pinned).toBe(false)
    expect((r as Record<string, unknown>).extra).toBe(1)
  })
  it('requires memory type', () => expect(frontmatterSchemas.memories.safeParse({}).success).toBe(false))
  it('validates tags and ADR fields', () => {
    expect(frontmatterSchemas.docs.safeParse({ tags: ['Bad Tag'] }).success).toBe(false)
    expect(
      frontmatterSchemas.decisions.safeParse({ adr: 7, status: 'accepted', date: '2026-10-19' }).success,
    ).toBe(true)
    expect(frontmatterSchemas.decisions.safeParse({ adr: 0 }).success).toBe(false)
  })
  it('library: the doc shape, unknown keys kept, status known', () => {
    expect(spaces).toContain('library')
    const r = frontmatterSchemas.library.parse({
      title: 'Graphics guide',
      anchors: ['packages/web/**'],
      x: 1,
    })
    expect(r.tags).toEqual([])
    expect(r.pinned).toBe(false)
    expect(r.anchors).toEqual(['packages/web/**'])
    expect((r as Record<string, unknown>).x).toBe(1)
    expect(frontmatterSchemas.library.safeParse({ tags: ['Bad Tag'] }).success).toBe(false)
    expect(knownKeys('library').has('status')).toBe(true)
    expect(knownKeys('library').has('type')).toBe(false)
    expect(extrasOf('library', { status: 'active', title: 't', foo: 2 })).toEqual({ foo: 2 })
  })
})

describe('projectSettings', () => {
  it('fills defaults and rejects unknown keys', () => {
    expect(projectSettings.parse({}).digest.default_budget).toBe(1500)
    expect(projectSettings.safeParse({ nope: 1 }).success).toBe(false)
    expect(projectSettings.safeParse({ dedupe: { threshold: 0.5 } }).success).toBe(false)
  })
})
