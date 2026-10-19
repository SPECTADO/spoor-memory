import { describe, expect, it } from 'vitest'
import {
  descriptionSchema,
  looksLikeToken,
  projectCreateRequest,
  projectPatchRequest,
  projectSlugSchema,
  tokenCreateRequest,
} from './projects.js'

describe('project request schemas', () => {
  it('enforces the project slug rules', () => {
    for (const ok of ['acme', 'a', 'a-b', 'x1', 'a'.repeat(40)])
      expect(projectSlugSchema.safeParse(ok).success).toBe(true)
    for (const bad of ['', 'Acme', '-a', 'a-', '_shared', 'api', 'shared', 'a_b', 'a'.repeat(41)])
      expect(projectSlugSchema.safeParse(bad).success, bad).toBe(false)
  })

  it('create: defaults, strict fields', () => {
    expect(projectCreateRequest.parse({ slug: 'acme', name: ' Acme ' })).toEqual({
      slug: 'acme',
      name: 'Acme',
      description: '',
    })
    expect(projectCreateRequest.safeParse({ slug: 'acme', name: 'A', kind: 'shared' }).success).toBe(false)
  })

  it('patch: the slug is immutable (unknown field)', () => {
    expect(projectPatchRequest.safeParse({ slug: 'other' }).success).toBe(false)
    expect(projectPatchRequest.parse({ settings: { dedupe: { threshold: 0.85 } } })).toEqual({
      settings: { dedupe: { threshold: 0.85 } },
    })
  })

  it('description keeps newlines and drops other control characters', () => {
    expect(descriptionSchema.parse('a\nb\u0007‮')).toBe('a\nb')
    expect(descriptionSchema.safeParse('x'.repeat(2001)).success).toBe(false)
  })
})

describe('token schemas', () => {
  it('service tokens need a role; user tokens may cap', () => {
    expect(tokenCreateRequest.safeParse({ kind: 'service', name: 'ci' }).success).toBe(false)
    expect(tokenCreateRequest.safeParse({ kind: 'service', name: 'ci', role: 'admin' }).success).toBe(false)
    expect(tokenCreateRequest.parse({ kind: 'user', name: 'laptop' })).toEqual({
      kind: 'user',
      name: 'laptop',
    })
    expect(
      tokenCreateRequest.safeParse({ kind: 'user', name: 'x', expires_at: '2030-01-01T00:00:00Z' }).success,
    ).toBe(true)
    expect(tokenCreateRequest.safeParse({ kind: 'user', name: 'x', expires_at: 'tomorrow' }).success).toBe(
      false,
    )
  })

  it('recognises the token shapes', () => {
    expect(looksLikeToken(`spr_${'A'.repeat(43)}`)).toBe(true)
    expect(looksLikeToken(`sprs_${'a_-'.repeat(14)}a`)).toBe(true)
    expect(looksLikeToken(`spr_${'A'.repeat(42)}`)).toBe(false)
    expect(looksLikeToken(`spi_${'A'.repeat(43)}`)).toBe(false)
  })
})
