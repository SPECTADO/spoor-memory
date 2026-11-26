/**
 * One project from a backup (api.md section 13.3, ADR-0038): restore it as a new copy or over the live
 * project, or make a Markdown zip of it. Everything reads the bundle's `projects/<slug>.zip` (its sha256 is
 * checked first) through the transfer module's zip reader, parser and importer; the pg dump is never parsed.
 *
 * - `new`: a new project with new ids, slug and name from the request or the `restoredCopySlug` /
 *   `restoredCopyName` defaults, `projects.restored_from` set (the "Restored copy" banner) and the restoring
 *   admin its only member. A `_shared` archive becomes an ordinary project.
 * - `overwrite`: the admin's password and the typed live slug; the live project must exist with the same id and
 *   must not be `_shared`. A safety archive of the project as it is goes to `<exports dir>/safety-<slug>-<ts>.zip`
 *   (the `exports` job deletes it after 14 days), then ONE transaction takes the transfer lock, locks the project
 *   row and its items (no writer gets in from here on), checks that the project has not changed since the safety
 *   archive was read (else 503 `busy`, nothing changed: a write in between would be in neither archive), allows
 *   the purge, deletes the project's items (revisions, chunks, edges and duplicate pairs cascade) and imports the
 *   archive with its original ids. The project row, memberships, tokens, settings and the project's
 *   audit rows stay. Any failure rolls the whole transaction back: the project is as it was.
 *
 * Both restores run under the heavy lock (one backup operation at a time, lock.ts) and the transfer flag (one
 * import or export at a time); either taken is 503 `busy`. Audited `project.restore`.
 */
import { createHash } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type BackupManifest,
  type BackupManifestProject,
  type ProjectRestoreRequest,
  type ProjectRestoreResponse,
  type RestoredFromJson,
  restoredCopyName,
  restoredCopySlug,
  SAFETY_ARCHIVE_KEEP_DAYS,
} from '@spoor/shared'
import { eq, sql } from 'drizzle-orm'
import { items, memberships, projects, users } from '../../db/schema.js'
import { webActor, writeAudit } from '../../lib/audit.js'
import { allowPurge, type DbOrTx, withTx } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError } from '../../lib/errors.js'
import { VERSION } from '../../version.js'
import { PasswordHasher, type UserContext } from '../auth/index.js'
import type { ProjectRow } from '../projects/index.js'
import {
  buildExport,
  type ExportResult,
  type ExportSourceLoader,
  type ExportTaskService,
  entryAllowed,
  importArchive,
  type LosslessArchive,
  parseArchive,
  readZip,
  type TransferService,
  takeTransferLock,
} from '../transfer/index.js'
import type { BundleEntry } from './catalog.js'
import { type BackupService, uniqueCopySlug } from './service.js'

/** The transfer module parts this needs (app.ts passes `createTransferModule(...)`). */
export interface ProjectRestoreTransfer {
  transfer: TransferService
  exportTasks: ExportTaskService
}

const SAFETY_FILE_MODE = 0o600

const projectNotInBackup = () => new ApiError('not_found', { message: 'That project is not in this backup.' })

const confirmationFailed = () =>
  new ApiError('confirmation_failed', {
    message: 'The password or the typed project slug is wrong.',
    hint: 'Type the live project slug exactly and your own password.',
  })

const badArchive = (message: string) =>
  new ApiError('invalid_archive', { message, details: { issues: [{ message }] } })

/** `safety-<slug>-<YYYYMMDDTHHMMSSmmmZ>.zip` (the slug pattern keeps it a plain file name). */
export function safetyArchiveName(slug: string, at: Date): string {
  const ts = at.toISOString().replace(/[-:]/g, '').replace('.', '')
  return `safety-${slug}-${ts}.zip`
}

export interface ProjectRestoreOptions {
  /** Called after the safety archive is written, before the overwrite transaction (tests write here). */
  afterSafetyArchive?: () => Promise<void> | void
}

/**
 * What a safety archive captures of a project's items and edges, as one hash: ids, revisions, `updated_at`
 * and edge targets. Equal before the safety archive and under the overwrite transaction's locks = nothing was
 * written in between.
 */
