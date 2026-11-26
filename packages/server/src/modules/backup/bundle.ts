/**
 * Writing and verifying one backup bundle (ADR-0038):
 *
 *   1. free-space preflight (`fs.statfs` against half the database size + a margin)
 *   2. `.tmp/<id>/database.dump`: pg_dump -Fc of schemas public + drizzle, without the data of sessions,
 *      device_codes, request_log and resource_samples, streamed from the tool's stdout to the file
 *   3. `.tmp/<id>/projects/<slug>.zip`: one spoor-export/1 archive per project (incl. `_shared`) through the
 *      transfer module's `buildExport`; over the size cap retried without history; `busy` (a user import or
 *      export holds the transfer lock) retried, then recorded as skipped. Each export holds the transfer lock
 *      only for its own read, so user exports wait at most that long.
 *   4. verify: the dump streamed through `pg_restore -f -` into a null sink while hashing it; every archive
 *      re-read and hashed
 *   5. backup.json (verified_at = now), fsync of every file and directory, then one rename into `backups/`.
 *
 * Any failure removes `.tmp/<id>`; nothing half-written ever appears in `backups/`.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline, Transform, Writable } from 'node:stream'
import {
  BACKUP_FORMAT,
  type BackupFile,
  type BackupKind,
  type BackupManifest,
  type BackupManifestProject,
  type BackupSkipReason,
  backupIdFor,
} from '@spoor/shared'
import { asc, sql } from 'drizzle-orm'
import type { Logger } from 'pino'
import { projects } from '../../db/schema.js'
import type { Db } from '../../lib/db.js'
import { ApiError } from '../../lib/errors.js'
import type { ProjectRow } from '../projects/index.js'
import { buildExport } from '../transfer/index.js'
import {
  type BundleEntry,
  backupsDir,
  bundleDir,
  DIR_MODE,
  DUMP_FILE,
  FILE_MODE,
  freeBytes,
  fsyncPath,
  hashFile,
  MANIFEST_FILE,
  PROJECTS_DIR,
  readBundle,
  tmpBundleDir,
  writeManifest,
} from './catalog.js'
import { databaseMigration } from './migrations.js'
import { PgToolError, type PgTools } from './pgtools.js'

/** Tables whose rows are never in a dump (secrets that end with a restore anyway, and bulky telemetry). */
export const DUMP_EXCLUDED_TABLE_DATA = [
  'sessions',
  'device_codes',
  'request_log',
  'resource_samples',
] as const

export const DUMP_ARGS: readonly string[] = [
  '-Fc',
  '-Z6',
  '--no-owner',
  '--no-privileges',
  '-n',
  'public',
  '-n',
  'drizzle',
  '--lock-wait-timeout=60s',
  ...DUMP_EXCLUDED_TABLE_DATA.map((t) => `--exclude-table-data=public.${t}`),
]

/** Free space wanted on top of half the database size (the compressed dump is far smaller in practice). */
export const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024

export interface BundleWriterDeps {
  db: Db
  tools: PgTools
  logger: Logger
  /** `SPOOR_BACKUP_DIR`. */
  root: string
  version: string
}

export interface WriteBundleOptions {
  kind: BackupKind
  at: Date
  /** Write `projects/<slug>.zip` (setting `project_archives`); off = every project `skipped_reason: disabled`. */
  projectArchives: boolean
  signal?: AbortSignal
  /** Called between steps (the job renews its lease here). */
  onProgress?: () => Promise<void>
  /** `busy` retries per project archive (default 3) and the pause between them (default 2 s). */
  busyRetries?: number
  busyDelayMs?: number
  /** Overrides the preflight's free-space reading (tests). */
  freeBytes?: (path: string) => Promise<number | null>
}

export class BackupWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BackupWriteError'
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new BackupWriteError('backup aborted')
}

/** A writable that drops everything (pg_restore's script output when verifying). */
const nullSink = () =>
  new Writable({
    write(_chunk, _enc, cb) {
      cb()
    },
  })

/**
 * Stream the dump through `pg_restore -f -` (every TOC entry and data block decoded, output discarded) while
 * hashing exactly the bytes it read. Throws `PgToolError` when pg_restore cannot read it.
 */
export async function readDumpThroughPgRestore(
  tools: PgTools,
  path: string,
  signal?: AbortSignal,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256')
  let size = 0
  const tee = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length
      hash.update(chunk)
      cb(null, chunk)
    },
  })
  const input = pipeline(createReadStream(path), tee, () => {})
  await tools.run('pg_restore', ['-f', '-'], { stdin: input, stdout: nullSink(), signal })
  return { sha256: hash.digest('hex'), size }
}

