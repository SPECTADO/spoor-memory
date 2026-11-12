import { LATEST_VERSION_HEADER } from '@spoor/shared'
import type { Context } from 'hono'
import type { UpdatePort } from '../ports.js'

/**
 * Bearer `context` and `whoami` (cli-and-hooks.md section 5.1 step 9): `Spoor-Latest-Version` when the update check
 * is on and knows a release newer than this server. Reads the cache only; never waits on the network.
 */
export function setLatestVersionHeader(c: Context, updates: UpdatePort): void {
  const u = updates.current()
  if (u?.available) c.header(LATEST_VERSION_HEADER, u.latest)
}
