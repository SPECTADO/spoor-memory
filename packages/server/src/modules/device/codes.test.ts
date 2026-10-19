import { describe, expect, it } from 'vitest'
import {
  CLIENT_NAME_MAX,
  cleanClientName,
  displayIp,
  formatUserCode,
  generateUserCode,
  normalizeUserCode,
  USER_CODE_ALPHABET,
} from './codes.js'

describe('user codes', () => {
  it('are 8 characters from the 20-consonant alphabet, displayed XXXX-XXXX', () => {
    expect(USER_CODE_ALPHABET).toHaveLength(20)
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      const c = generateUserCode()
      expect(c).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{8}$/)
      for (const ch of c) seen.add(ch)
    }
    expect(seen.size).toBe(20) // every letter is reachable
    expect(formatUserCode('WDJBMJHT')).toBe('WDJB-MJHT')
  })

  it('accept any case, with or without the dash or spaces; refuse anything else', () => {
    for (const s of ['WDJB-MJHT', 'wdjb-mjht', 'WDJBMJHT', 'wdjbmjht', ' wdjb mjht ', 'WdJb-MjHt']) {
      expect(normalizeUserCode(s)).toBe('WDJBMJHT')
    }
    for (const s of [
      '',
      'WDJB-MJH',
      'WDJB-MJHTX',
      'AEIO-UYAE',
      'WDJB_MJHT',
      '12345678',
      'x'.repeat(40),
      'WDJB-MJH%',
    ]) {
      expect(normalizeUserCode(s)).toBeNull()
    }
  })
})

describe('client names', () => {
  it('strip control and bidi characters, cut to 64 code points, never empty', () => {
    expect(cleanClientName('spoor-cli/0.1.0 on laptop')).toBe('spoor-cli/0.1.0 on laptop')
    expect(cleanClientName('a‮b\r\nc\u0000d')).toBe('abcd')
    expect([...cleanClientName('é'.repeat(100))]).toHaveLength(CLIENT_NAME_MAX)
    expect([...cleanClientName('😀'.repeat(100))]).toHaveLength(CLIENT_NAME_MAX)
    expect(cleanClientName('')).toBe('unknown client')
    expect(cleanClientName('‮\n ')).toBe('unknown client')
    expect(cleanClientName(undefined)).toBe('unknown client')
  })
})

describe('displayIp', () => {
  it('shows IPv4-mapped addresses as IPv4 and drops junk', () => {
    expect(displayIp('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(displayIp('203.0.113.7')).toBe('203.0.113.7')
    expect(displayIp('2001:db8::1')).toBe('2001:db8::1')
    expect(displayIp('fe80::1%en0')).toBe('fe80::1%en0')
    expect(displayIp(undefined)).toBeNull()
    expect(displayIp('')).toBeNull()
    expect(displayIp('localhost')).toBeNull()
    expect(displayIp('1.2.3.4 <script>')).toBeNull()
    expect(displayIp(`${'a:'.repeat(30)}1`)).toBeNull()
  })
})
