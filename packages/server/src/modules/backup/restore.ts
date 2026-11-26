/**
 * Full restore of the whole database from a backup bundle (ADR-0039, api.md section 13.2). Instance admins,
 * cookie only, two steps:
 *
 *   prepare   sha256 + size of database.dump against backup.json and pg_restore reading all of it; refuses a
 *             backup newer than this server (409 `backup_too_new`) and a database other Spoor instances are
 *             connected to (409 `other_instances`); returns warnings, a summary, the phrase to type and a
 *             5-minute in-memory token bound to the session and the backup.
 *   restore   token + phrase + the admin's password (403 `confirmation_failed`, the token is used up either
 *             way), then 202 and the work in the background:
 *
 *     1. pre_restore_backup  a `pre-restore` bundle of the live database; when it fails nothing is changed
 *     2. maintenance         `restore-state.json` (with a nonce) in SPOOR_BACKUP_DIR; the gate: 503 `maintenance`
 *     3. draining            scheduler and export task runner stopped, MCP sessions closed, up to 30 s for
 *                            requests in flight; the live credentials (tokens, users, invites) and the live
 *                            backup settings are captured (the settings into restore-state.json too)
 *     4. restoring           ONE transaction through psql, stdin = prelude + `pg_restore` script + epilogue
 *     5. startup             the startup steps again (migrations forward), the live backup settings written back
 *                            (a later start writes them back when this step did not finish)
 *     6. done                the gate opens; everyone logs in again (sessions were truncated in the transaction)
 *
 * How the transaction is made safe for a non-superuser role (worked out against PostgreSQL 17):
 * - `pg_restore -n public -n drizzle` leaves out the SCHEMA entries and the `COMMENT ON SCHEMA public` a
 *   non-owner may not run; extensions are not in the dump at all (pg_dump -n), so their objects stay as they are.
 * - The prelude drops, without CASCADE, every view, table, standalone sequence, routine, domain and type in
 *   `public` and `drizzle` that the current role owns and that is not an extension member. Anything else in the
 *   way (an object of another role) makes the CREATE fail, and the whole transaction rolls back.
 * - psql runs WITHOUT `-1`: the prelude opens the transaction (`BEGIN`) and only the epilogue, appended after
 *   pg_restore exited 0 and the bytes it read matched backup.json, says `COMMIT`. A cut or failed stream ends
 *   psql's input without COMMIT, so the server rolls back whatever psql had sent (psql -1 would COMMIT at EOF).
 * - The epilogue's `instance.restore` audit row carries the nonce: its presence is the only proof of a commit
 *   (psql exits 0 at an EOF without COMMIT too). It uses only columns every schema version has.
 *
 * `restore-state.json` and that row also decide, after a crash, whether the restore is `done` or `interrupted`.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough, pipeline, Transform, Writable } from 'node:stream'
import {
  type BackupFile,
  RESTORE_PHASES,
  RESTORE_STATES,
  RESTORE_TOKEN_TTL_S,
  type RestoreConfirmRequest,
  type RestorePhase,
  type RestorePrepareResponse,
  type RestoreStartedResponse,
  type RestoreStatusJson,
  type RestoreWarningJson,
  restorePhrase,
} from '@spoor/shared'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { appApplicationName } from '../../db/client.js'
import { instanceSettings, users } from '../../db/schema.js'
import { actorLabel } from '../../lib/auth-context.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError, loggableError } from '../../lib/errors.js'
import { VERSION } from '../../version.js'
import { PasswordHasher, type UserContext } from '../auth/index.js'
import { readDumpThroughPgRestore } from './bundle.js'
import { type BundleEntry, DUMP_FILE, FILE_MODE } from './catalog.js'
import type { HeldLock } from './lock.js'
import { MaintenanceGate } from './maintenance.js'
import { currentMigration } from './migrations.js'
import { PgToolError, type PgTools } from './pgtools.js'
import type { BackupService } from './service.js'
import {
  BACKUP_SETTINGS_KEY,
  readBackupSettings,
  type StoredBackupSettings,
  writeBackupSettings,
} from './settings.js'

export const RESTORE_STATE_FILE = 'restore-state.json'
const STATE_FORMAT = 'spoor-restore-state/1'
/** Requests in flight get this long to finish once the gate is on (ADR-0039). */
export const RESTORE_DRAIN_MS = 30_000
/** The prelude's DROPs wait this long for a lock, then the transaction fails (and rolls back). */
export const RESTORE_LOCK_TIMEOUT = '10s'
/** A verify older than this is worth a `not_verified` warning. */
const VERIFY_FRESH_MS = 7 * 24 * 3_600_000

/** pg_restore writes the SQL script of the objects in the two schemas (no SCHEMA entries) to stdout. */
export const RESTORE_PG_RESTORE_ARGS: readonly string[] = [
  '--no-owner',
  '--no-privileges',
  '-n',
  'public',
  '-n',
  'drizzle',
  '-f',
  '-',
]
/** No `-1`: the transaction is opened by the prelude and committed only by the epilogue (see the header). */
export const RESTORE_PSQL_ARGS: readonly string[] = ['-X', '-q', '-v', 'ON_ERROR_STOP=1']

