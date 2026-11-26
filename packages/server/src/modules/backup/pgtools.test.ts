// The pg client tool wrapper without Postgres: URL -> libpq env, the argv guard (HARD RULE), version parsing,
// and the spawn plumbing (env, stdin, stdout, exit codes) against fake tools written to a temp dir.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { appApplicationName } from '../../db/client.js'
import {
  assertSafeArgs,
  type PgTool,
  PgToolError,
  PgTools,
  parsePgVersion,
  pgConnectionEnv,
  serverMajor,
} from './pgtools.js'

describe('pgConnectionEnv', () => {
  it('maps a URL to PG* variables, decoding user, password and database', () => {
    expect(pgConnectionEnv('postgres://spoor%40app:p%40ss%3Aw@db.example:6543/spoor%20db')).toEqual({
      PGHOST: 'db.example',
      PGPORT: '6543',
      PGUSER: 'spoor@app',
      PGPASSWORD: 'p@ss:w',
      PGDATABASE: 'spoor db',
    })
  })

  it('defaults the port, takes ?host= for a socket dir, maps sslmode, strips IPv6 brackets', () => {
    expect(pgConnectionEnv('postgresql://u@h/d')).toEqual({
      PGHOST: 'h',
      PGPORT: '5432',
      PGUSER: 'u',
      PGDATABASE: 'd',
    })
    expect(pgConnectionEnv('postgres://u@x/d?host=/var/run/postgresql').PGHOST).toBe('/var/run/postgresql')
    expect(pgConnectionEnv('postgres://u@h/d?sslmode=verify-full').PGSSLMODE).toBe('verify-full')
    expect(pgConnectionEnv('postgres://u@h/d?sslmode=no-verify').PGSSLMODE).toBe('require')
    expect(pgConnectionEnv('postgres://u@h/d?ssl=true').PGSSLMODE).toBe('require')
    expect(pgConnectionEnv('postgres://u@[::1]:5433/d')).toMatchObject({ PGHOST: '::1', PGPORT: '5433' })
  })

  it('refuses other URLs without echoing the password', () => {
    expect(() => pgConnectionEnv('mysql://u:secret@h/d')).toThrow(/postgres/)
    expect(() => pgConnectionEnv('postgres://u:secret@h/')).toThrow(/database/)
    expect(() => pgConnectionEnv('postgres://u:secret@h/d?sslmode=bogus')).toThrow(/sslmode/)
    try {
      pgConnectionEnv('nope secret')
    } catch (e) {
      expect((e as Error).message).not.toContain('secret')
    }
  })
})

describe('assertSafeArgs (HARD RULE: no connection or file in argv)', () => {
  it('allows the backup and restore arguments', () => {
    expect(() =>
      assertSafeArgs([
        '-Fc',
        '-Z6',
        '--no-owner',
        '--no-privileges',
        '-n',
        'public',
        '-n',
        'drizzle',
        '--lock-wait-timeout=60s',
        '--exclude-table-data=sessions',
      ]),
    ).not.toThrow()
    expect(() => assertSafeArgs(['-X', '-1', '-v', 'ON_ERROR_STOP=1', '-q'])).not.toThrow()
    expect(() => assertSafeArgs(['--list'])).not.toThrow()
    // stdout spelled as a file, which pg_restore 17 needs for a script
    expect(() => assertSafeArgs(['--no-owner', '-f', '-'])).not.toThrow()
    expect(() => assertSafeArgs(['--file=-'])).not.toThrow()
  })

  it.each([
    ['-d', 'spoor'],
    ['-dspoor'],
    ['--dbname=postgres://u:p@h/d'],
    ['-h', 'db'],
    ['--host=db'],
    ['-p', '5432'],
    ['-U', 'spoor'],
    ['--username', 'spoor'],
    ['-W'],
    ['-f', 'out.sql'],
    ['-f', '--', '-'],
    ['-fout'],
    ['--file=out.sql'],
    ['-o', 'x'],
    ['-L', 'list'],
    ['/tmp/database.dump'],
    ['..\\x'],
    ['~/x'],
    ['a\nb'],
  ])('refuses %s', (...args) => {
    expect(() => assertSafeArgs(args)).toThrow()
  })
})

describe('versions', () => {
  it('parses tool and server versions', () => {
    expect(parsePgVersion('pg_dump (PostgreSQL) 17.6 (Debian 17.6-1.pgdg120+1)\n')).toEqual({
      text: 'pg_dump (PostgreSQL) 17.6 (Debian 17.6-1.pgdg120+1)',
      major: 17,
      minor: 6,
    })
    expect(parsePgVersion('psql (PostgreSQL) 18beta1')?.major).toBe(18)
    expect(parsePgVersion('17.2')?.major).toBe(17)
    expect(parsePgVersion('command not found')).toBeNull()
    expect(serverMajor('170006')).toBe(17)
    expect(serverMajor(160004)).toBe(16)
  })
})

/** A temp dir with fake pg tools (shell scripts). */
function fakeBin(scripts: Partial<Record<PgTool, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'spoor-pgtools-'))
  for (const [tool, body] of Object.entries(scripts)) {
    const p = join(dir, tool)
    writeFileSync(p, `#!/bin/sh\n${body}\n`)
    chmodSync(p, 0o755)
  }
  return dir
}

const conn = pgConnectionEnv('postgres://spoor:s3cret@db:5432/spoor')

