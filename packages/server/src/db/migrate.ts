import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

/** Extensions the schema needs (data-model.md section 1). */
export const REQUIRED_EXTENSIONS = ['vector', 'unaccent'] as const

/** `src/db/migrations` works from both src/ (tsx, vitest) and dist/ (tsc output sits next to src/). */
export const DEFAULT_MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/db/migrations',
)

export interface MigrateOptions {
  /** Runtime role (NOSUPERUSER). Runs the migrations so it owns every object. */
  databaseUrl: string
  /** Superuser, used only for CREATE EXTENSION. Unset: the extensions must already exist. */
  migrateUrl?: string
  migrationsDir?: string
  log?: (msg: string) => void
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`

export class StartupError extends Error {}

/** Connect with retries (deployment.md section 4 step 3: 30 attempts, 2 s apart). */
export async function connectWithRetry(
  url: string,
  attempts = 30,
  delayMs = 2000,
  log?: (m: string) => void,
) {
  for (let i = 1; ; i++) {
    const client = new pg.Client({ connectionString: url })
    try {
      await client.connect()
      return client
    } catch (err) {
      await client.end().catch(() => {})
      if (i >= attempts) throw err
      log?.(`database not reachable (attempt ${i}/${attempts}), retrying`)
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
}

async function installedExtensions(client: pg.Client): Promise<Set<string>> {
  const res = await client.query<{ extname: string }>('SELECT extname FROM pg_extension')
  return new Set(res.rows.map((r) => r.extname))
}

/** Step 4a: superuser creates the extensions, or the runtime connection verifies they exist. */
export async function ensureExtensions(opts: MigrateOptions, client?: pg.Client) {
  if (opts.migrateUrl) {
    const su = new pg.Client({ connectionString: opts.migrateUrl })
    await su.connect()
    try {
      for (const ext of REQUIRED_EXTENSIONS) await su.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`)
      // drizzle's migrator runs `CREATE SCHEMA IF NOT EXISTS drizzle`, which Postgres ACL-checks (CREATE on the
      // database) before it looks for the schema. deploy/initdb/01-app-role.sh does not grant that, so grant it here.
      const runtimeRole = decodeURIComponent(new URL(opts.databaseUrl).username)
      if (runtimeRole) {
        await su.query(
          `GRANT CREATE ON DATABASE ${quoteIdent((await su.query('SELECT current_database() AS d')).rows[0].d)} TO ${quoteIdent(runtimeRole)}`,
        )
      }
    } finally {
      await su.end()
    }
    return
  }
  const own = client ?? new pg.Client({ connectionString: opts.databaseUrl })
  if (!client) await own.connect()
  try {
    const have = await installedExtensions(own)
    const missing = REQUIRED_EXTENSIONS.filter((e) => !have.has(e))
    if (missing.length > 0) {
      throw new StartupError(
        `missing Postgres extension(s): ${missing.join(', ')}. Run CREATE EXTENSION once as a superuser or set DATABASE_MIGRATE_URL.`,
      )
    }
  } finally {
    if (!client) await own.end()
  }
}

/**
 * Startup migration (deployment.md section 4 step 4): extensions via DATABASE_MIGRATE_URL, then drizzle
 * `migrate()` as the DATABASE_URL role on ONE dedicated client holding a session advisory lock (a lock taken
 * through a pool could be released on another connection and leak, blocking a second container).
 */
export async function runMigrations(opts: MigrateOptions): Promise<void> {
  const log = opts.log ?? (() => {})
  await ensureExtensions(opts)
  log('extensions ok')
  const client = await connectWithRetry(opts.databaseUrl, 30, 2000, log)
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('spoor-migrate'))")
    try {
      const db = drizzle(client, { casing: 'snake_case' })
      await migrate(db, { migrationsFolder: opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR })
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('spoor-migrate'))").catch(() => {})
    }
  } finally {
    await client.end().catch(() => {})
  }
  log('migrations ok')
}
