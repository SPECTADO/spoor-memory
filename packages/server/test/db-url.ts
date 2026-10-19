/**
 * The test database: DATABASE_URL when set (CI), else the container of `pnpm test:db:up` (port 55432).
 * The harness TRUNCATES every table, so it refuses a database whose name does not end in `_test`
 * unless SPOOR_TEST_ALLOW_ANY_DB=1.
 */
export const DEFAULT_TEST_DATABASE_URL = 'postgres://spoor:spoor@localhost:55432/spoor_test'

export function testDatabaseUrl(): string {
  return process.env.DATABASE_URL || DEFAULT_TEST_DATABASE_URL
}

export function assertTestDatabase(url: string): void {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
  if (!name.endsWith('_test') && process.env.SPOOR_TEST_ALLOW_ANY_DB !== '1') {
    throw new Error(
      `refusing to run integration tests against database "${name}": the harness truncates every table. ` +
        'Use a database whose name ends in "_test" or set SPOOR_TEST_ALLOW_ANY_DB=1.',
    )
  }
}

/** The URL without its password, for messages. */
export function redactUrl(url: string): string {
  const u = new URL(url)
  if (u.password) u.password = '***'
  return u.toString()
}
