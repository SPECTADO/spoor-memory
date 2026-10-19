import { describe, expect, it } from 'vitest'
import { emailSchema, inviteCreateRequest, nameSchema, passwordSchema } from './auth.js'

describe('auth request schemas', () => {
  it('normalises passwords with NFKC before the length check', () => {
    // U+FB01 (fi ligature) is one code unit and becomes two under NFKC
    expect(passwordSchema.parse('ﬁ'.repeat(6))).toBe('fi'.repeat(6))
    expect(passwordSchema.safeParse('short').success).toBe(false)
    expect(passwordSchema.safeParse('x'.repeat(257)).success).toBe(false)
  })

  it('lower-cases and trims emails', () => {
    expect(emailSchema.parse('  Ann@Example.COM ')).toBe('ann@example.com')
    expect(emailSchema.safeParse('nope').success).toBe(false)
  })

  it('strips control and bidi characters from names', () => {
    expect(nameSchema.parse(' Ann‮ \n')).toBe('Ann')
    expect(nameSchema.safeParse('‎‏').success).toBe(false)
  })

  it('rejects unknown invite fields and applies defaults', () => {
    expect(inviteCreateRequest.safeParse({ grants: [], extra: 1 }).success).toBe(false)
    expect(inviteCreateRequest.parse({})).toMatchObject({
      grants: [],
      is_admin: false,
      reset_revoke_tokens: true,
      expires_in_hours: 168,
    })
  })
})