/** What the restore needs from the rest of the app (wired in src/app.ts). */
export interface RestoreHost {
  /** Stop the scheduler and the export task runner (each waits for its running work). */
  stopBackground(): Promise<void>
  /** Close every MCP session. */
  closeSessions(): void
  /** The startup steps again: migrations, `_shared`, job lock rows, bootstrap admin, embedding targets. */
  startupSteps(): Promise<void>
  /** Start the scheduler (when it ran before) and the export task runner again. */
  startBackground(): Promise<void>
}

export interface RestoreServiceOptions {
  /** Wait for requests in flight at most this long (default 30 s). */
  drainMs?: number
  /** Called as each phase starts (tests pause or break things here). */
  onPhase?: (phase: RestorePhase) => Promise<void> | void
}

const stateFileSchema = z.object({
  format: z.literal(STATE_FORMAT),
  state: z.enum(RESTORE_STATES),
  phase: z.enum(RESTORE_PHASES).nullable(),
  nonce: z.uuid(),
  backup_id: z.string(),
  pre_restore_backup_id: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  error: z.string().nullable(),
  /** true = the nonce's row was seen; false = rolled back; null = not known (yet). */
  committed: z.boolean().nullable(),
  actor_user_id: z.string().nullable(),
  /** The live `backup` settings captured before the transaction (raw null = no row); absent in older files. */
  live_backup_settings: z
    .object({ raw: z.record(z.string(), z.unknown()).nullable() })
    .nullable()
    .optional(),
  /** false until the live settings are written back after the commit; a later start finishes it. */
  settings_written_back: z.boolean().optional(),
})
export type RestoreStateFile = z.infer<typeof stateFileSchema>

interface PreparedToken {
  sessionHash: string
  userId: string
  backupId: string
  phrase: string
  expiresAt: number
}

/**
 * The live credentials, read just before the transaction. The epilogue re-applies them to the restored rows so
 * that a restore never brings a credential back that was revoked, used, disabled or deleted since the backup.
 */
export interface CredentialSnapshot {
  /**
   * The live `_shared` project id: the "absent here = deleted since" rules apply only when the restored database
   * has it too (a backup of this instance). A backup of another instance (a move to a new server) has other ids
   * throughout, and its users and tokens must not all come back disabled and revoked.
   */
  sharedProjectId: string | null
  /** Every live token (revoked or not). A restored token absent here was deleted since (cascade) = revoked. */
  tokens: readonly { id: string; revoked_at: string | null }[]
  /** Every live user. A restored user absent here was deleted since = disabled. */
  users: readonly {
    id: string
    disabled_at: string | null
    password_hash: string
    password_changed_at: string
  }[]
  /** Every live invite. A restored open invite absent here, or used/revoked here, is revoked. */
  invites: readonly { id: string; revoked_at: string | null; used_at: string | null }[]
}

const confirmationFailed = () =>
  new ApiError('confirmation_failed', {
    message: 'The confirmation is wrong or has expired.',
    hint: 'Prepare the restore again, then type the phrase exactly and your own password.',
  })

// ---- SQL ------------------------------------------------------------------------------------------------

/** A single-quoted SQL literal (standard_conforming_strings is on); NUL cannot be stored and is refused. */
export function sqlString(s: string): string {
  if (s.includes('\u0000')) throw new Error('NUL in an SQL literal')
  return `'${s.replace(/'/g, "''")}'`
}

const notExtensionMember = (catalog: string, alias: string, deptypes = "'e'") =>
  `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.${catalog}'::pg_catalog.regclass AND d.objid = ${alias}.oid AND d.deptype IN (${deptypes}))`

const OWN_SCHEMAS = "n.nspname IN ('public', 'drizzle')"

/** One `DROP <what> a, b, c` of the matching objects (one statement, so their mutual references are fine). */
const dropStep = (what: string, select: string) => `
  SELECT pg_catalog.string_agg(x, ', ') INTO names FROM (${select}) AS s(x);
  IF names IS NOT NULL THEN EXECUTE 'DROP ${what} ' || names; END IF;`

/**
 * Opens the transaction and empties the two schemas of what the current role owns: views, materialized
 * views, tables (their indexes, constraints, triggers, owned sequences and row types go with them), standalone
 * sequences, routines, domains, then other types. No CASCADE: an object of another role that depends on one of
 * these stops the restore instead of being dropped. Extension members are never touched.
 */
export const RESTORE_PRELUDE = `SET standard_conforming_strings = on;
BEGIN;
SET lock_timeout = '${RESTORE_LOCK_TIMEOUT}';
DO $spoor_restore_prelude$
DECLARE
  me oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user);
  names text;
BEGIN${dropStep(
  'VIEW',
  `SELECT c.oid::pg_catalog.regclass::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE ${OWN_SCHEMAS} AND c.relkind = 'v' AND c.relowner = me AND ${notExtensionMember('pg_class', 'c')}`,
)}${dropStep(
  'MATERIALIZED VIEW',
  `SELECT c.oid::pg_catalog.regclass::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE ${OWN_SCHEMAS} AND c.relkind = 'm' AND c.relowner = me AND ${notExtensionMember('pg_class', 'c')}`,
)}${dropStep(
  'TABLE',
  `SELECT c.oid::pg_catalog.regclass::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE ${OWN_SCHEMAS} AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relowner = me
      AND ${notExtensionMember('pg_class', 'c')}`,
)}${dropStep(
  'SEQUENCE',
  `SELECT c.oid::pg_catalog.regclass::text FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE ${OWN_SCHEMAS} AND c.relkind = 'S' AND c.relowner = me
      AND ${notExtensionMember('pg_class', 'c', "'e', 'a', 'i'")}`,
)}${dropStep(
  'ROUTINE',
  `SELECT p.oid::pg_catalog.regprocedure::text FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE ${OWN_SCHEMAS} AND p.proowner = me AND ${notExtensionMember('pg_proc', 'p')}`,
)}${dropStep(
  'DOMAIN',
  `SELECT t.oid::pg_catalog.regtype::text FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE ${OWN_SCHEMAS} AND t.typowner = me AND t.typtype = 'd' AND ${notExtensionMember('pg_type', 't', "'e', 'i'")}`,
)}${dropStep(
  'TYPE',
  `SELECT t.oid::pg_catalog.regtype::text FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid
    WHERE ${OWN_SCHEMAS} AND t.typowner = me AND t.typtype IN ('b', 'c', 'e', 'r') AND (t.typrelid = 0 OR c.relkind = 'c')
      AND ${notExtensionMember('pg_type', 't', "'e', 'i'")}`,
)}
END
$spoor_restore_prelude$;
`

