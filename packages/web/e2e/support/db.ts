/**
 * Direct SQL against the e2e database, for state a test cannot reach through the UI in reasonable time
 * (e.g. an item unverified for 40 days). `pg` comes from the server package; the web package does not
 * depend on it.
 */
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { E2E_DATABASE_URL } from './env'

interface PgClient {
  connect(): Promise<void>
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>
  end(): Promise<void>
}
type Pg = { Client: new (o: { connectionString: string }) => PgClient }

const serverPkg = resolve(dirname(fileURLToPath(import.meta.url)), '../../../server/package.json')
const pg = createRequire(serverPkg)('pg') as Pg

export async function sql(text: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: E2E_DATABASE_URL })
  await client.connect()
  try {
    return await client.query(text, params)
  } finally {
    await client.end()
  }
}