describe('PgTools.run', () => {
  it('passes the connection only as PG* env (never argv) and sets PGAPPNAME', async () => {
    const binDir = fakeBin({
      pg_dump: 'echo "ARGS:$*"; env | grep -E "^PG" | sort; [ -z "$DATABASE_URL" ] && echo NO_DATABASE_URL',
    })
    process.env.DATABASE_URL = 'postgres://leak@x/y'
    try {
      const r = await new PgTools({ binDir, connection: conn }).run('pg_dump', ['-Fc'])
      const out = r.stdout.toString()
      expect(out).toContain('ARGS:-Fc\n')
      expect(out).toContain('PGHOST=db\n')
      expect(out).toContain('PGPASSWORD=s3cret\n')
      expect(out).toContain('PGDATABASE=spoor\n')
      expect(out).toContain(`PGAPPNAME=${appApplicationName()}\n`)
      expect(out).toContain('NO_DATABASE_URL')
    } finally {
      delete process.env.DATABASE_URL
    }
  })

  it('pipes stdin to the tool and its stdout to a stream', async () => {
    const binDir = fakeBin({ psql: 'tr a-z A-Z' })
    const tools = new PgTools({ binDir, connection: conn })
    expect((await tools.run('psql', [], { stdin: 'select 1;' })).stdout.toString()).toBe('SELECT 1;')
    const sink = new PassThrough()
    const got: Buffer[] = []
    sink.on('data', (d: Buffer) => got.push(d))
    const src = new PassThrough()
    const run = tools.run('psql', [], { stdin: src, stdout: sink })
    src.write('abc')
    src.end('def')
    const r = await run
    expect(r.stdout.length).toBe(0)
    expect(Buffer.concat(got).toString()).toBe('ABCDEF')
  })

  it('rejects with PgToolError and the last stderr line on a non-zero exit', async () => {
    const binDir = fakeBin({
      pg_restore: 'echo "pg_restore: warning: x" >&2; echo "pg_restore: error: bad" >&2; exit 1',
    })
    const err = await new PgTools({ binDir }).run('pg_restore', ['--list']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PgToolError)
    expect((err as PgToolError).exitCode).toBe(1)
    expect((err as PgToolError).message).toBe('pg_restore exited with code 1: pg_restore: error: bad')
  })

  it('a missing binary is spawnCode ENOENT; version() is null and probe() says which', async () => {
    const tools = new PgTools({ binDir: fakeBin({}) })
    const err = await tools.run('pg_dump', ['--version']).catch((e: unknown) => e)
    expect((err as PgToolError).spawnCode).toBe('ENOENT')
    expect(await tools.version('pg_dump')).toBeNull()
    const probe = await tools.probe(17)
    expect(probe).toMatchObject({ ok: false, reason: 'pg_tools_missing' })
    expect(probe.ok === false && probe.message).toContain('pg_dump, pg_restore, psql')
  })

  it('probe: tools older than the server are a version mismatch', async () => {
    const v = (n: string) => `echo "x (PostgreSQL) ${n}"`
    const binDir = fakeBin({ pg_dump: v('16.4'), pg_restore: v('16.4'), psql: v('16.4') })
    const tools = new PgTools({ binDir })
    expect(await tools.probe(17)).toMatchObject({ ok: false, reason: 'pg_version_mismatch', clientMajor: 16 })
    expect(await tools.probe(16)).toEqual({ ok: true, pgDumpVersion: 'x (PostgreSQL) 16.4', clientMajor: 16 })
  })

  it('kills a tool whose collected output passes the cap', async () => {
    const binDir = fakeBin({ pg_dump: 'yes' })
    const err = await new PgTools({ binDir })
      .run('pg_dump', [], { maxStdoutBytes: 1024 })
      .catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/output over 1024 bytes/)
  })

  it('an abort kills the tool and rejects, even when a grandchild holds the pipes', async () => {
    const binDir = fakeBin({ pg_dump: 'sleep 30' })
    const ac = new AbortController()
    const started = Date.now()
    const run = new PgTools({ binDir }).run('pg_dump', [], { signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    await expect(run).rejects.toThrow(/aborted/)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('refuses unsafe argv before spawning, and PG* variables in extraEnv', async () => {
    const tools = new PgTools({ binDir: fakeBin({ pg_dump: 'exit 0' }) })
    await expect(tools.run('pg_dump', ['--dbname=x'])).rejects.toThrow(/not allowed/)
    const bad = new PgTools({ binDir: fakeBin({ pg_dump: 'exit 0' }), extraEnv: { PGPASSWORD: 'x' } })
    await expect(bad.run('pg_dump', [])).rejects.toThrow(/extraEnv/)
  })
})

describe('appApplicationName', () => {
  it('is spoor:<host>:<pid>:<instance>, at most 63 bytes, pid and instance kept', () => {
    expect(appApplicationName('box', 42, 'abcd1234')).toBe('spoor:box:42:abcd1234')
    const long = appApplicationName('h'.repeat(100), 1234567, 'abcd1234')
    expect(long.length).toBe(63)
    expect(long.endsWith(':1234567:abcd1234')).toBe(true)
  })

  it('two long host names with the same pid in two processes still differ', () => {
    const podA = `spoor-app-deployment-7d9f8c6b5-${'x'.repeat(40)}-aaaaa`
    const podB = `spoor-app-deployment-7d9f8c6b5-${'x'.repeat(40)}-bbbbb`
    expect(appApplicationName(podA, 1, '00000001')).not.toBe(appApplicationName(podB, 1, '00000002'))
    // this process's default instance part is random and stable
    expect(appApplicationName(podA, 1)).toBe(appApplicationName(podA, 1))
    expect(appApplicationName(podA, 1)).toMatch(/:1:[0-9a-f]{8}$/)
  })
})
