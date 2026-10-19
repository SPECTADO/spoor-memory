import { describe, expect, it } from 'vitest'
import { clientIp, normalizeIp, parseTrustProxy } from './client-ip.js'

describe('normalizeIp', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    [' 2001:db8::1 ', '2001:db8::1'],
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['203.0.113.7:51234', '203.0.113.7'],
    ['unknown', null],
    ['', null],
    [undefined, null],
  ])('%s → %s', (raw, out) => {
    expect(normalizeIp(raw)).toBe(out)
  })
})

describe('parseTrustProxy', () => {
  it('is off when unset, empty, off or false', () => {
    for (const v of [undefined, '', ' ', 'off', 'false']) expect(parseTrustProxy(v)).toBeNull()
  })
  it('takes keywords, addresses and CIDR ranges', () => {
    const t = parseTrustProxy('private, 198.51.100.9, 2001:db8::/32') as NonNullable<
      ReturnType<typeof parseTrustProxy>
    >
    expect(t.has('172.18.0.3')).toBe(true)
    expect(t.has('10.1.2.3')).toBe(true)
    expect(t.has('198.51.100.9')).toBe(true)
    expect(t.has('198.51.100.10')).toBe(false)
    expect(t.has('2001:db8:1::5')).toBe(true)
    expect(t.has('127.0.0.1')).toBe(false)
    expect(parseTrustProxy('loopback')?.has('::1')).toBe(true)
  })
  it.each(['yes', '10.0.0.0/33', '10.0.0.0/x', '::/129', 'example.com'])('refuses %s', (v) => {
    expect(() => parseTrustProxy(v)).toThrow()
  })
})

describe('clientIp', () => {
  const trusted = parseTrustProxy('private')
  it('without trust: the peer, forwarded headers ignored', () => {
    expect(clientIp('::ffff:10.0.0.2', '203.0.113.7', null)).toBe('10.0.0.2')
  })
  it('an untrusted peer: the peer, even with a forwarded header', () => {
    expect(clientIp('198.51.100.1', '203.0.113.7', trusted)).toBe('198.51.100.1')
  })
  it('a trusted peer: the right-most untrusted hop; spoofed hops to its left are ignored', () => {
    expect(clientIp('172.18.0.3', '203.0.113.7', trusted)).toBe('203.0.113.7')
    expect(clientIp('172.18.0.3', '1.2.3.4, 203.0.113.7', trusted)).toBe('203.0.113.7')
    expect(clientIp('172.18.0.3', '1.2.3.4, 203.0.113.7, 10.0.0.9', trusted)).toBe('203.0.113.7')
  })
  it('every hop trusted: the left-most; no header: the peer', () => {
    expect(clientIp('172.18.0.3', '10.0.0.8, 10.0.0.9', trusted)).toBe('10.0.0.8')
    expect(clientIp('172.18.0.3', undefined, trusted)).toBe('172.18.0.3')
  })
  it('a hop that is not an address: unknown', () => {
    expect(clientIp('172.18.0.3', '203.0.113.7, garbage', trusted)).toBeNull()
  })
})
