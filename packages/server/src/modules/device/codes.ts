/**
 * Pure helpers of the device flow (auth-and-security.md section 6, api.md section 3): the user code, the
 * client name and the requester IP as they are stored and shown on the approval page.
 */
import { randomInt } from 'node:crypto'
import { cleanLine } from '@spoor/shared'

/** 20 consonants (no vowels, so a code never spells a word; no Y): 20^8 ≈ 2^34.6. */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
export const USER_CODE_LENGTH = 8
const USER_CODE_RE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/

/** A fresh user code, stored normalised (no dash), from a CSPRNG. */
export function generateUserCode(): string {
  let out = ''
  for (let i = 0; i < USER_CODE_LENGTH; i++) out += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]
  return out
}

/** `WDJBMJHT` → `WDJB-MJHT` (how the CLI and the page display it). */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/**
 * What a user typed → the stored form, or `null` when it cannot be a code. Case-insensitive, with or
 * without the dash (spaces are ignored too, people copy them).
 */
export function normalizeUserCode(input: string): string | null {
  if (input.length > 32) return null
  const s = input.toUpperCase().replace(/[\s-]/g, '')
  return USER_CODE_RE.test(s) ? s : null
}

export const CLIENT_NAME_MAX = 64
export const UNKNOWN_CLIENT = 'unknown client'

/**
 * The requester's self-reported client name: control and bidi characters stripped, cut to 64 code points
 * (the column CHECK counts characters; deviations.md X4: truncated, never a 500). Empty → `unknown client`.
 */
export function cleanClientName(raw: string | undefined): string {
  const cut = [...cleanLine(raw ?? '')].slice(0, CLIENT_NAME_MAX).join('').trim()
  return cut === '' ? UNKNOWN_CLIENT : cut
}

const IP_MAX = 45

/**
 * The peer address for display: an IPv4-mapped IPv6 address (`::ffff:203.0.113.7`) is shown as IPv4.
 * Anything that does not look like an IP address is dropped (the column holds at most 45 characters).
 */
export function displayIp(raw: string | undefined | null): string | null {
  if (!raw) return null
  let ip = raw.trim()
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (mapped?.[1]) ip = mapped[1]
  if (ip.length === 0 || ip.length > IP_MAX || !/^[0-9A-Fa-f:.%a-zA-Z]+$/.test(ip)) return null
  if (!ip.includes('.') && !ip.includes(':')) return null
  return ip
}