export async function projectFingerprint(db: DbOrTx, projectId: string): Promise<string> {
  const res = await db.execute<{ f: string }>(
    sql`SELECT md5(
          coalesce((SELECT string_agg(id::text || ':' || revision || ':' || (to_json(updated_at)#>>'{}'), ',' ORDER BY id)
                      FROM items WHERE project_id = ${projectId}), '')
          || '|' ||
          coalesce((SELECT string_agg(id::text || ':' || coalesce(dst_id::text, '-') || ':' || dst_ref, ',' ORDER BY id)
                      FROM edges WHERE project_id = ${projectId}), '')
        ) AS f`,
  )
  return String(res.rows[0]?.f ?? '')
}

export class ProjectRestoreService {
  readonly #hasher = new PasswordHasher()

  constructor(
    private readonly deps: ServerDeps,
    private readonly backup: BackupService,
    private readonly transfer: ProjectRestoreTransfer,
    private readonly opts: ProjectRestoreOptions = {},
  ) {}

  // ---- reading an archive ----------------------------------------------------------------------------------

  /** The manifest entry of `projectId`; 404 when absent, 404 with `details.skipped_reason` when not archived. */
  #archivedProject(manifest: BackupManifest, projectId: string): BackupManifestProject & { archive: string } {
    const p = manifest.projects.find((x) => x.id === projectId)
    if (!p) throw projectNotInBackup()
    if (p.archive === null) {
      throw new ApiError('not_found', {
        message:
          'This project has no archive of its own in the backup: not restorable per project; use full restore.',
        hint: 'Restore the whole backup instead.',
        details: { skipped_reason: p.skipped_reason ?? null },
      })
    }
    return p as BackupManifestProject & { archive: string }
  }

  /**
   * Read `projects/<slug>.zip` of a bundle: size and sha256 must match backup.json (422 `invalid_archive`
   * otherwise), then the zip reader and parser of the transfer module. Only a lossless archive of that very
   * project is accepted.
   */
  async readArchive(
    entry: BundleEntry,
    projectId: string,
  ): Promise<{ project: BackupManifestProject; parsed: LosslessArchive }> {
    const project = this.#archivedProject(entry.manifest, projectId)
    const file = entry.manifest.files.find((f) => f.path === project.archive)
    if (!file) throw badArchive(`backup.json does not list ${project.archive}.`)
    let bytes: Buffer
    try {
      bytes = await readFile(join(entry.dir, project.archive))
    } catch {
      throw badArchive(`${project.archive} is missing from the backup.`)
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== file.size || sha256 !== file.sha256) {
      throw badArchive(`${project.archive} does not match its checksum in backup.json.`)
    }
    const parsed = parseArchive(readZip(bytes, entryAllowed))
    if (parsed.kind !== 'lossless' || parsed.manifest.project.id !== projectId) {
      throw badArchive(`${project.archive} is not the export of this project.`)
    }
    return { project, parsed }
  }

  /** The `backup` source of export tasks (registered with `exportTasks.setSourceLoader('backup', …)`). */
  readonly exportSourceLoader: ExportSourceLoader = async (task, signal) => {
    const backupId = task.backupId
    const projectId = task.sourceProjectId
    if (!backupId || !projectId)
      throw new ApiError('not_found', { message: 'The export has no backup source.' })
    let entry: BundleEntry
    try {
      entry = (await this.backup.bundleOr404(backupId)).entry
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_found') {
        throw new ApiError('not_found', { message: `The backup ${backupId} is gone.` })
      }
      throw err
    }
    signal.throwIfAborted()
    const { parsed } = await this.readArchive(entry, projectId)
    return { parsed, source: { kind: 'backup', backupId, backupCreatedAt: entry.manifest.created_at } }
  }

  // ---- export task --------------------------------------------------------------------------------------

  /** `POST /backups/:id/projects/:projectId/exports`: a queued Markdown zip of the project's archive. */
  async createExport(ctx: UserContext, backupId: string, projectId: string) {
    const { entry } = await this.backup.bundleOr404(backupId)
    const p = this.#archivedProject(entry.manifest, projectId)
    return this.transfer.exportTasks.create(ctx, {
      kind: 'backup',
      backupId: entry.id,
      sourceProjectId: p.id,
      sourceSlug: p.slug,
    })
  }

  // ---- restore -------------------------------------------------------------------------------------------

  /** `POST /backups/:id/projects/:projectId/restore`. */
  async restore(
    ctx: UserContext,
    backupId: string,
    projectId: string,
    req: ProjectRestoreRequest,
  ): Promise<ProjectRestoreResponse> {
    const { entry } = await this.backup.bundleOr404(backupId)
    const mode = req.mode ?? 'new'
    const p = this.#archivedProject(entry.manifest, projectId)
    let live: ProjectRow | null = null
    if (mode === 'overwrite') {
      if (p.kind === 'shared') {
        throw new ApiError('forbidden', {
          message: 'The shared space cannot be overwritten from a backup.',
          hint: 'Restore it as a copy, or restore the whole backup.',
        })
      }
      const [row] = await this.deps.db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
      if (!row) {
        throw new ApiError('not_found', {
          message: 'No live project has this id any more.',
          hint: 'Restore it as a copy instead.',
        })
      }
      if (row.kind === 'shared')
        throw new ApiError('forbidden', { message: 'The shared space cannot be overwritten.' })
      if (req.confirm !== row.slug) throw confirmationFailed()
      if (!(await this.#passwordOk(ctx, req.password ?? ''))) throw confirmationFailed()
      live = row
    }
    // checks that need no lock come first: a corrupt archive never takes a lock
    const { parsed } = await this.readArchive(entry, projectId)
    const held = await this.backup.lock.acquire({
      operation: 'restore',
      backup_id: entry.id,
      kind: entry.manifest.kind,
      started_at: this.backup.now().toISOString(),
    })
    try {
      const outcome = await this.transfer.transfer.exclusive(() =>
        live
          ? this.#overwrite(ctx, entry, p, live, parsed)
          : this.#asCopy(ctx, entry, p, parsed, { slug: req.slug, name: req.name }),
      )
      // chunk rows were written with NULL embeddings in the transaction; embed-pending fills them
      this.deps.ports.jobs.enqueue('embed-pending', { projectId: outcome.project.id })
      return outcome
    } finally {
      await held.release()
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

  async #asCopy(
    ctx: UserContext,
    entry: BundleEntry,
    p: BackupManifestProject,
    parsed: LosslessArchive,
    want: { slug?: string; name?: string },
  ): Promise<ProjectRestoreResponse> {
    const backupAt = new Date(entry.manifest.created_at)
    const slug = want.slug ?? (await uniqueCopySlug(this.deps.db, restoredCopySlug(p.slug, backupAt)))
    const name = want.name ?? restoredCopyName(p.name, backupAt)
    const restoredFrom: RestoredFromJson = {
      backup_id: entry.id,
      source_slug: p.slug,
      restored_at: this.backup.now().toISOString(),
    }
    return withTx(this.deps.db, async (tx) => {
      await takeTransferLock(tx)
      const outcome = await importArchive(this.deps, {
        parsed,
        target: { kind: 'new', slug, name },
        remapIds: true,
        importer: ctx,
        tx,
        sharedAsProject: true,
      })
      const projectId = outcome.projectId
      await tx.update(projects).set({ restoredFrom }).where(eq(projects.id, projectId))
      // the restoring admin is the copy's only member
      await tx
        .insert(memberships)
        .values({ projectId, userId: ctx.user.id, role: 'admin', libraryEditor: false })
        .onConflictDoNothing()
      await writeAudit(tx, webActor(ctx), {
        projectId,
        action: 'project.restore',
        summary: `${ctx.user.email} restored ${p.slug} from backup ${entry.id} as a copy (${slug})`,
        data: {
          mode: 'new',
          backup_id: entry.id,
          source_project_id: p.id,
          source_slug: p.slug,
          counts: outcome.response.counts,
        },
      })
      return {
        mode: 'new' as const,
        project: { id: projectId, slug, name },
        counts: outcome.response.counts,
        safety_archive: null,
        restored_from: restoredFrom,
        notes: [
          ...outcome.response.notes,
          'This is a restored copy: delete it when you are done.',
          ...historyNote(parsed),
        ],
      }
    })
  }

  async #overwrite(
    ctx: UserContext,
    entry: BundleEntry,
    p: BackupManifestProject,
    live: ProjectRow,
    parsed: LosslessArchive,
  ): Promise<ProjectRestoreResponse> {
    // taken before the safety archive is read; compared again under the transaction's locks
    const fingerprint = await projectFingerprint(this.deps.db, live.id)
    const safety = await this.#writeSafetyArchive(live)
    // the project is untouched when the transaction fails, so the safety copy is not needed then
    const outcome = await (async () => {
      await this.opts.afterSafetyArchive?.()
      return this.#overwriteTx(ctx, entry, p, live, parsed, safety.name, fingerprint)
    })().catch(async (err) => {
      await unlink(safety.path).catch(() => {})
      throw err
    })
    return {
      mode: 'overwrite',
      project: { id: outcome.row.id, slug: outcome.row.slug, name: outcome.row.name },
      counts: outcome.imported.response.counts,
      safety_archive: safety.name,
      restored_from: null,
      notes: [
        ...outcome.imported.response.notes,
        `The project as it was is saved as ${safety.name} for ${SAFETY_ARCHIVE_KEEP_DAYS} days.`,
        ...historyNote(parsed),
      ],
    }
  }

  #overwriteTx(
    ctx: UserContext,
    entry: BundleEntry,
    p: BackupManifestProject,
    live: ProjectRow,
    parsed: LosslessArchive,
    safetyName: string,
    fingerprint: string,
  ) {
    return withTx(this.deps.db, async (tx) => {
      await takeTransferLock(tx)
      // the project row (blocks new items and edges through their foreign keys) and its items (blocks updates)
      const [row] = await tx.select().from(projects).where(eq(projects.id, live.id)).for('update')
      if (!row) throw new ApiError('not_found', { message: 'No live project has this id any more.' })
      if (row.kind === 'shared')
        throw new ApiError('forbidden', { message: 'The shared space cannot be overwritten.' })
      await tx.execute(sql`SELECT id FROM items WHERE project_id = ${row.id} FOR UPDATE`)
      if ((await projectFingerprint(tx, row.id)) !== fingerprint) {
        throw new ApiError('busy', {
          message: 'The project changed while its safety archive was written; nothing was overwritten.',
          hint: 'Try again.',
        })
      }
      await allowPurge(tx)
      // revisions, chunks, edges (by source) and duplicate pairs cascade; inbound edges only come from the
      // project itself (the edge scope trigger), so nothing outside the project points at these items
      await tx.delete(items).where(eq(items.projectId, row.id))
      const imported = await importArchive(this.deps, {
        parsed,
        target: { kind: 'existing', project: row },
        remapIds: false,
        importer: ctx,
        tx,
        keepAudit: true,
      })
      await writeAudit(tx, webActor(ctx), {
        projectId: row.id,
        action: 'project.restore',
        summary: `${ctx.user.email} overwrote ${row.slug} from backup ${entry.id}`,
        data: {
          mode: 'overwrite',
          backup_id: entry.id,
          source_slug: p.slug,
          safety_archive: safetyName,
          counts: imported.response.counts,
        },
      })
      return { row, imported }
    })
  }

  /**
   * The project as it is now, as a lossless export (with history; over the size cap without), written to
   * `<exports dir>/safety-<slug>-<ts>.zip` (0600). Returns the file name (also kept in the audit row).
   */
  async #writeSafetyArchive(project: ProjectRow): Promise<{ name: string; path: string }> {
    let res: ExportResult
    try {
      res = await buildExport(this.deps.db, project, { history: true, version: VERSION })
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'payload_too_large')) throw err
      res = await buildExport(this.deps.db, project, { history: false, version: VERSION })
    }
    // created 0700; refused when it is a link, or the tmpdir fallback is not this user's alone
    const dir = await this.transfer.exportTasks.ensureDir()
    const name = safetyArchiveName(project.slug, this.backup.now())
    const path = join(dir, name)
    await writeFile(path, res.zip, { mode: SAFETY_FILE_MODE, flag: 'wx' })
    return { name, path }
  }
}

function historyNote(parsed: LosslessArchive): string[] {
  return parsed.manifest.history
    ? []
    : ['The archive in this backup has no history: only the latest revision of each item was restored.']
}
