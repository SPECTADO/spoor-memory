/**
 * Async export tasks (ADR-0041, api.md section 13.4): the `export_tasks` store, an in-process runner and the
 * `exports` job.
 *
 * - `create` inserts a `queued` row (at most `EXPORT_TASKS_OPEN_MAX` open ones per user, counted under a
 *   per-user advisory lock) and nudges the runner.
 * - The runner (concurrency 1 per process) claims the oldest queued row with `FOR UPDATE SKIP LOCKED`, so
 *   several replicas never take the same task. While it works it renews `heartbeat_at`; a heartbeat that finds
 *   the row gone or no longer running cancels the work (`DELETE /exports/:id` from any replica).
 * - A task's source is loaded by a `ExportSourceLoader`: `live` is built in (`buildExport(history:false)` then
 *   `parseArchive`, holding the transfer flag only while `buildExport` reads); `backup` is registered by the
 *   backup module with `setSourceLoader('backup', …)`. Either way the result is a `ParsedArchive` that
 *   `markdownZip` turns into the file.
 * - Files: `<exports dir>/<id>.zip`, written as `<id>.zip.partial` (O_EXCL | O_NOFOLLOW), fsynced and renamed;
 *   a download opens the file O_NOFOLLOW and streams that handle. The exports dir is `<SPOOR_BACKUP_DIR>/exports`,
 *   else `os.tmpdir()/spoor-exports-<hash of the database's host, port and name>` (single replica only; one per
 *   database, so two instances on one host never sweep each other's files). It must be a real directory; the
 *   tmpdir one must also belong to this process's user and be closed to everyone else (0700), or nothing is
 *   written or served from it.
 * - Access is checked again where it matters: the runner checks that the requester may still export the project
 *   (a live source: `project.transfer`; a backup source: instance admin) before it reads anything, and `get` /
 *   `download` check it for anyone but an instance admin.
 * - The `exports` job (every minute): fails running rows whose heartbeat is older than 5 minutes, expires ready
 *   files after 24 hours, drops finished rows after 30 days, removes orphan files and safety archives older
 *   than 14 days, and nudges the runner when queued rows were left behind (a restart).
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EXPORT_READY_KEEP_HOURS,
  EXPORT_TASKS_OPEN_MAX,
  type ExportTaskJson,
  type ExportTaskListResponse,
  type ExportTaskResponse,
  type ExportTaskStatus,
  markdownZipFileName,
  SAFETY_ARCHIVE_KEEP_DAYS,
} from '@spoor/shared'
import { and, desc, eq, gt, inArray, lt, lte, type SQL, sql } from 'drizzle-orm'
import { exportTasks, memberships, projects, users } from '../../db/schema.js'
import { type DbOrTx, withTx } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError, loggableError } from '../../lib/errors.js'
import { can, type UserContext, webPrincipal } from '../auth/index.js'
import type { JobContext, JobStats } from '../jobs/index.js'
import type { ProjectAccess } from '../projects/index.js'
import { entryAllowed, type ParsedArchive, parseArchive } from './archive.js'
import { sha256Hex } from './canonical.js'
import { type MarkdownSource, markdownZip } from './markdown.js'
import type { TransferService } from './service.js'
import { readZip } from './zip.js'

export type ExportTaskRow = typeof exportTasks.$inferSelect

/** What a source loader hands the runner: the parsed export archive and the README's source line. */
export interface LoadedExportSource {
  parsed: ParsedArchive
  source: MarkdownSource
}

/**
 * Loads the archive of one task. `signal` fires when the task is cancelled or the server stops; a loader
 * checks it between slow steps. Throw an `ApiError` with a message for the user; anything else is logged and
 * shown as a generic failure.
 */
export type ExportSourceLoader = (task: ExportTaskRow, signal: AbortSignal) => Promise<LoadedExportSource>

/** Where a new task's archive comes from. */
export type ExportTaskSource =
  | { kind: 'live'; project: { id: string; slug: string } }
  | {
      kind: 'backup'
      backupId: string
      /** The project's id and slug inside the backup. */
      sourceProjectId: string
      sourceSlug: string
      /** The date in the file name (default: now). */
      fileDate?: Date
    }

