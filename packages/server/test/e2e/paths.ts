import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The built `spoor` entry point (packages/cli/dist/bin.js). */
export const CLI_BIN = resolve(here, '../../../cli/dist/bin.js')

/** `…/spoor_test` → `…/spoor_e2e_test` (still ends in `_test`, so the harness guard accepts it). */
export function e2eDatabaseUrl(base: string): string {
  const u = new URL(base)
  const name = decodeURIComponent(u.pathname.slice(1)).replace(/_test$/, '')
  u.pathname = `/${name}_e2e_test`
  return u.toString()
}
