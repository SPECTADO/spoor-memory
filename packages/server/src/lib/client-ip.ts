/**
 * The client address behind a reverse proxy (deviations.md P3-1, deployment.md section 6
 * `SPOOR_TRUST_PROXY`). Off by default: then the address is the TCP peer and `X-Forwarded-For` is ignored,
 * because anyone can send that header. With a trusted-proxy list, the chain `X-Forwarded-For, peer` is walked
 * from the right and the first hop that is NOT a trusted proxy is the client (the right-most untrusted hop):
 * a client can prepend any addresses it likes, but it cannot change what the trusted proxies appended.
 *
 * Used for the device flow's `requester_ip`, the address the approver sees.
 */
import { BlockList, isIP } from 'node:net'

/** `SPOOR_TRUST_PROXY` keywords. */
const KEYWORDS: Record<string, [string, number][]> = {
  loopback: [
    ['127.0.0.0', 8],
    ['::1', 128],
  ],
  private: [
    ['10.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['fc00::', 7],
  ],
}

/** At most this many forwarded hops are looked at (a longer header is cut from the left). */
const MAX_HOPS = 32

export interface TrustedProxies {
  has(ip: string): boolean
}

const family = (ip: string) => (isIP(ip) === 6 ? 'ipv6' : 'ipv4')

/** `::ffff:a.b.c.d` → `a.b.c.d`; `[v6]:port` and `v4:port` lose the port; anything else not an IP → null. */
export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null
  let ip = raw.trim()
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip)
  if (bracketed?.[1]) ip = bracketed[1]
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'))
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (mapped?.[1]) ip = mapped[1]
  return isIP(ip) === 0 ? null : ip
}

/**
 * Parse `SPOOR_TRUST_PROXY`: unset, empty, `off` or `false` → null (forwarded headers ignored). Otherwise a
 * comma-separated list of the keywords `loopback` and `private`, IP addresses and CIDR ranges, e.g.
 * `private` (Caddy in the compose network) or `10.0.0.5, 192.168.1.0/24`. Throws on an invalid entry.
 */
export function parseTrustProxy(value: string | undefined): TrustedProxies | null {
  const v = (value ?? '').trim()
  if (v === '' || v === 'off' || v === 'false') return null
  const list = new BlockList()
  for (const raw of v.split(',')) {
    const entry = raw.trim()
    if (entry === '') continue
    const keyword = KEYWORDS[entry.toLowerCase()]
    if (keyword) {
      for (const [net, prefix] of keyword) list.addSubnet(net, prefix, family(net))
      continue
    }
    const slash = entry.indexOf('/')
    const addr = slash === -1 ? entry : entry.slice(0, slash)
    const fam = isIP(addr)
    if (fam === 0) throw new Error(`"${entry}" is not loopback, private, an IP address or a CIDR range`)
    if (slash === -1) {
      list.addAddress(addr, family(addr))
      continue
    }
    const bits = entry.slice(slash + 1)
    const prefix = Number(bits)
    if (!/^\d{1,3}$/.test(bits) || prefix > (fam === 4 ? 32 : 128)) {
      throw new Error(`"${entry}" has an invalid prefix length`)
    }
    list.addSubnet(addr, prefix, family(addr))
  }
  return { has: (ip) => list.check(ip, family(ip)) }
}

/**
 * The client address: the TCP peer when nothing is trusted or the peer is not a trusted proxy; otherwise
 * the right-most `X-Forwarded-For` hop that is not a trusted proxy (the left-most hop when every hop is
 * trusted). A hop that is not an IP address ends the walk with `null` (unknown) rather than a guess.
 */
export function clientIp(
  peer: string | null | undefined,
  forwardedFor: string | null | undefined,
  trusted: TrustedProxies | null,
): string | null {
  let addr = normalizeIp(peer)
  if (trusted === null || addr === null || !trusted.has(addr)) return addr
  const hops = (forwardedFor ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '')
    .slice(-MAX_HOPS)
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = normalizeIp(hops[i])
    if (hop === null) return null
    addr = hop
    if (!trusted.has(hop)) return hop
  }
  return addr
}