export interface EpilogueInput {
  nonce: string
  backupId: string
  backupCreatedAt: string
  preRestoreBackupId: string | null
  actor: { userId: string; label: string }
  credentials: CredentialSnapshot
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** `to_json(timestamptz)`: `2026-11-26T12:00:00.123456+00:00` (the server casts it back). */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:\d{2})?|Z)$/

const ts = (v: string | null) => v === null || TIMESTAMP_RE.test(v)

/** Validates the snapshot (ids, timestamps, hashes) and returns the three JSON arrays the epilogue reads. */
function credentialJson(c: CredentialSnapshot): { tokens: string; users: string; invites: string } {
  if (c.sharedProjectId !== null && !UUID_RE.test(c.sharedProjectId)) throw new Error('bad shared project id')
  for (const t of c.tokens) {
    if (!UUID_RE.test(t.id) || !ts(t.revoked_at)) throw new Error('bad token in the credential snapshot')
  }
  for (const u of c.users) {
    if (
      !UUID_RE.test(u.id) ||
      !ts(u.disabled_at) ||
      !TIMESTAMP_RE.test(u.password_changed_at) ||
      typeof u.password_hash !== 'string' ||
      u.password_hash === '' ||
      u.password_hash.includes('\u0000')
    ) {
      throw new Error('bad user in the credential snapshot')
    }
  }
  for (const i of c.invites) {
    if (!UUID_RE.test(i.id) || !ts(i.revoked_at) || !ts(i.used_at)) {
      throw new Error('bad invite in the credential snapshot')
    }
  }
  return {
    tokens: JSON.stringify(c.tokens.map((t) => ({ id: t.id, revoked_at: t.revoked_at }))),
    users: JSON.stringify(
      c.users.map((u) => ({
        id: u.id,
        disabled_at: u.disabled_at,
        password_hash: u.password_hash,
        password_changed_at: u.password_changed_at,
      })),
    ),
    invites: JSON.stringify(
      c.invites.map((i) => ({ id: i.id, revoked_at: i.revoked_at, used_at: i.used_at })),
    ),
  }
}

/**
 * After the restored script: no session or device code survives, job leases and running job runs of the
 * backup's moment are cleared, the live credentials are applied again (below), and the `instance.restore`
 * audit row carrying the nonce is written. Then COMMIT. Only tables and columns of migration 0001 are used, so
 * a dump of an older schema takes it as well (the newer migrations run after the commit).
 *
 * Credentials never come back: a restored token revoked live, or deleted live (a deleted user or project takes
 * its tokens by cascade), is revoked; a restored user disabled live is disabled, one deleted live comes back
 * disabled; a password changed since the backup keeps its live hash; a restored invite revoked, used or deleted
 * live is revoked. The "deleted live" rules need the backup to be of this instance (`sharedProjectId`).
 */
