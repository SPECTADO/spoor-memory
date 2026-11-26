/**
 * Which pg client tools the backup integration tests use (ADR-0038):
 *   1. real binaries: `SPOOR_PG_BIN_DIR` when set, else pg_dump / pg_restore / psql on PATH (CI installs
 *      postgresql-client-17);
 *   2. else the docker shim (test/pg-shim), which runs the tools inside the `spoor-test-db` container of
 *      `pnpm test:db:up` (the shim connects to localhost:5432 inside it);
 *   3. else skip, with a message saying what is missing.
 * The pick is made once per test file. Real binaries older (major) than the server are skipped over.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type PgConnectionEnv,
  PgTools,
  parsePgVersion,
  pgConnectionEnv,
} from '../src/modules/backup/pgtools.js'
import { testDatabaseUrl } from './db-url.js'

export const PG_SHIM_DIR = join(dirname(fileURLToPath(import.meta.url)), 'pg-shim')
const SHIM_CONTAINER = process.env.SPOOR_PG_SHIM_CONTAINER || 'spoor-test-db'
/** The server major of the test database image (pgvector/pgvector:…-pg17). */
const SERVER_MAJOR = 17

export type TestPgTools =
  | { available: true; via: 'bin' | 'path' | 'shim'; binDir: string | undefined; tools: PgTools }
  | { available: false; reason: string }

function majorOf(bin: string): number | null {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' })
  if (r.status !== 0) return null
  return parsePgVersion(r.stdout)?.major ?? null
}

function shimUsable(): string | null {
  const r = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', SHIM_CONTAINER], { encoding: 'utf8' })
  if (r.error) return 'docker is not installed'
  if (r.status !== 0 || r.stdout.trim() !== 'true') {
    return `container ${SHIM_CONTAINER} is not running (pnpm test:db:up)`
  }
  return null
}

/** The docker CLI of the shim needs its own environment (context, socket); never PG* variables. */
function dockerEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('DOCKER_') || k === 'XDG_RUNTIME_DIR' || k === 'SPOOR_PG_SHIM_CONTAINER') out[k] = v
  }
  return out
}

let cached: TestPgTools | undefined

/** The connection environment of the test database. */
export function testPgConnection(): PgConnectionEnv {
  return pgConnectionEnv(testDatabaseUrl())
}

export function resolveTestPgTools(): TestPgTools {
  if (cached) return cached
  const connection = testPgConnection()
  const configured = process.env.SPOOR_PG_BIN_DIR
  if (configured) {
    const major = majorOf(join(configured, 'pg_dump'))
    if (major !== null && major >= SERVER_MAJOR) {
      cached = {
        available: true,
        via: 'bin',
        binDir: configured,
        tools: new PgTools({ binDir: configured, connection }),
      }
      return cached
    }
  }
  const pathMajor = majorOf('pg_dump')
  if (pathMajor !== null && pathMajor >= SERVER_MAJOR && majorOf('pg_restore') !== null && majorOf('psql')) {
    cached = { available: true, via: 'path', binDir: undefined, tools: new PgTools({ connection }) }
    return cached
  }
  const shimProblem = shimUsable()
  if (shimProblem === null) {
    cached = {
      available: true,
      via: 'shim',
      binDir: PG_SHIM_DIR,
      tools: new PgTools({ binDir: PG_SHIM_DIR, connection, extraEnv: dockerEnv() }),
    }
    return cached
  }
  const pathNote =
    pathMajor === null ? 'no pg_dump on PATH' : `pg_dump on PATH is ${pathMajor}, older than ${SERVER_MAJOR}`
  cached = {
    available: false,
    reason: `pg client tools unavailable: ${pathNote}, and the docker shim cannot run: ${shimProblem}`,
  }
  return cached
}