/**
 * Check a bundle's files against its backup.json: presence, size, sha256, and pg_restore reading the dump.
 * One line per problem (`database.dump: sha256 mismatch`); empty = good.
 */
export async function verifyBundleFiles(
  tools: PgTools,
  dir: string,
  manifest: BackupManifest,
  signal?: AbortSignal,
): Promise<string[]> {
  const problems: string[] = []
  if (!manifest.files.some((f) => f.path === DUMP_FILE)) problems.push(`${DUMP_FILE}: not in backup.json`)
  for (const f of manifest.files) {
    const p = join(dir, f.path)
    if (!(await exists(p))) {
      problems.push(`${f.path}: missing`)
      continue
    }
    let got: { sha256: string; size: number }
    try {
      got = f.path === DUMP_FILE ? await readDumpThroughPgRestore(tools, p, signal) : await hashFile(p)
    } catch (err) {
      const why = err instanceof PgToolError ? err.message : 'unreadable'
      // A damaged dump may or may not trip pg_restore, depending on where the damage sits in the
      // compressed stream, so a changed file is always reported as such and pg_restore's error is extra.
      if (f.path === DUMP_FILE) {
        const raw = await hashFile(p).catch(() => null)
        if (raw && raw.size !== f.size) problems.push(`${f.path}: size mismatch`)
        else if (raw && raw.sha256 !== f.sha256) problems.push(`${f.path}: sha256 mismatch`)
      }
      problems.push(`${f.path}: ${f.path === DUMP_FILE ? `pg_restore cannot read it (${why})` : why}`)
      continue
    }
    if (got.size !== f.size) problems.push(`${f.path}: size mismatch`)
    else if (got.sha256 !== f.sha256) problems.push(`${f.path}: sha256 mismatch`)
  }
  return problems
}

interface ProjectWithCount extends ProjectRow {
  itemCount: number
}

async function listProjects(db: Db): Promise<ProjectWithCount[]> {
  const rows = await db.select().from(projects).orderBy(asc(projects.kind), asc(projects.slug))
  const counts = await db.execute<{ project_id: string; n: number }>(
    sql`SELECT project_id, count(*)::int AS n FROM items GROUP BY 1`,
  )
  const by = new Map(counts.rows.map((r) => [r.project_id, Number(r.n)]))
  return rows.map((r) => ({ ...r, itemCount: by.get(r.id) ?? 0 }))
}

const apiCode = (err: unknown) => (err instanceof ApiError ? err.code : null)

/** One project's archive, with the cap and busy retries; returns the bytes or why it was skipped. */
async function projectArchive(
  deps: BundleWriterDeps,
  project: ProjectRow,
  opts: WriteBundleOptions,
): Promise<{ zip: Uint8Array; history: boolean } | { skipped: BackupSkipReason; history: boolean }> {
  const retries = opts.busyRetries ?? 3
  const delay = opts.busyDelayMs ?? 2000
  let history = true
  for (let attempt = 0; ; ) {
    throwIfAborted(opts.signal)
    try {
      const res = await buildExport(deps.db, project, { history, version: deps.version, now: opts.at })
      return { zip: res.zip, history }
    } catch (err) {
      const code = apiCode(err)
      if (code === 'payload_too_large') {
        if (!history) return { skipped: 'too_large', history }
        history = false
        continue
      }
      if (code === 'busy') {
        if (attempt >= retries) return { skipped: 'busy', history }
        attempt++
        await sleep(delay, opts.signal)
        continue
      }
      deps.logger.warn(
        { project: project.slug, err: (err as Error).message },
        'backup: project archive failed',
      )
      return { skipped: 'error', history }
    }
  }
}

/** A start time whose id is not taken yet (two backups within one second get consecutive seconds). */
export async function pickBackupId(
  root: string,
  kind: BackupKind,
  at: Date,
): Promise<{ id: string; at: Date }> {
  let t = Math.floor(at.getTime() / 1000) * 1000
  for (let i = 0; i < 120; i++, t += 1000) {
    const id = backupIdFor(new Date(t), kind)
    if (!(await exists(bundleDir(root, id))) && !(await exists(tmpBundleDir(root, id)))) {
      return { id, at: new Date(t) }
    }
  }
  throw new BackupWriteError('no free backup id')
}