export function restoreEpilogue(input: EpilogueInput): string {
  if (!UUID_RE.test(input.nonce) || !UUID_RE.test(input.actor.userId)) throw new Error('bad epilogue input')
  const cred = credentialJson(input.credentials)
  const liveTokens = `pg_catalog.jsonb_to_recordset(${sqlString(cred.tokens)}::jsonb) AS x(id uuid, revoked_at timestamptz)`
  const liveUsers = `pg_catalog.jsonb_to_recordset(${sqlString(cred.users)}::jsonb)
    AS x(id uuid, disabled_at timestamptz, password_hash text, password_changed_at timestamptz)`
  const liveInvites = `pg_catalog.jsonb_to_recordset(${sqlString(cred.invites)}::jsonb)
    AS x(id uuid, revoked_at timestamptz, used_at timestamptz)`
  // same instance = the restored database has the live `_shared` project; false (never true) otherwise
  const sameInstance =
    input.credentials.sharedProjectId === null
      ? 'false'
      : `EXISTS (SELECT 1 FROM public.projects WHERE id = ${sqlString(input.credentials.sharedProjectId)}::uuid)`
  const data = JSON.stringify({
    nonce: input.nonce,
    backup_id: input.backupId,
    backup_created_at: input.backupCreatedAt,
    pre_restore_backup_id: input.preRestoreBackupId,
    spoor_version: VERSION,
  })
  const summary = `Full restore from backup ${input.backupId}`.slice(0, 300)
  return `
SET standard_conforming_strings = on;
TRUNCATE public.sessions, public.device_codes;
UPDATE public.job_locks SET locked_until = '-infinity', locked_by = NULL;
UPDATE public.job_runs SET status = 'error', finished_at = pg_catalog.now(), error = 'interrupted by a full restore'
  WHERE status = 'running';
UPDATE public.tokens AS t SET revoked_at = x.revoked_at
  FROM ${liveTokens}
  WHERE t.id = x.id AND t.revoked_at IS NULL AND x.revoked_at IS NOT NULL;
UPDATE public.tokens SET revoked_at = pg_catalog.now()
  WHERE revoked_at IS NULL AND id NOT IN (SELECT x.id FROM ${liveTokens}) AND ${sameInstance};
UPDATE public.users AS u SET disabled_at = x.disabled_at
  FROM ${liveUsers}
  WHERE u.id = x.id AND u.disabled_at IS NULL AND x.disabled_at IS NOT NULL;
UPDATE public.users AS u SET password_hash = x.password_hash, password_changed_at = x.password_changed_at
  FROM ${liveUsers}
  WHERE u.id = x.id AND x.password_changed_at > u.password_changed_at;
UPDATE public.users SET disabled_at = pg_catalog.now()
  WHERE disabled_at IS NULL AND id NOT IN (SELECT x.id FROM ${liveUsers}) AND ${sameInstance};
UPDATE public.invites AS i SET revoked_at = COALESCE(x.revoked_at, pg_catalog.now())
  FROM ${liveInvites}
  WHERE i.id = x.id AND i.revoked_at IS NULL AND (x.revoked_at IS NOT NULL OR x.used_at IS NOT NULL);
UPDATE public.invites SET revoked_at = pg_catalog.now()
  WHERE revoked_at IS NULL AND used_at IS NULL AND id NOT IN (SELECT x.id FROM ${liveInvites}) AND ${sameInstance};
INSERT INTO public.audit_log (actor_user_id, actor_label, via, client_name, action, summary, data)
  VALUES (${sqlString(input.actor.userId)}::uuid, ${sqlString(input.actor.label)}, 'web', 'web', 'instance.restore',
    ${sqlString(summary)}, ${sqlString(data)}::jsonb);
COMMIT;
`
}

// ---- streams --------------------------------------------------------------------------------------------

const nullSink = () =>
  new Writable({
    write(_chunk, _enc, cb) {
      cb()
    },
  })

/** Writes into `target` with back-pressure and never ends it (the epilogue still follows). */
function feedInto(target: PassThrough): Writable {
  const closed = () => new Error('psql input closed')
  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      if (target.destroyed || target.writableEnded) return cb(closed())
      if (target.write(chunk)) return cb()
      const onDrain = () => {
        target.off('close', onClose)
        cb()
      }
      const onClose = () => {
        target.off('drain', onDrain)
        cb(closed())
      }
      target.once('drain', onDrain)
      target.once('close', onClose)
    },
    final(cb) {
      cb()
    },
  })
}

/**
 * The restore transaction: psql reads the prelude, then pg_restore's script of the dump (whose bytes are hashed
 * on the way), then, only when pg_restore exited 0 and the bytes match `expected`, the epilogue with COMMIT.
 * On any failure psql is stopped before it could read a COMMIT. Throws the first error.
 */
export async function runRestoreTransaction(
  tools: PgTools,
  dumpPath: string,
  expected: Pick<BackupFile, 'sha256' | 'size'>,
  epilogue: string,
): Promise<void> {
  const script = new PassThrough()
  const stopPsql = new AbortController()
  const stopRestore = new AbortController()
  const psql = tools
    .run('psql', RESTORE_PSQL_ARGS, { stdin: script, stdout: nullSink(), signal: stopPsql.signal })
    .then(
      () => null,
      (err: unknown) => err,
    )
  // psql gone (error or not): pg_restore has nobody to write to
  void psql.then(() => stopRestore.abort())
  script.write(RESTORE_PRELUDE)

  const hash = createHash('sha256')
  let size = 0
  const tee = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length
      hash.update(chunk)
      cb(null, chunk)
    },
  })
  const input = pipeline(createReadStream(dumpPath), tee, () => {})
  let failure: unknown = null
  try {
    await tools.run('pg_restore', RESTORE_PG_RESTORE_ARGS, {
      stdin: input,
      stdout: feedInto(script),
      signal: stopRestore.signal,
    })
    const sha256 = hash.digest('hex')
    if (size !== expected.size || sha256 !== expected.sha256) {
      failure = new Error(`${DUMP_FILE} does not match backup.json (it changed after prepare)`)
    }
  } catch (err) {
    failure = err
  }
  if (failure) {
    // no COMMIT ever reaches psql: kill it (its connection drops, the server rolls back) and end its input
    stopPsql.abort()
    script.end()
  } else {
    script.end(epilogue)
  }
  const psqlError = await psql
  if (failure) throw failure
  if (psqlError) throw psqlError
}

// ---- the service ----------------------------------------------------------------------------------------

