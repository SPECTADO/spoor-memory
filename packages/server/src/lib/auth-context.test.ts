import { describe, expect, it } from 'vitest'
import { actorLabel, capRole, effectiveRole, roleAtLeast } from './auth-context.js'

describe('auth context helpers', () => {
  it('instance admins are project admins everywhere', () => {
    expect(effectiveRole(true, null)).toBe('admin')
    expect(effectiveRole(true, 'viewer')).toBe('admin')
    expect(effectiveRole(false, 'editor')).toBe('editor')
    expect(effectiveRole(false, null)).toBeNull()
  })

  it('a token cap only lowers the role', () => {
    expect(capRole('admin', 'viewer')).toBe('viewer')
    expect(capRole('viewer', 'editor')).toBe('viewer')
    expect(capRole('editor', null)).toBe('editor')
    expect(capRole(null, 'editor')).toBeNull()
  })

  it('compares roles', () => {
    expect(roleAtLeast('admin', 'editor')).toBe(true)
    expect(roleAtLeast('viewer', 'editor')).toBe(false)
    expect(roleAtLeast(null, 'viewer')).toBe(false)
  })

  it('labels actors', () => {
    const user = { id: 'u', email: 'ann@example.com', name: 'Ann', isAdmin: false, sharedEditor: false }
    expect(actorLabel({ user })).toBe('ann@example.com')
    expect(actorLabel({ user: null, tokenName: 'ci' })).toBe('service:ci')
    expect(actorLabel(null)).toBe('system')
  })
})