export interface ExportTaskOptions {
  /** The directory of the files (default `<SPOOR_BACKUP_DIR>/exports`, else `os.tmpdir()/spoor-exports-<hash>`). */
  exportsDir?: string
  /** How often a running task renews `heartbeat_at` (default 30 s). */
  heartbeatMs?: number
  /** A running task whose heartbeat is older than this is failed by the job (default 5 min). */
  staleMs?: number
  /** `busy` (another import or export) retries of the live source, and their pause (default 10, 3 s). */
  busyRetries?: number
  busyDelayMs?: number
  /** Orphan files younger than this are left alone (a rename racing its row update; default 10 min). */
  orphanGraceMs?: number
  /** `false`: `create` and the job do not start the runner (tests drive `kick()` themselves). */
  autoRun?: boolean
  /** Clock of the file names and the file-age checks (tests). Row timestamps are the database's `now()`. */
  now?: () => Date
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
/** Finished rows (failed, expired) are dropped after this long. */
export const EXPORT_TASK_ROW_KEEP_DAYS = 30
/** `GET /projects/:slug/exports`: the last 7 days, at most 50 rows. */
const LIST_DAYS = 7
const LIST_MAX = 50
const OPEN: ExportTaskStatus[] = ['queued', 'running']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TASK_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.zip(\.partial)?$/
/** `safety-<slug>-<ts>.zip` of a project overwrite from a backup (api.md section 13.3). */
const SAFETY_FILE_RE = /^safety-.+\.zip$/
const FILE_NAME_RE = /^spoor-(.+)-markdown-\d{8}\.zip$/

const notFound = () => new ApiError('not_found', { message: 'No such export.' })
const noLongerAllowed = () =>
  new ApiError('forbidden', {
    message: 'You no longer have access to this project, so the export was not made.',
  })

/**
 * The fallback exports dir without SPOOR_BACKUP_DIR: in the shared tmpdir, one per database (host, port and
 * name; never the credentials), so two instances on one host keep apart.
 */
export function tmpExportsDir(databaseUrl: string): string {
  let key = databaseUrl
  try {
    const u = new URL(databaseUrl)
    key = `${u.hostname}:${u.port}${u.pathname}`
  } catch {
    // not a URL: hash it whole
  }
  return join(tmpdir(), `spoor-exports-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`)
}

/** The file of a task (`<id>.zip`) and its partial (`<id>.zip.partial`). Throws on anything but a uuid. */
export function taskFiles(dir: string, id: string): { final: string; partial: string } {
  if (!UUID_RE.test(id)) throw new Error(`not a task id: ${id.slice(0, 40)}`)
  return { final: join(dir, `${id}.zip`), partial: join(dir, `${id}.zip.partial`) }
}

async function unlinkQuiet(path: string): Promise<boolean> {
  try {
    await unlink(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

class Cancelled extends Error {
  constructor(readonly reason: 'cancelled' | 'shutdown') {
    super(reason)
    this.name = 'Cancelled'
  }
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new Cancelled(signal.reason === 'shutdown' ? 'shutdown' : 'cancelled')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Cancelled(signal.reason === 'shutdown' ? 'shutdown' : 'cancelled'))
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new Cancelled(signal.reason === 'shutdown' ? 'shutdown' : 'cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString())

export class ExportTaskService {
  readonly dir: string
  /** The dir is the tmpdir fallback: it must belong to this user and be 0700. */
  readonly #shared: boolean
  readonly #opts: Required<Omit<ExportTaskOptions, 'exportsDir'>>
  readonly #loaders = new Map<'live' | 'backup', ExportSourceLoader>()
  #current: { id: string; ac: AbortController } | null = null
  #loop: Promise<void> | null = null
  #again = false
  #stopping = false

  constructor(
    private readonly deps: ServerDeps,
    private readonly transfer: TransferService,
    opts: ExportTaskOptions = {},
  ) {
    const root = deps.config.SPOOR_BACKUP_DIR
    this.#shared = !opts.exportsDir && !root
    this.dir = opts.exportsDir ?? (root ? join(root, 'exports') : tmpExportsDir(deps.config.DATABASE_URL))
    this.#opts = {
      heartbeatMs: opts.heartbeatMs ?? 30_000,
      staleMs: opts.staleMs ?? 5 * MIN,
      busyRetries: opts.busyRetries ?? 10,
      busyDelayMs: opts.busyDelayMs ?? 3000,
      orphanGraceMs: opts.orphanGraceMs ?? 10 * MIN,
      autoRun: opts.autoRun ?? true,
      now: opts.now ?? (() => new Date()),
    }
    this.#loaders.set('live', (task, signal) => this.#loadLive(task, signal))
  }

  /** Register the loader of a source kind (the backup module: `'backup'`, reading `projects/<slug>.zip`). */
  setSourceLoader(kind: 'live' | 'backup', loader: ExportSourceLoader): void {
    this.#loaders.set(kind, loader)
  }

  // ---- store ------------------------------------------------------------------------------------------

  /** Insert a queued task for `ctx.user` (503 `too_many_pending` past the open cap) and start the runner. */
  async create(ctx: UserContext, src: ExportTaskSource): Promise<ExportTaskResponse> {
    const userId = ctx.user.id
    const fileName =
      src.kind === 'live'
        ? markdownZipFileName(src.project.slug, this.#opts.now())
        : markdownZipFileName(src.sourceSlug, src.fileDate ?? this.#opts.now())
    let staleIds: string[] = []
    const id = await withTx(this.deps.db, async (tx) => {
      // the open count and the insert under one per-user lock: two parallel POSTs cannot both be the third
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`spoor.export-tasks:${userId}`}))`)
      // this user's tasks a dead server left `running` do not count (the job fails them too, but it may be off)
      staleIds = (await this.#failStale(tx, eq(exportTasks.requestedBy, userId))).map((r) => r.id)
      const [open] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(exportTasks)
        .where(and(eq(exportTasks.requestedBy, userId), inArray(exportTasks.status, OPEN)))
      if ((open?.n ?? 0) >= EXPORT_TASKS_OPEN_MAX) {
        throw new ApiError('too_many_pending', {
          message: `You already have ${EXPORT_TASKS_OPEN_MAX} exports waiting or running.`,
          hint: 'Wait for one to finish, or delete one, then try again.',
        })
      }
      const [row] = await tx
        .insert(exportTasks)
        .values({
          format: 'markdown',
          requestedBy: userId,
          projectId: src.kind === 'live' ? src.project.id : null,
          backupId: src.kind === 'backup' ? src.backupId : null,
          sourceProjectId: src.kind === 'backup' ? src.sourceProjectId : null,
          fileName,
        })
        .returning({ id: exportTasks.id })
      return (row as { id: string }).id
    })
    for (const stale of staleIds) await this.#removeFiles(stale).catch(() => 0)
    if (this.#opts.autoRun) this.kick()
    return { task: await this.#json(id) }
  }

  /** `GET /projects/:slug/exports`: the project's live tasks of the last 7 days (IA: everyone's). */
  async listForProject(access: ProjectAccess): Promise<ExportTaskListResponse> {
    const where = [
      eq(exportTasks.projectId, access.project.id),
      sql`${exportTasks.backupId} IS NULL`,
      gt(exportTasks.createdAt, sql`now() - make_interval(days => ${LIST_DAYS})`),
    ]
    if (!access.ctx.user.isAdmin) where.push(eq(exportTasks.requestedBy, access.ctx.user.id))
    const rows = await this.#select()
      .where(and(...where))
      .orderBy(desc(exportTasks.createdAt), desc(exportTasks.id))
      .limit(LIST_MAX)
    return { items: rows.map(toJson) }
  }

  /** `GET /exports/:id`: the requester or an instance admin, else 404. */
  async get(ctx: UserContext, id: string): Promise<ExportTaskResponse> {
    const row = await this.#visible(ctx, id)
    // a task of a deleted project still shows its outcome to its requester (there is no content in it)
    if (!(await this.#mayExport(ctx.user, row, { projectGone: true }))) throw notFound()
    return { task: await this.#json(id) }
  }

  /** `DELETE /exports/:id`: the row and its file; a running task is cancelled. */
  async remove(ctx: UserContext, id: string): Promise<void> {
    await this.#visible(ctx, id)
    await this.deps.db.delete(exportTasks).where(eq(exportTasks.id, id))
    // this process: stop now; another replica notices at its next heartbeat
    if (this.#current?.id === id) this.#current.ac.abort('cancelled')
    await this.#removeFiles(id)
  }

  /**
   * `GET /exports/:id/download`: the ready file, opened (never through a symlink) for the caller to stream and
   * close, or 404. The caller must still be allowed to export the project.
   */
  async download(
    ctx: UserContext,
    id: string,
  ): Promise<{ handle: FileHandle; fileName: string; sizeBytes: number }> {
    const row = await this.#visible(ctx, id)
    if (!(await this.#mayExport(ctx.user, row, { projectGone: false }))) throw notFound()
    if (row.status !== 'ready') throw new ApiError('not_found', { message: 'The export is not ready.' })
    const { final } = taskFiles(this.dir, id)
    let handle: FileHandle | null = null
    try {
      await this.ensureDir({ create: false })
      handle = await open(final, constants.O_RDONLY | constants.O_NOFOLLOW)
      const s = await handle.stat()
      if (!s.isFile()) throw new Error('not a file')
      return { handle, fileName: row.fileName ?? `${id}.zip`, sizeBytes: s.size }
    } catch {
      await handle?.close().catch(() => {})
      throw new ApiError('not_found', {
        message: 'The export file is gone.',
        hint: 'Prepare the Markdown zip again.',
      })
    }
  }

  /**
   * The exports dir, created 0700 when missing. Refused (throws) unless it is a real directory (not a symlink);
   * the tmpdir fallback must also belong to this process's user and be closed to group and others.
   */
  async ensureDir(opts: { create?: boolean } = {}): Promise<string> {
    if (opts.create !== false) await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const s = await lstat(this.dir)
    if (!s.isDirectory()) throw new Error(`the exports dir ${this.dir} is not a directory`)
    if (this.#shared) {
      const uid = process.getuid?.()
      if ((uid !== undefined && s.uid !== uid) || (s.mode & 0o077) !== 0) {
        throw new Error(`the exports dir ${this.dir} is not this user's alone (owner and mode 0700 needed)`)
      }
    }
    return this.dir
  }

  /**
   * May `user` (still) have this task's file? A backup source: instance admins only. A live source:
   * `project.transfer` on the project; a project that is gone: `projectGone`.
   */
  async #mayExport(
    user: { id: string; isAdmin: boolean; sharedEditor: boolean },
    row: ExportTaskRow,
    opts: { projectGone: boolean },
  ): Promise<boolean> {
    if (user.isAdmin) return true
    if (row.backupId !== null) return false
    if (row.projectId === null) return opts.projectGone
    const [r] = await this.deps.db
      .select({ kind: projects.kind, role: memberships.role, lib: memberships.libraryEditor })
      .from(projects)
      .leftJoin(memberships, and(eq(memberships.projectId, projects.id), eq(memberships.userId, user.id)))
      .where(eq(projects.id, row.projectId))
      .limit(1)
    if (!r) return opts.projectGone
    const shared = r.kind === 'shared'
    const principal = webPrincipal(user, shared ? null : (r.role ?? null), r.lib === true)
    return can(principal, 'project.transfer', { shared })
  }

  /** The requester of a task as it is now (null: gone or disabled). */
  async #requester(row: ExportTaskRow) {
    const [u] = await this.deps.db
      .select({
        id: users.id,
        isAdmin: users.isAdmin,
        sharedEditor: users.sharedEditor,
        disabledAt: users.disabledAt,
      })
      .from(users)
      .where(eq(users.id, row.requestedBy))
      .limit(1)
    return u && u.disabledAt === null ? u : null
  }

  #select() {
    return this.deps.db
      .select({
        t: exportTasks,
        pId: projects.id,
        pSlug: projects.slug,
        pName: projects.name,
        email: users.email,
      })
      .from(exportTasks)
      .leftJoin(projects, eq(projects.id, exportTasks.projectId))
      .innerJoin(users, eq(users.id, exportTasks.requestedBy))
      .$dynamic()
  }