/** A short, safe message for the status (no stack, at most one line of a tool's stderr). */
function shortError(err: unknown): string {
  // psql: the server's ERROR line, not the CONTEXT line that follows it
  if (err instanceof PgToolError) {
    const line = /^(?:psql:[^\n]*?)?ERROR:\s+(.+)$/m.exec(err.stderr)?.[1]
    if (line) return `${err.tool}: ${line}`.slice(0, 300)
  }
  const msg =
    err instanceof ApiError
      ? (err.publicMessage ?? err.message)
      : err instanceof Error
        ? err.message
        : String(err)
  return (msg.split('\n')[0] ?? '').slice(0, 300)
}

export class RestoreService {
  readonly gate = new MaintenanceGate()
  readonly #hasher = new PasswordHasher()
  readonly #tokens = new Map<string, PreparedToken>()
  #host: RestoreHost | null = null
  /** This process's restore (running or finished); null = read restore-state.json. */
  #current: RestoreStateFile | null = null
  #background: Promise<void> = Promise.resolve()

  constructor(
    private readonly deps: ServerDeps,
    private readonly backup: BackupService,
    private readonly opts: RestoreServiceOptions = {},
  ) {}

  setHost(host: RestoreHost): void {
    this.#host = host
  }

  /** Resolves when the background restore (if any) has finished (tests). */
  idle(): Promise<void> {
    return this.#background
  }

