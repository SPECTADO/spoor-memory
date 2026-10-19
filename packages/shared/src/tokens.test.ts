import { describe, expect, it } from 'vitest'
import { estimateTokens } from './tokens.js'

describe('estimateTokens', () => {
  it('is zero for the empty string', () => expect(estimateTokens('')).toBe(0))
  it('counts ASCII at 1/2.2 (calibrated to Claude, review-log-phase5 A2) and rounds up', () => {
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('a'.repeat(22))).toBe(10)
    expect(estimateTokens('a'.repeat(23))).toBe(11)
  })
  it('never undercounts the measured Claude samples', () => {
    // digest sample 4,980 chars = 2,204 Claude tokens; writer tools/list 7,497 chars = 3,307 Claude tokens
    expect(estimateTokens('x'.repeat(4980))).toBeGreaterThanOrEqual(2204)
    expect(estimateTokens('x'.repeat(7497))).toBeGreaterThanOrEqual(3307)
  })
  it('treats Czech diacritics as Latin', () => expect(estimateTokens('ěščř'.repeat(11))).toBe(20))
  it('weights Cyrillic/CJK at 1/1.5', () => expect(estimateTokens('日本語')).toBe(2))
  it('weights astral code points (one emoji) as 2', () => {
    expect(estimateTokens('😀')).toBe(2)
    expect(estimateTokens('😀😀')).toBe(4)
  })
  it('is subadditive', () => {
    const parts = ['hello', 'wörld ', '日本', '😀 x', 'abc']
    for (const a of parts)
      for (const b of parts) {
        expect(estimateTokens(a + b)).toBeLessThanOrEqual(estimateTokens(a) + estimateTokens(b))
      }
  })
})