  async #json(id: string): Promise<ExportTaskJson> {
    const [row] = await this.#select().where(eq(exportTasks.id, id)).limit(1)
    if (!row) throw notFound()
    return toJson(row)
  }

  async #visible(ctx: UserContext, id: string): Promise<ExportTaskRow> {
    if (!UUID_RE.test(id)) throw notFound()
    const [row] = await this.deps.db.select().from(exportTasks).where(eq(exportTasks.id, id)).limit(1)
    if (!row || (!ctx.user.isAdmin && row.requestedBy !== ctx.user.id)) throw notFound()
    return row
  }

  async #removeFiles(id: string): Promise<number> {
    const { final, partial } = taskFiles(this.dir, id)
    let n = 0
    for (const p of [final, partial]) if (await unlinkQuiet(p)) n++
    return n
  }

  // ---- runner -----------------------------------------------------------------------------------------

  /** Start the runner if it is not running (it drains every queued task, one at a time). */
  kick(): void {
    if (this.#stopping) return
    if (this.#loop) {
      this.#again = true
      return
    }
    this.#loop = this.#drain()
      .catch((err) => this.deps.logger.error({ err: loggableError(err) }, 'export task runner failed'))
      .finally(() => {
        this.#loop = null
        if (this.#again) {
          this.#again = false
          this.kick()
        }
      })
  }

  /** Resolves once the runner has nothing left to do (tests). */
  async idle(): Promise<void> {
    while (this.#loop) await this.#loop
  }

  /** Graceful shutdown: abort the running task (it goes back to `queued` for the next start) and wait. */
  async stop(): Promise<void> {
    this.#stopping = true
    this.#current?.ac.abort('shutdown')
    await this.idle()
  }

  /** Run again after `stop()` (a full restore stops the runner while it replaces the database, ADR-0039). */
  resume(): void {
    this.#stopping = false
    this.kick()
  }

  async #drain(): Promise<void> {
    while (!this.#stopping) {
      const task = await this.#claim()
      if (!task) return
      await this.#process(task)
    }
  }

  async #claim(): Promise<ExportTaskRow | null> {
    const db = this.deps.db
    const next = db
      .select({ id: exportTasks.id })
      .from(exportTasks)
      .where(eq(exportTasks.status, 'queued'))
      .orderBy(exportTasks.createdAt, exportTasks.id)
      .limit(1)
      .for('update', { skipLocked: true })
    const [row] = await db
      .update(exportTasks)
      .set({ status: 'running', heartbeatAt: sql`now()`, error: null })
      .where(and(inArray(exportTasks.id, next), eq(exportTasks.status, 'queued')))
      .returning()
    return row ?? null
  }

  async #process(task: ExportTaskRow): Promise<void> {
    const db = this.deps.db
    const ac = new AbortController()
    this.#current = { id: task.id, ac }
    const log = this.deps.logger.child({ export_task: task.id })
    const beat = setInterval(() => {
      db.update(exportTasks)
        .set({ heartbeatAt: sql`now()` })
        .where(and(eq(exportTasks.id, task.id), eq(exportTasks.status, 'running')))
        .returning({ id: exportTasks.id })
        .then((r) => {
          // deleted (DELETE /exports/:id on any replica) or failed by the job: stop
          if (r.length === 0) ac.abort('cancelled')
        })
        .catch((err) => log.warn({ err: loggableError(err) }, 'export task heartbeat failed'))
    }, this.#opts.heartbeatMs)
    beat.unref?.()
    try {
      const kind = task.backupId === null ? 'live' : 'backup'
      const loader = this.#loaders.get(kind)
      if (!loader)
        throw new ApiError('internal', { message: `Exports from a ${kind} source are not available.` })
      // the requester may have lost access since the task was queued: nothing is read for them then
      const requester = await this.#requester(task)
      // (a deleted project: the loader says so)
      if (!requester || !(await this.#mayExport(requester, task, { projectGone: true })))
        throw noLongerAllowed()
      const { parsed, source } = await loader(task, ac.signal)
      checkSignal(ac.signal)
      const md = markdownZip(parsed, source, { now: this.#opts.now() })
      checkSignal(ac.signal)
      const { size, sha256 } = await this.#writeFile(task.id, md.zip)
      checkSignal(ac.signal)
      const done = await db
        .update(exportTasks)
        .set({
          status: 'ready',
          sizeBytes: size,
          sha256,
          heartbeatAt: sql`now()`,
          finishedAt: sql`now()`,
          expiresAt: sql`now() + make_interval(hours => ${EXPORT_READY_KEEP_HOURS})`,
        })
        .where(and(eq(exportTasks.id, task.id), eq(exportTasks.status, 'running')))
        .returning({ id: exportTasks.id })
      // the row went away while the file was written: the file must not outlive it
      if (done.length === 0) await this.#removeFiles(task.id)
    } catch (err) {
      await this.#removeFiles(task.id).catch(() => 0)
      if (err instanceof Cancelled || ac.signal.aborted) {
        if (ac.signal.reason === 'shutdown') {
          // back to the queue: the next start (or another replica) does it again
          await db
            .update(exportTasks)
            .set({ status: 'queued', heartbeatAt: null })
            .where(and(eq(exportTasks.id, task.id), eq(exportTasks.status, 'running')))
            .catch(() => {})
        }
        return
      }
      const message =
        err instanceof ApiError && err.publicMessage
          ? err.publicMessage
          : 'The export failed. Try again; if it keeps failing, ask an instance admin to check the server log.'
      if (!(err instanceof ApiError)) log.error({ err: loggableError(err) }, 'export task failed')
      else log.warn({ code: err.code }, 'export task failed')
      await db
        .update(exportTasks)
        .set({ status: 'failed', error: message.slice(0, 500), finishedAt: sql`now()` })
        .where(and(eq(exportTasks.id, task.id), eq(exportTasks.status, 'running')))
        .catch((e) => log.error({ err: loggableError(e) }, 'export task: could not record the failure'))
    } finally {
      clearInterval(beat)
      this.#current = null
    }
  }

  /** The live source: an export without history (retrying `busy`), parsed like an uploaded archive. */
  async #loadLive(task: ExportTaskRow, signal: AbortSignal): Promise<LoadedExportSource> {
    if (task.projectId === null) throw new ApiError('not_found', { message: 'The project was deleted.' })
    const [project] = await this.deps.db
      .select()
      .from(projects)
      .where(eq(projects.id, task.projectId))
      .limit(1)
    if (!project) throw new ApiError('not_found', { message: 'The project was deleted.' })
    for (let attempt = 0; ; attempt++) {
      checkSignal(signal)
      try {
        const result = await this.transfer.exportForTask(project)
        checkSignal(signal)
        return { parsed: parseArchive(readZip(result.zip, entryAllowed)), source: { kind: 'live' } }
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'busy') || attempt >= this.#opts.busyRetries) {
          if (err instanceof ApiError && err.code === 'busy') {
            throw new ApiError('busy', {
              message:
                'Other imports or exports kept the instance busy; prepare the Markdown zip again later.',
            })
          }
          throw err
        }
        await sleep(this.#opts.busyDelayMs, signal)
      }
    }
  }

  async #writeFile(id: string, bytes: Uint8Array): Promise<{ size: number; sha256: string }> {
    await this.ensureDir()
    const { final, partial } = taskFiles(this.dir, id)
    // a stale partial (a crash) goes first; then a new file only, never through a planted link
    await unlinkQuiet(partial)
    const fh = await open(
      partial,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await fh.writeFile(bytes)
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(partial, final)
    return { size: bytes.length, sha256: sha256Hex(bytes) }
  }

  // ---- the `exports` job --------------------------------------------------------------------------------

  async jobHandler(ctx: JobContext): Promise<JobStats> {
    const db = this.deps.db

    // 1. running rows nobody renews (the server died): failed
    const stale = await this.#failStale(db)
    for (const r of stale) await this.#removeFiles(r.id)

    // 2. ready files older than 24 h: deleted, the row says expired
    const expired = await db
      .update(exportTasks)
      .set({ status: 'expired' })
      .where(and(eq(exportTasks.status, 'ready'), lte(exportTasks.expiresAt, sql`now()`)))
      .returning({ id: exportTasks.id })
    for (const r of expired) await this.#removeFiles(r.id)

    // 3. finished rows are history only for a while
    const pruned = await db
      .delete(exportTasks)
      .where(
        and(
          inArray(exportTasks.status, ['failed', 'expired']),
          lt(exportTasks.createdAt, sql`now() - make_interval(days => ${EXPORT_TASK_ROW_KEEP_DAYS})`),
        ),
      )
      .returning({ id: exportTasks.id })

    // 4. files: orphans of deleted rows, and safety archives past their 14 days
    const files = await this.#sweepFiles()

    // 5. queued rows left by a restart (or created on a replica that went away)
    const [queued] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(exportTasks)
      .where(eq(exportTasks.status, 'queued'))
    const waiting = queued?.n ?? 0
    if (waiting > 0 && this.#opts.autoRun) this.kick()

    const stats = {
      stale: stale.length,
      expired: expired.length,
      pruned: pruned.length,
      orphan_files: files.orphans,
      safety_archives: files.safety,
      queued: waiting,
    }
    if (Object.values(stats).some((n) => n > 0)) await ctx.markWork()
    return stats
  }

  /** Running rows whose heartbeat is older than `staleMs` (never this process's own task): failed. */
  #failStale(db: DbOrTx, extra?: SQL) {
    const own = this.#current?.id ?? null
    const staleS = Math.max(1, Math.round(this.#opts.staleMs / 1000))
    return db
      .update(exportTasks)
      .set({
        status: 'failed',
        error: 'The export stopped unexpectedly (the server restarted?). Prepare it again.',
        finishedAt: sql`now()`,
      })
      .where(
        and(
          eq(exportTasks.status, 'running'),
          sql`coalesce(${exportTasks.heartbeatAt}, ${exportTasks.createdAt}) < now() - make_interval(secs => ${staleS})`,
          own === null ? sql`true` : sql`${exportTasks.id} <> ${own}`,
          extra ?? sql`true`,
        ),
      )
      .returning({ id: exportTasks.id })
  }

  async #sweepFiles(): Promise<{ orphans: number; safety: number }> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { orphans: 0, safety: 0 }
      throw err
    }
    const nowMs = this.#opts.now().getTime()
    const ageOf = async (name: string): Promise<number | null> => {
      try {
        const s = await lstat(join(this.dir, name))
        return s.isFile() ? nowMs - s.mtimeMs : null
      } catch {
        return null
      }
    }
    let safety = 0
    const taskFilesByName = new Map<string, string>()
    for (const name of names) {
      const m = TASK_FILE_RE.exec(name)
      if (m) {
        taskFilesByName.set(name, m[1] as string)
        continue
      }
      if (SAFETY_FILE_RE.test(name)) {
        const age = await ageOf(name)
        if (age !== null && age > SAFETY_ARCHIVE_KEEP_DAYS * DAY && (await unlinkQuiet(join(this.dir, name))))
          safety++
      }
    }
    let orphans = 0
    const ids = [...new Set(taskFilesByName.values())]
    if (ids.length > 0) {
      const live = new Set(
        (
          await this.deps.db
            .select({ id: exportTasks.id })
            .from(exportTasks)
            .where(
              and(inArray(exportTasks.id, ids), inArray(exportTasks.status, ['queued', 'running', 'ready'])),
            )
        ).map((r) => r.id),
      )
      for (const [name, id] of taskFilesByName) {
        if (live.has(id) || id === this.#current?.id) continue
        const age = await ageOf(name)
        if (age !== null && age > this.#opts.orphanGraceMs && (await unlinkQuiet(join(this.dir, name))))
          orphans++
      }
    }
    return { orphans, safety }
  }
}

type SelectedRow = {
  t: ExportTaskRow
  pId: string | null
  pSlug: string | null
  pName: string | null
  email: string
}

function toJson(r: SelectedRow): ExportTaskJson {
  const t = r.t
  const backup = t.backupId !== null
  const sourceSlug = t.fileName ? (FILE_NAME_RE.exec(t.fileName)?.[1] ?? null) : null
  return {
    id: t.id,
    format: t.format,
    status: t.status,
    source: backup ? 'backup' : 'live',
    project:
      !backup && r.pId !== null && r.pSlug !== null && r.pName !== null
        ? { id: r.pId, slug: r.pSlug, name: r.pName }
        : null,
    backup_id: t.backupId,
    source_project:
      backup && t.sourceProjectId !== null ? { id: t.sourceProjectId, slug: sourceSlug ?? '' } : null,
    requested_by: { id: t.requestedBy, label: r.email },
    file_name: t.fileName,
    size_bytes: t.sizeBytes,
    sha256: t.sha256,
    error: t.error,
    created_at: t.createdAt.toISOString(),
    finished_at: iso(t.finishedAt),
    expires_at: iso(t.expiresAt),
    download_url: t.status === 'ready' ? `/api/v1/exports/${t.id}/download` : null,
  }
}