  #migrationsDir(): string | undefined {
    return this.deps.config.SPOOR_MIGRATIONS_DIR ?? undefined
  }

  #requireHost(): RestoreHost {
    if (!this.#host) {
      throw new ApiError('backups_unavailable', {
        message: 'Backups are not available: a full restore is not wired in this process.',
        details: { reason: 'restore_unavailable' },
      })
    }
    return this.#host
  }

  #assertNotTooNew(entry: BundleEntry) {
    const current = currentMigration(this.#migrationsDir())
    if (entry.manifest.migration.count > current.count) {
      throw new ApiError('backup_too_new', {
        message: `Backup ${entry.id} has ${entry.manifest.migration.count} migrations; this server knows ${current.count}.`,
        hint: 'Restore it with the Spoor version that made it, or a newer one.',
        details: { backup: entry.manifest.migration, current },
      })
    }
  }

  /** 409 `other_instances` when another Spoor process is connected to this database. */
  async #assertAlone(): Promise<void> {
    const res = await this.deps.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND application_name LIKE 'spoor:%' AND application_name <> ${appApplicationName()}`,
    )
    const n = Number(res.rows[0]?.n ?? 0)
    if (n > 0) {
      throw new ApiError('other_instances', {
        message: `Other Spoor instances are connected to the database (${n} connection(s)).`,
        hint: 'Stop every other Spoor container first; the restore needs the database to itself.',
        details: { count: n },
      })
    }
  }

  #sweepTokens(now: number) {
    for (const [k, t] of this.#tokens) if (t.expiresAt <= now) this.#tokens.delete(k)
  }

  #warnings(entry: BundleEntry, toApply: number): RestoreWarningJson[] {
    const m = entry.manifest
    const w: RestoreWarningJson[] = [
      {
        code: 'data_loss',
        message: `Everything written after ${m.created_at} is lost (a pre-restore backup is made first).`,
      },
      { code: 'logout', message: 'Every session ends: everyone, you too, logs in again afterwards.' },
      {
        code: 'tokens',
        message:
          'Tokens revoked or deleted since the backup stay revoked; tokens created since the backup are gone.',
      },
      {
        code: 'security',
        message:
          'Users disabled since the backup stay disabled; users deleted since the backup come back disabled; ' +
          'passwords changed since the backup keep the new one; invites revoked or used since stay unusable. ' +
          'Role and membership changes made since the backup are rewound.',
      },
    ]
    if (toApply > 0) {
      w.push({
        code: 'older_schema',
        message: `The backup is from an older schema; ${toApply} migration(s) run after the restore.`,
      })
    }
    if (m.spoor_version !== VERSION) {
      w.push({
        code: 'other_version',
        message: `The backup was made by Spoor ${m.spoor_version}; this is ${VERSION}.`,
      })
    }
    const verifiedAt = m.verified_at ? Date.parse(m.verified_at) : null
    if (verifiedAt === null || this.backup.now().getTime() - verifiedAt > VERIFY_FRESH_MS) {
      w.push({
        code: 'not_verified',
        message:
          verifiedAt === null
            ? 'The backup is not verified.'
            : `The backup was last verified ${m.verified_at}.`,
      })
    }
    const skipped = m.projects.filter((p) => p.archive === null).length
    if (skipped > 0) {
      w.push({
        code: 'projects_skipped',
        message: `${skipped} project(s) have no per-project archive; they are in the database dump all the same.`,
      })
    }
    return w
  }

  /** `POST /backups/:id/restore/prepare`. */
  async prepare(
    ctx: UserContext,
    sessionIdHash: Buffer | undefined,
    id: string,
  ): Promise<RestorePrepareResponse> {
    if (!sessionIdHash) throw new ApiError('unauthenticated', { message: 'Log in first.' })
    this.#requireHost()
    const { entry } = await this.backup.bundleOr404(id)
    await this.backup.requireAvailable()
    this.#assertNotTooNew(entry)
    await this.#assertAlone()
    const running = await this.backup.lock.running(this.deps.db)
    if (running)
      throw new ApiError('busy', { message: `A ${running.operation} is running.`, hint: 'Try again later.' })

    const problems = await this.#checkDump(entry)
    if (problems.length > 0) {
      throw new ApiError('invalid_archive', {
        message: `Backup ${id} cannot be restored: ${problems[0]}`,
        details: { problems },
      })
    }

    const m = entry.manifest
    const current = currentMigration(this.#migrationsDir())
    const toApply = Math.max(0, current.count - m.migration.count)
    const now = Date.now()
    this.#sweepTokens(now)
    const token = randomBytes(24).toString('base64url')
    const phrase = restorePhrase(new Date(m.created_at))
    const expiresAt = now + RESTORE_TOKEN_TTL_S * 1000
    this.#tokens.set(token, {
      sessionHash: sessionIdHash.toString('hex'),
      userId: ctx.user.id,
      backupId: id,
      phrase,
      expiresAt,
    })
    const bundles = await this.backup.list()
    const item = bundles.items.find((b) => b.id === id)
    if (!item) throw new ApiError('not_found', { message: 'No such backup.' })
    return {
      token,
      expires_at: new Date(expiresAt).toISOString(),
      phrase,
      backup: item,
      summary: {
        created_at: m.created_at,
        spoor_version: m.spoor_version,
        migration: { backup: m.migration, current, to_apply: toApply },
        projects: m.projects.length,
        items: m.projects.reduce((n, p) => n + p.items, 0),
        pre_restore_backup: true,
      },
      warnings: this.#warnings(entry, toApply),
    }
  }

  /** sha256 and size of the dump against backup.json, and pg_restore reading all of it. */
  async #checkDump(entry: BundleEntry): Promise<string[]> {
    const f = entry.manifest.files.find((x) => x.path === DUMP_FILE)
    if (!f) return [`${DUMP_FILE}: not in backup.json`]
    try {
      const got = await readDumpThroughPgRestore(this.backup.tools, join(entry.dir, DUMP_FILE))
      if (got.size !== f.size) return [`${DUMP_FILE}: size mismatch`]
      if (got.sha256 !== f.sha256) return [`${DUMP_FILE}: sha256 mismatch`]
      return []
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return [`${DUMP_FILE}: missing`]
      return [`${DUMP_FILE}: pg_restore cannot read it (${shortError(err)})`]
    }
  }

  async #passwordOk(ctx: UserContext, password: string): Promise<boolean> {
    const [u] = await this.deps.db
      .select({ hash: users.passwordHash })
      .from(users)
      .where(eq(users.id, ctx.user.id))
      .limit(1)
    if (!u || password === '') return false
    return this.#hasher.verify(password, u.hash)
  }

  /** `POST /backups/:id/restore`: confirmation, then 202 and the restore in the background. */
  async start(
    ctx: UserContext,
    sessionIdHash: Buffer | undefined,
    id: string,
    req: RestoreConfirmRequest,
  ): Promise<RestoreStartedResponse> {
    // the token is used up by any attempt, good or bad
    const tok = this.#tokens.get(req.token)
    this.#tokens.delete(req.token)
    const ok =
      tok !== undefined &&
      sessionIdHash !== undefined &&
      tok.expiresAt > Date.now() &&
      tok.sessionHash === sessionIdHash.toString('hex') &&
      tok.userId === ctx.user.id &&
      tok.backupId === id
    if (!ok || req.phrase !== tok.phrase) throw confirmationFailed()
    if (!(await this.#passwordOk(ctx, req.password))) throw confirmationFailed()

    const host = this.#requireHost()
    const { entry } = await this.backup.bundleOr404(id)
    const root = await this.backup.requireAvailable()
    this.#assertNotTooNew(entry)
    await this.#assertAlone()
    const held = await this.backup.lock.acquire({
      operation: 'restore',
      backup_id: id,
      kind: entry.manifest.kind,
      started_at: this.backup.now().toISOString(),
    })
    const state: RestoreStateFile = {
      format: STATE_FORMAT,
      state: 'running',
      phase: 'pre_restore_backup',
      nonce: randomUUID(),
      backup_id: id,
      pre_restore_backup_id: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
      committed: null,
      actor_user_id: ctx.user.id,
    }
    try {
      await writeStateFile(root, state)
    } catch (err) {
      await held.release()
      throw err
    }
    this.#current = state
    const actor = { userId: ctx.user.id, label: actorLabel(ctx) }
    this.#background = this.#run(host, root, entry, held, state, actor)
      .catch((err: unknown) =>
        this.deps.logger.error({ err: loggableError(err), backup: id }, 'restore: unexpected failure'),
      )
      .finally(() => held.release())
    return { restore: this.#json(state) }
  }

  async #setPhase(root: string, state: RestoreStateFile, phase: RestorePhase): Promise<void> {
    state.phase = phase
    await writeStateFile(root, state).catch((err: unknown) =>
      this.deps.logger.warn({ err: loggableError(err) }, 'restore: cannot write restore-state.json'),
    )
    await this.opts.onPhase?.(phase)
  }

  async #finish(
    root: string,
    state: RestoreStateFile,
    outcome: { state: 'done' | 'failed'; error?: string; committed: boolean | null },
  ): Promise<void> {
    state.state = outcome.state
    state.error = outcome.error ?? null
    state.committed = outcome.committed
    state.finished_at = new Date().toISOString()
    if (outcome.state === 'done') state.phase = 'done'
    await writeStateFile(root, state).catch((err: unknown) =>
      this.deps.logger.warn({ err: loggableError(err) }, 'restore: cannot write restore-state.json'),
    )
  }

  async #run(
    host: RestoreHost,
    root: string,
    entry: BundleEntry,
    held: HeldLock,
    state: RestoreStateFile,
    actor: { userId: string; label: string },
  ): Promise<void> {
    const log = this.deps.logger.child({ restore: entry.id })
    const db = this.deps.db

    // 1. pre-restore backup, while the app runs as usual
    await this.#setPhase(root, state, 'pre_restore_backup')
    try {
      const pre = await this.backup.runBackup('pre-restore', {
        info: { ...held.info, started_at: this.backup.now().toISOString() },
        release: async () => {},
      })
      state.pre_restore_backup_id = pre.id
      log.info({ pre_restore: pre.id }, 'restore: pre-restore backup written')
    } catch (err) {
      log.error({ err: loggableError(err) }, 'restore: pre-restore backup failed')
      await this.#finish(root, state, {
        state: 'failed',
        committed: false,
        error: `The pre-restore backup failed, so nothing was changed: ${shortError(err)}`,
      })
      return
    }

    // 2. the gate; 3. quiet the process
    await this.#setPhase(root, state, 'maintenance')
    this.gate.enable()
    let restarted = false
    const reopen = async () => {
      if (!restarted) {
        restarted = true
        await host
          .startBackground()
          .catch((err: unknown) =>
            log.error({ err: loggableError(err) }, 'restore: restarting background work failed'),
          )
      }
      this.gate.disable()
    }
    let credentials: CredentialSnapshot
    let live: StoredBackupSettings
    try {
      await this.#setPhase(root, state, 'draining')
      await host.stopBackground()
      host.closeSessions()
      const drained = await this.gate.drain(this.opts.drainMs ?? RESTORE_DRAIN_MS)
      if (!drained) log.warn({ in_flight: this.gate.inFlight }, 'restore: requests still in flight; going on')
      await this.#assertAlone()
      credentials = await readCredentials(this.deps)
      live = await readBackupSettings(db)
      // persisted before the transaction: a start after a crash or a failed startup step writes them back
      state.live_backup_settings = { raw: live.raw }
      state.settings_written_back = false
      await writeStateFile(root, state)
    } catch (err) {
      log.error({ err: loggableError(err) }, 'restore: preparing the database failed')
      await this.#finish(root, state, {
        state: 'failed',
        committed: false,
        error: `The restore did not start, nothing was changed: ${shortError(err)}`,
      })
      await reopen()
      return
    }

    // 4. the transaction
    await this.#setPhase(root, state, 'restoring')
    const dump = entry.manifest.files.find((f) => f.path === DUMP_FILE)
    let txError: unknown = null
    try {
      if (!dump) throw new Error(`${DUMP_FILE} is not in backup.json`)
      const epilogue = restoreEpilogue({
        nonce: state.nonce,
        backupId: entry.id,
        backupCreatedAt: entry.manifest.created_at,
        preRestoreBackupId: state.pre_restore_backup_id,
        actor,
        credentials,
      })
      await runRestoreTransaction(this.backup.tools, join(entry.dir, DUMP_FILE), dump, epilogue)
    } catch (err) {
      txError = err
    }
    let committed: boolean | null
    try {
      committed = await nonceCommitted(this.deps, state.nonce)
    } catch (err) {
      log.error({ err: loggableError(err) }, 'restore: cannot read the commit proof')
      committed = null
    }
    if (committed === null) {
      // the outcome is unknown: keep the gate on; the next start decides from restore-state.json and the nonce
      await this.#finish(root, state, {
        state: 'failed',
        committed: null,
        error: 'The outcome of the restore is not known (the database did not answer). Restart Spoor.',
      })
      return
    }
    if (!committed) {
      log.error({ err: loggableError(txError) }, 'restore: rolled back')
      await this.#finish(root, state, {
        state: 'failed',
        committed: false,
        error: `The restore failed and was rolled back; the database is as it was: ${shortError(
          txError ?? new Error('no commit'),
        )}`,
      })
      await reopen()
      return
    }
    if (txError) log.warn({ err: loggableError(txError) }, 'restore: committed, but psql reported an error')
    log.info('restore: committed')

    // 5. the startup steps on the restored database, then the live schedule back
    await this.#setPhase(root, state, 'startup')
    try {
      await host.startupSteps()
      await writeBackSettings(this.deps, live.raw)
      state.settings_written_back = true
    } catch (err) {
      log.error({ err: loggableError(err) }, 'restore: startup steps failed after the commit')
      // the gate stays on: the schema may be half-migrated; a restart runs the startup steps again
      await this.#finish(root, state, {
        state: 'failed',
        committed: true,
        error: `The database was restored, but the startup steps failed: ${shortError(err)}. Restart Spoor.`,
      })
      return
    }
    this.#tokens.clear()
    await this.#finish(root, state, { state: 'done', committed: true })
    await reopen()
    log.info('restore: done')
  }

  #json(s: RestoreStateFile | null): RestoreStatusJson {
    if (!s) {
      return {
        state: 'idle',
        phase: null,
        backup_id: null,
        pre_restore_backup_id: null,
        started_at: null,
        finished_at: null,
        error: null,
        maintenance: this.gate.on,
      }
    }
    return {
      state: s.state,
      phase: s.phase,
      backup_id: s.backup_id,
      pre_restore_backup_id: s.pre_restore_backup_id,
      started_at: s.started_at,
      finished_at: s.finished_at,
      error: s.error,
      maintenance: this.gate.on,
    }
  }

  /**
   * `GET /backups/restore-status`: this process's restore, else restore-state.json. A file left `running`
   * (or failed with an unknown or committed outcome) by a process that is gone is resolved here: the nonce's
   * audit row present = `done`, absent = `interrupted`; the answer is written back to the file.
   */
  async status(): Promise<RestoreStatusJson> {
    if (this.#current) return this.#json(this.#current)
    const root = this.backup.root
    if (!root) return this.#json(null)
    const file = await readStateFile(root)
    if (!file) return this.#json(null)
    const open = file.state === 'running' || (file.state === 'failed' && file.committed !== false)
    if (!open) return this.#json(file)
    try {
      // a restore of another process that still holds the heavy lock is not ours to judge
      if (await this.backup.lock.running(this.deps.db)) return this.#json(file)
      const committed = await nonceCommitted(this.deps, file.nonce)
      if (committed && file.settings_written_back === false && file.live_backup_settings) {
        // the process that committed did not get to write the live backup settings back: do it now
        try {
          await writeBackSettings(this.deps, file.live_backup_settings.raw)
        } catch (err) {
          this.deps.logger.error(
            { err: loggableError(err) },
            'restore: writing the live backup settings back failed',
          )
          const failed: RestoreStateFile = {
            ...file,
            state: 'failed',
            committed: true,
            finished_at: file.finished_at ?? new Date().toISOString(),
            error: `The database was restored, but the live backup settings could not be written back: ${shortError(
              err,
            )}. Check the backup settings, then restart Spoor.`,
          }
          await writeStateFile(root, failed).catch(() => {})
          return this.#json(failed)
        }
      }
      const resolved: RestoreStateFile = {
        ...file,
        state: committed ? 'done' : 'interrupted',
        phase: committed ? 'done' : file.phase,
        committed,
        ...(committed && file.settings_written_back === false ? { settings_written_back: true } : {}),
        finished_at: file.finished_at ?? new Date().toISOString(),
        error: committed
          ? null
          : 'The restore was interrupted before it committed; the database is as it was before.',
      }
      await writeStateFile(root, resolved)
      return this.#json(resolved)
    } catch {
      return this.#json(file)
    }
  }

  /** Called once after startup: resolves (and logs) a restore a previous process left open. */
  async resolveAtBoot(): Promise<RestoreStatusJson> {
    const s = await this.status()
    if (s.state === 'interrupted' || s.state === 'done') {
      this.deps.logger.info({ state: s.state, backup: s.backup_id }, 'restore: last full restore')
    }
    return s
  }
}

async function nonceCommitted(deps: ServerDeps, nonce: string): Promise<boolean> {
  const res = await deps.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'instance.restore' AND data->>'nonce' = ${nonce}`,
  )
  return Number(res.rows[0]?.n ?? 0) > 0
}

