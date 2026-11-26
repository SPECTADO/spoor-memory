// The pg client tools against the real test database (ADR-0038), through whichever tools this machine has:
// real binaries (CI: postgresql-client-17), else the docker shim into `spoor-test-db`, else skipped with the
// reason (test/pg-tools.ts). A tiny custom-format dump of a scratch schema round-trips through
// pg_dump -> pg_restore (script on stdout) -> psql -1, all over pipes.
import { PassThrough } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testPool } from '../../../test/db.js'
import { resolveTestPgTools } from '../../../test/pg-tools.js'
import { PgToolError } from './pgtools.js'

const pg = resolveTestPgTools()
if (!pg.available) console.warn(`[pgtools.integration] skipped: ${pg.reason}`)

const SCHEMA = 'spoor_pgtools_rt'

describe.skipIf(!pg.available)('pg client tools against the test database', () => {
  const tools = pg.available ? pg.tools : (undefined as never)

  beforeAll(async () => {
    await testPool().query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  })
  afterAll(async () => {
    await testPool().query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  })

  it('reports versions; the tools are not older than the server', async () => {
    const v = await tools.version('pg_dump')
    expect(v?.text).toMatch(/^pg_dump \(PostgreSQL\) \d+/)
    const { rows } = await testPool().query<{ n: string }>('SHOW server_version_num')
    const probe = await tools.probe(Math.floor(Number(rows[0]?.n) / 10000))
    expect(probe.ok).toBe(true)
  })

  it('round-trips a tiny custom-format dump over pipes only', async () => {
    const pool = testPool()
    await pool.query(`CREATE SCHEMA ${SCHEMA}`)
    await pool.query(`CREATE TABLE ${SCHEMA}.t (id int PRIMARY KEY, note text NOT NULL)`)
    await pool.query(`INSERT INTO ${SCHEMA}.t VALUES (1, 'one'), (2, 'zwei: ü')`)

    const dump = await tools.run('pg_dump', ['-Fc', '-Z6', '--no-owner', '--no-privileges', '-n', SCHEMA])
    expect(dump.stdout.subarray(0, 5).toString()).toBe('PGDMP')

    const list = await tools.run('pg_restore', ['--list'], { stdin: dump.stdout })
    expect(list.stdout.toString()).toMatch(new RegExp(`TABLE ${SCHEMA} t `))

    await pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`)

    // pg_restore writes the SQL script to stdout; psql runs it in one transaction from stdin
    const script = new PassThrough()
    await Promise.all([
      tools.run('pg_restore', ['--no-owner', '--no-privileges', '-f', '-'], {
        stdin: dump.stdout,
        stdout: script,
      }),
      tools.run('psql', ['-X', '-q', '-1', '-v', 'ON_ERROR_STOP=1'], { stdin: script }),
    ])
    const { rows } = await pool.query(`SELECT id, note FROM ${SCHEMA}.t ORDER BY id`)
    expect(rows).toEqual([
      { id: 1, note: 'one' },
      { id: 2, note: 'zwei: ü' },
    ])
  })

  it('psql -1 with ON_ERROR_STOP fails as a whole and reports the error', async () => {
    const err = await tools
      .run('psql', ['-X', '-q', '-1', '-v', 'ON_ERROR_STOP=1'], {
        stdin: `CREATE SCHEMA ${SCHEMA}_never;\nSELECT 1/0;\n`,
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PgToolError)
    expect((err as PgToolError).stderr).toMatch(/division by zero/)
    const { rows } = await testPool().query(`SELECT 1 FROM pg_namespace WHERE nspname = '${SCHEMA}_never'`)
    expect(rows).toEqual([])
  })
})
