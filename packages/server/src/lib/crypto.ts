/** Random secrets and their stored digests (auth-and-security.md sections 3, 5). */
import { createHash, randomBytes } from 'node:crypto'

/** `prefix` + 32 random bytes, base64url (43 chars). Session ids use no prefix. */
export function randomSecret(prefix = ''): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`
}

/** What the DB stores for every bearer secret (session id, invite, token, device code): sha256 as bytea. */
export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}