/** The live `backup` settings as they were before the restore (no row then = no row now). */
async function writeBackSettings(deps: ServerDeps, raw: Record<string, unknown> | null): Promise<void> {
  if (raw === null) {
    await deps.db.delete(instanceSettings).where(eq(instanceSettings.key, BACKUP_SETTINGS_KEY))
  } else {
    await writeBackupSettings(deps.db, raw, null)
  }
}

/** The live credentials (see `CredentialSnapshot`); timestamps as `to_json` text, which the epilogue casts back. */
async function readCredentials(deps: ServerDeps): Promise<CredentialSnapshot> {
  const t = await deps.db.execute<{ id: string; revoked_at: string | null }>(
    sql`SELECT id::text AS id, to_json(revoked_at)#>>'{}' AS revoked_at FROM tokens`,
  )
  const u = await deps.db.execute<{
    id: string
    disabled_at: string | null
    password_hash: string
    password_changed_at: string
  }>(
    sql`SELECT id::text AS id, to_json(disabled_at)#>>'{}' AS disabled_at, password_hash,
               to_json(password_changed_at)#>>'{}' AS password_changed_at FROM users`,
  )
  const i = await deps.db.execute<{ id: string; revoked_at: string | null; used_at: string | null }>(
    sql`SELECT id::text AS id, to_json(revoked_at)#>>'{}' AS revoked_at, to_json(used_at)#>>'{}' AS used_at
          FROM invites`,
  )
  const shared = await deps.db.execute<{ id: string }>(
    sql`SELECT id::text AS id FROM projects WHERE kind = 'shared' ORDER BY created_at LIMIT 1`,
  )
  return { sharedProjectId: shared.rows[0]?.id ?? null, tokens: t.rows, users: u.rows, invites: i.rows }
}

export async function readStateFile(root: string): Promise<RestoreStateFile | null> {
  let text: string
  try {
    text = await readFile(join(root, RESTORE_STATE_FILE), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = stateFileSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Atomic: a sibling temp file (0600), then rename. */
export async function writeStateFile(root: string, state: RestoreStateFile): Promise<void> {
  const tmp = join(root, `.${RESTORE_STATE_FILE}.${randomBytes(6).toString('hex')}`)
  try {
    await writeFile(tmp, `${JSON.stringify(stateFileSchema.parse(state), null, 2)}\n`, {
      mode: FILE_MODE,
      flag: 'wx',
    })
    await rename(tmp, join(root, RESTORE_STATE_FILE))
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