/** Write, verify and publish one bundle. Returns its catalog entry. */
export async function writeBundle(deps: BundleWriterDeps, opts: WriteBundleOptions): Promise<BundleEntry> {
  const { db, tools, root } = deps
  const { id, at } = await pickBackupId(root, opts.kind, opts.at)
  const tmp = tmpBundleDir(root, id)
  try {
    // 1. preflight
    const sizeRes = await db.execute<{ size: string }>(
      sql`SELECT pg_database_size(current_database())::text AS size`,
    )
    const dbSize = Number(sizeRes.rows[0]?.size ?? 0)
    const need = Math.ceil(dbSize / 2) + FREE_SPACE_MARGIN_BYTES
    const free = await (opts.freeBytes ?? freeBytes)(root)
    if (free !== null && free < need) {
      throw new BackupWriteError(
        `not enough free space in the backup directory: ${free} bytes free, ${need} wanted`,
      )
    }
    await mkdir(tmp, { recursive: true, mode: DIR_MODE })
    await mkdir(join(tmp, PROJECTS_DIR), { mode: DIR_MODE })

    const [serverRes, dumpVersion, migration] = await Promise.all([
      db.execute<{ v: string }>(sql`SELECT current_setting('server_version') AS v`),
      tools.version('pg_dump'),
      databaseMigration(db),
    ])

    // 2. the dump, streamed to the file
    throwIfAborted(opts.signal)
    const dumpPath = join(tmp, DUMP_FILE)
    await tools.run('pg_dump', DUMP_ARGS, {
      stdout: createWriteStream(dumpPath, { mode: FILE_MODE, flags: 'wx' }),
      signal: opts.signal,
    })
    await opts.onProgress?.()

    // 3. per-project archives
    const projectEntries: BackupManifestProject[] = []
    const written: { path: string; sha256: string; size: number }[] = []
    for (const p of await listProjects(db)) {
      const base = {
        id: p.id,
        slug: p.slug,
        name: p.name,
        kind: p.kind as 'project' | 'shared',
        items: p.itemCount,
      }
      if (!opts.projectArchives) {
        projectEntries.push({ ...base, archive: null, history: false, skipped_reason: 'disabled' })
        continue
      }
      const out = await projectArchive(deps, p, opts)
      if ('skipped' in out) {
        projectEntries.push({ ...base, archive: null, history: out.history, skipped_reason: out.skipped })
      } else {
        const rel = `${PROJECTS_DIR}/${p.slug}.zip`
        await writeFile(join(tmp, rel), out.zip, { mode: FILE_MODE, flag: 'wx' })
        written.push({
          path: rel,
          sha256: createHash('sha256').update(out.zip).digest('hex'),
          size: out.zip.length,
        })
        projectEntries.push({ ...base, archive: rel, history: out.history })
      }
      await opts.onProgress?.()
    }

    // 4. verify what is on disk
    throwIfAborted(opts.signal)
    let dump: { sha256: string; size: number }
    try {
      dump = await readDumpThroughPgRestore(tools, dumpPath, opts.signal)
    } catch (err) {
      throw new BackupWriteError(`verify failed: ${(err as Error).message}`, { cause: err })
    }
    const files: BackupFile[] = [{ path: DUMP_FILE, ...dump }]
    for (const w of written) {
      const got = await hashFile(join(tmp, w.path))
      if (got.sha256 !== w.sha256 || got.size !== w.size) {
        throw new BackupWriteError(`verify failed: ${w.path} does not match what was written`)
      }
      files.push({ path: w.path, sha256: w.sha256, size: w.size })
    }
    await opts.onProgress?.()

    // 5. manifest, fsync, publish
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      id,
      kind: opts.kind,
      created_at: at.toISOString(),
      spoor_version: deps.version,
      migration,
      pg_server_version: serverRes.rows[0]?.v ?? '',
      pg_dump_version: dumpVersion?.text ?? '',
      files,
      projects: projectEntries,
      pinned: false,
      verified_at: new Date().toISOString(),
    }
    for (const f of files) await fsyncPath(join(tmp, f.path))
    await fsyncPath(join(tmp, PROJECTS_DIR))
    await writeManifest(tmp, manifest)
    throwIfAborted(opts.signal)
    await rename(tmp, bundleDir(root, id))
    await fsyncPath(backupsDir(root))
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  const entry = await readBundle(root, id)
  if (!entry) throw new BackupWriteError(`${id}/${MANIFEST_FILE} is not readable after the rename`)
  return entry
}
