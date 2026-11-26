/**
 * The backup service (api.md section 13.1, ADR-0038, ADR-0040): availability, the list with its status,
 * settings, manual backups, pin, delete, verify, the projects of a bundle, the scheduled `backup` job and
 * pruning. Full restore and single-project restore build on `runBackup`, `lock`, `requireAvailable` and the
 * catalog (restore.ts).
 *
 * Availability: `SPOOR_BACKUP_DIR` set and writable, pg_dump / pg_restore / psql found and not older (major)
 * than the server. Otherwise the list and the settings still work, everything else is 409
 * `backups_unavailable` with `details.reason`, and the app runs as before.
 */
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import {
  type BackupItemJson,
  type BackupKind,
  type BackupListResponse,
  type BackupProjectJson,
  type BackupProjectsResponse,
  type BackupSettings,
  type BackupSettingsResponse,
  type BackupStartedResponse,
  type BackupStatusJson,
  type BackupUnavailableReason,
  type BackupVerifyResponse,
  isBackupId,
  restoredCopyName,
  restoredCopySlug,
} from '@spoor/shared'
import { inArray, sql } from 'drizzle-orm'
import { projects } from '../../db/schema.js'
import { type AuditActor, systemActor, webActor, writeAudit } from '../../lib/audit.js'
import { type DbOrTx, withTx } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError } from '../../lib/errors.js'
import { VERSION } from '../../version.js'
import type { UserContext } from '../auth/index.js'
import type { JobContext, JobStats } from '../jobs/index.js'
import { pickBackupId, verifyBundleFiles, writeBundle } from './bundle.js'
import {
  type BundleEntry,
  backupsDir,
  ensureLayout,
  freeBytes,
  listBundles,
  readBundle,
  removeBundle,
  sweepTmp,
  writeManifest,
} from './catalog.js'
import { HeavyLock, type HeldLock } from './lock.js'
import { currentMigration } from './migrations.js'
import { PgTools, type PgToolsProbe, pgConnectionEnv, serverMajor } from './pgtools.js'
import type { ProjectRestoreOptions } from './project-restore.js'
import type { RestoreServiceOptions } from './restore.js'
import {
  backupDue,
  isOverdue,
  newestGood,
  nextDueAt,
  planRetention,
  protectedReasons,
  type RetentionBundle,
} from './retention.js'
import { readBackupSettings, writeBackupSettings } from './settings.js'

export interface BackupServiceOptions {
  /** The pg client tools (tests: the docker shim). Default: `SPOOR_PG_BIN_DIR` or PATH, on `DATABASE_URL`. */
  tools?: PgTools
  /** Clock for ids, schedule and retention (tests). */
  now?: () => Date
  /** Project archive `busy` retries and their pause (default 3, 2 s). */
  busyRetries?: number
  busyDelayMs?: number
  /** Free-space reading of the preflight (tests). */
  freeBytes?: (path: string) => Promise<number | null>
  /** After a failed scheduled backup the job waits this long before the next attempt (default 1 h). */
  failureBackoffMs?: number
  /** Full restore overrides (tests: a short drain, a hook per phase). */
  restore?: RestoreServiceOptions
  /** Single-project restore overrides (tests: a hook after the safety archive). */
  projectRestore?: ProjectRestoreOptions
}

export type BackupAvailability =
  | { available: true; root: string; pgDumpVersion: string; serverVersion: string | null }
  | {
      available: false
      root: string | null
      reason: BackupUnavailableReason
      message: string
      pgDumpVersion: string | null
      serverVersion: string | null
    }

/** The Status page's backup line (`GET /api/v1/status` `backups`). */
export interface BackupStatusSummary {
  enabled: boolean
  available: boolean
  reason: BackupUnavailableReason | null
  last_good_at: string | null
  next_due_at: string | null
  /** The schedule is on and the newest good backup is older than twice the cadence. */
  overdue: boolean
}

const PROBE_OK_TTL_MS = 5 * 60_000
const PROBE_FAIL_TTL_MS = 30_000
const JOB_LEASE_RENEW_MS = 60_000

const notFound = () => new ApiError('not_found', { message: 'No such backup.' })

export const toRetention = (b: BundleEntry): RetentionBundle => ({
  id: b.id,
  kind: b.manifest.kind,
  createdAt: new Date(b.manifest.created_at),
  verified: b.manifest.verified_at !== null,
  pinned: b.manifest.pinned,
})

export class BackupService {
  readonly lock: HeavyLock
  readonly tools: PgTools
  readonly #now: () => Date
  #probe: { at: number; value: PgToolsProbe } | null = null
  #background: Promise<void> = Promise.resolve()
  #lastFailureAt = 0
  #manifestQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly deps: ServerDeps,
    private readonly opts: BackupServiceOptions = {},
  ) {
    this.lock = new HeavyLock(deps.config.DATABASE_URL)
    this.tools =
      opts.tools ??
      new PgTools({ binDir: deps.config.SPOOR_PG_BIN_DIR }).withConnection(
        pgConnectionEnv(deps.config.DATABASE_URL),
      )
    this.#now = opts.now ?? (() => new Date())
  }

  /** `SPOOR_BACKUP_DIR`, null when unset. */
  get root(): string | null {
    return this.deps.config.SPOOR_BACKUP_DIR ?? null
  }

  now(): Date {
    return this.#now()
  }

  /** Resolves when the background manual backup (if any) has finished (tests, shutdown). */
  idle(): Promise<void> {
    return this.#background
  }

  // ---- availability -----------------------------------------------------------------------------------

  async #serverVersion(): Promise<{ text: string | null; major: number | null }> {
    try {
      const res = await this.deps.db.execute<{ v: string; n: string }>(
        sql`SELECT current_setting('server_version') AS v, current_setting('server_version_num') AS n`,
      )
      const row = res.rows[0]
      return { text: row?.v ?? null, major: row ? serverMajor(row.n) : null }
    } catch {
      return { text: null, major: null }
    }
  }

  async #probeTools(major: number | null): Promise<PgToolsProbe> {
    const cached = this.#probe
    const now = Date.now()
    if (cached && now - cached.at < (cached.value.ok ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS)) {
      return cached.value
    }
    const value = await this.tools.probe(major ?? undefined)
    this.#probe = { at: now, value }
    return value
  }

  async availability(): Promise<BackupAvailability> {
    const server = await this.#serverVersion()
    const probe = await this.#probeTools(server.major)
    const pgDumpVersion = probe.pgDumpVersion
    const root = this.root
    const no = (reason: BackupUnavailableReason, message: string): BackupAvailability => ({
      available: false,
      root,
      reason,
      message,
      pgDumpVersion,
      serverVersion: server.text,
    })
    if (!root) return no('no_backup_dir', 'SPOOR_BACKUP_DIR is not set.')
    try {
      await ensureLayout(root)
      await access(root, constants.W_OK)
      await access(backupsDir(root), constants.W_OK)
    } catch {
      return no('dir_not_writable', `${root} is missing or not writable by the app.`)
    }
    if (!probe.ok) return no(probe.reason, probe.message)
    return { available: true, root, pgDumpVersion: probe.pgDumpVersion, serverVersion: server.text }
  }

  /** The backup directory, or 409 `backups_unavailable` with `details.reason`. */
  async requireAvailable(): Promise<string> {
    const a = await this.availability()
    if (!a.available) {
      throw new ApiError('backups_unavailable', {
        message: `Backups are not available: ${a.message}`,
        details: { reason: a.reason },
      })
    }
    return a.root
  }

  /** A valid bundle by id, or 404 (also for a non-id and when no directory is configured). */
  async bundleOr404(id: string): Promise<{ root: string; entry: BundleEntry }> {
    const root = this.root
    if (!root || !isBackupId(id)) throw notFound()
    const entry = await readBundle(root, id)
    if (!entry) throw notFound()
    return { root, entry }
  }

  // ---- list and status -------------------------------------------------------------------------------

  async #bundles(): Promise<BundleEntry[]> {
    const root = this.root
    if (!root) return []
    try {
      return await listBundles(root)
    } catch (err) {
      this.deps.logger.warn({ err: (err as Error).message }, 'backup: cannot read the backup directory')
      return []
    }
  }

  itemJson(entry: BundleEntry, ctx: { goodId: string | null; now: Date }): BackupItemJson {
    const m = entry.manifest
    return {
      id: entry.id,
      kind: m.kind,
      created_at: m.created_at,
      size_bytes: entry.sizeBytes,
      pinned: m.pinned,
      verified_at: m.verified_at,
      spoor_version: m.spoor_version,
      migration: m.migration,
      pg_server_version: m.pg_server_version,
      projects: m.projects.length,
      projects_skipped: m.projects.filter((p) => p.archive === null).length,
      restorable: m.migration.count <= currentMigration().count,
      protected: protectedReasons(toRetention(entry), ctx.goodId, ctx.now).length > 0,
    }
  }

  async #itemFor(id: string): Promise<BackupItemJson> {
    const bundles = await this.#bundles()
    const entry = bundles.find((b) => b.id === id)
    if (!entry) throw notFound()
    return this.itemJson(entry, { goodId: newestGood(bundles.map(toRetention))?.id ?? null, now: this.now() })
  }

  async #overview() {
    const [avail, stored, bundles] = await Promise.all([
      this.availability(),
      readBackupSettings(this.deps.db),
      this.#bundles(),
    ])
    const now = this.now()
    const good = newestGood(bundles.map(toRetention))
    const lastAuto = bundles.find((b) => b.manifest.kind === 'auto')
    const settings = stored.settings
    const next = avail.available
      ? nextDueAt({ settings, now, lastAutoAt: lastAuto ? new Date(lastAuto.manifest.created_at) : null })
      : null
    const overdue = isOverdue({
      enabled: settings.enabled,
      tiers: settings.tiers,
      lastGoodAt: good?.createdAt ?? null,
      settingsUpdatedAt: stored.updatedAt,
      now,
    })
    return { avail, settings, bundles, now, good, next, overdue }
  }

  /** `GET /backups`. Works while backups are unavailable. */
  async list(): Promise<BackupListResponse> {
    const o = await this.#overview()
    const root = this.root
    const status: BackupStatusJson = {
      available: o.avail.available,
      dir: root,
      free_bytes: root ? await freeBytes(root) : null,
      pg_dump_version: o.avail.pgDumpVersion,
      server_version: o.avail.serverVersion,
      last_good_at: o.good?.createdAt.toISOString() ?? null,
      next_due_at: o.next?.toISOString() ?? null,
      overdue: o.overdue,
      running: await this.lock.running(this.deps.db),
    }
    if (!o.avail.available) {
      status.reason = o.avail.reason
      status.reason_message = o.avail.message
    }
    const goodId = o.good?.id ?? null
    return {
      status,
      settings: o.settings,
      items: o.bundles.map((b) => this.itemJson(b, { goodId, now: o.now })),
    }
  }

  /** The Status page's line: on, available, last good, overdue. */
  async statusSummary(): Promise<BackupStatusSummary> {
    const o = await this.#overview()
    return {
      enabled: o.settings.enabled,
      available: o.avail.available,
      reason: o.avail.available ? null : o.avail.reason,
      last_good_at: o.good?.createdAt.toISOString() ?? null,
      next_due_at: o.next?.toISOString() ?? null,
      overdue: o.overdue,
    }
  }

  // ---- settings ----------------------------------------------------------------------------------------

  /** `PUT /backups/settings`. Allowed while backups are unavailable. Audited `backup.settings`. */
  async putSettings(ctx: UserContext, settings: BackupSettings): Promise<BackupSettingsResponse> {
    await withTx(this.deps.db, async (tx) => {
      await writeBackupSettings(tx, settings, ctx.user.id)
      await writeAudit(tx, webActor(ctx), {
        action: 'backup.settings',
        summary: settings.enabled
          ? `Scheduled backups on at ${settings.time_utc} UTC`
          : 'Scheduled backups off',
        data: { ...settings },
      })
    })
    const o = await this.#overview()
    return { settings: o.settings, next_due_at: o.next?.toISOString() ?? null }
  }

  // ---- making backups ------------------------------------------------------------------------------------

  async #audit(actor: AuditActor, action: string, summary: string, data: Record<string, unknown>) {
    await writeAudit(this.deps.db, actor, { action, summary, data })
  }

  /**
   * Write one bundle while holding the heavy lock (`held`, taken by the caller for `backup_id = id`). The
   * restore code calls it for the pre-restore backup.
   */
  async runBackup(
    kind: BackupKind,
    held: HeldLock,
    run: { signal?: AbortSignal; onProgress?: () => Promise<void> } = {},
  ): Promise<BundleEntry> {
    const root = await this.requireAvailable()
    const { settings } = await readBackupSettings(this.deps.db)
    await sweepTmp(root, this.now()).catch(() => [])
    return writeBundle(
      {
        db: this.deps.db,
        tools: this.tools,
        logger: this.deps.logger,
        root,
        version: VERSION,
      },
      {
        kind,
        at: new Date(held.info.started_at),
        projectArchives: settings.project_archives,
        signal: run.signal,
        onProgress: run.onProgress,
        busyRetries: this.opts.busyRetries,
        busyDelayMs: this.opts.busyDelayMs,
        freeBytes: this.opts.freeBytes,
      },
    )
  }

  /** Pick the next id of `kind` and take the heavy lock for it (503 `busy` when another operation runs). */
  async acquireFor(kind: BackupKind, operation: 'backup' | 'restore' = 'backup'): Promise<HeldLock> {
    const root = await this.requireAvailable()
    const { id, at } = await pickBackupId(root, kind, this.now())
    return this.lock.acquire({ operation, backup_id: id, kind, started_at: at.toISOString() })
  }

  /** `POST /backups`: a manual backup in the background (202). Audited `backup.create`. */
  async startManual(ctx: UserContext): Promise<BackupStartedResponse> {
    const held = await this.acquireFor('manual')
    const { backup_id: id, started_at } = held.info
    try {
      await this.#audit(webActor(ctx), 'backup.create', `Started a manual backup ${id}`, {
        kind: 'manual',
        id,
      })
    } catch (err) {
      await held.release()
      throw err
    }
    const log = this.deps.logger
    this.#background = this.runBackup('manual', held)
      .then((entry) => log.info({ backup: entry.id, bytes: entry.sizeBytes }, 'manual backup written'))
      .catch((err: unknown) => log.error({ backup: id, err: (err as Error).message }, 'manual backup failed'))
      .finally(() => held.release())
    return { backup: { id, kind: 'manual', started_at } }
  }

  /**
   * Prune by the tiers (only ever after a successful scheduled backup). Bundles without a valid backup.json
   * are not in the catalog, so they are never touched. Audited `backup.prune` (system) when it deleted any.
   */
  async prune(root: string, settings: BackupSettings): Promise<string[]> {
    const bundles = await listBundles(root)
    const plan = planRetention(bundles.map(toRetention), settings.tiers, this.now())
    const deleted: string[] = []
    for (const id of plan.delete) {
      try {
        // re-read under the manifest queue: a pin that landed since the plan keeps the bundle
        const removed = await this.#serialised(async () => {
          const now = await readBundle(root, id)
          if (!now || now.manifest.pinned) return false
          await removeBundle(root, id)
          return true
        })
        if (removed) deleted.push(id)
      } catch (err) {
        this.deps.logger.warn({ backup: id, err: (err as Error).message }, 'backup: prune failed')
      }
    }
    if (deleted.length > 0) {
      await this.#audit(systemActor, 'backup.prune', `Pruned ${deleted.length} old backup(s)`, { deleted })
    }
    return deleted
  }

  /**
   * The `backup` job (every 15 minutes): when the schedule is on, backups are available and a slot is due,
   * write an auto bundle, then prune. Silent (no `job_runs` row) when nothing is due or another heavy
   * operation runs; a failure is recorded and retried after `failureBackoffMs`.
   */
  async jobHandler(ctx: JobContext): Promise<JobStats> {
    const root = this.root
    if (!root) return {}
    const { settings } = await readBackupSettings(this.deps.db)
    if (!settings.enabled) return {}
    if ((await this.availability()).available === false) return {}
    const now = this.now()
    const lastAuto = (await listBundles(root)).find((b) => b.manifest.kind === 'auto')
    const { due } = backupDue({
      settings,
      now,
      lastAutoAt: lastAuto ? new Date(lastAuto.manifest.created_at) : null,
    })
    if (!due) return {}
    if (Date.now() - this.#lastFailureAt < (this.opts.failureBackoffMs ?? 3_600_000)) return {}
    let held: HeldLock
    try {
      held = await this.acquireFor('auto')
    } catch (err) {
      if (err instanceof ApiError && err.code === 'busy') return {}
      throw err
    }
    let renew: ReturnType<typeof setInterval> | undefined
    try {
      // inside the try: a failing job_runs insert must still release the heavy lock (finally)
      await ctx.markWork()
      // pg_dump of a large database can outlast the lease: renew it while working (a lost lease aborts)
      renew = setInterval(() => void ctx.renewLease().catch(() => {}), JOB_LEASE_RENEW_MS)
      renew.unref?.()
      const entry = await this.runBackup('auto', held, { signal: ctx.signal })
      await this.#audit(systemActor, 'backup.create', `Scheduled backup ${entry.id}`, {
        kind: 'auto',
        id: entry.id,
        size_bytes: entry.sizeBytes,
      })
      const pruned = await this.prune(root, settings)
      return {
        backup: entry.id,
        size_bytes: entry.sizeBytes,
        projects: entry.manifest.projects.length,
        projects_skipped: entry.manifest.projects.filter((p) => p.archive === null).length,
        pruned: pruned.length,
      }
    } catch (err) {
      this.#lastFailureAt = Date.now()
      throw err
    } finally {
      if (renew) clearInterval(renew)
      await held.release()
    }
  }

  // ---- one bundle ------------------------------------------------------------------------------------------

  /** Read-modify-write of a backup.json, serialised in this process (pin vs verify vs prune). */
  async updateManifest(
    id: string,
    change: (m: BundleEntry['manifest']) => BundleEntry['manifest'],
  ): Promise<BundleEntry> {
    return this.#serialised(async () => {
      const { entry } = await this.bundleOr404(id)
      await writeManifest(entry.dir, change(entry.manifest))
      const again = await this.bundleOr404(id)
      return again.entry
    })
  }

  /** Runs `fn` after every earlier manifest change in this process (pin, verify, prune's check-and-remove). */
  #serialised<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#manifestQueue.then(fn)
    this.#manifestQueue = run.catch(() => {})
    return run
  }

  /** `PATCH /backups/:id {pinned}`. Audited `backup.pin`. */
  async setPinned(ctx: UserContext, id: string, pinned: boolean): Promise<BackupItemJson> {
    await this.updateManifest(id, (m) => ({ ...m, pinned }))
    await this.#audit(webActor(ctx), 'backup.pin', `${pinned ? 'Pinned' : 'Unpinned'} backup ${id}`, {
      id,
      pinned,
    })
    return this.#itemFor(id)
  }

  /** `DELETE /backups/:id`: any kind (a human asked). 503 `busy` while that bundle is in use. */
  async remove(ctx: UserContext, id: string): Promise<void> {
    const { root, entry } = await this.bundleOr404(id)
    const running = await this.lock.running(this.deps.db)
    if (running && running.backup_id === id) {
      throw new ApiError('busy', {
        message: `Backup ${id} is in use (${running.operation}).`,
        hint: 'Try again when it has finished.',
      })
    }
    await removeBundle(root, id)
    await this.#audit(webActor(ctx), 'backup.delete', `Deleted backup ${id}`, {
      id,
      kind: entry.manifest.kind,
    })
  }

  /**
   * `POST /backups/:id/verify`: sha256 of every file and pg_restore reading the dump, under the heavy lock.
   * Success sets `verified_at`; a failure clears it (the bundle no longer counts as the newest good one).
   */
  async verify(id: string): Promise<BackupVerifyResponse> {
    const { entry } = await this.bundleOr404(id)
    await this.requireAvailable()
    const held = await this.lock.acquire({
      operation: 'verify',
      backup_id: id,
      kind: entry.manifest.kind,
      started_at: this.now().toISOString(),
    })
    let problems: string[]
    try {
      problems = await verifyBundleFiles(this.tools, entry.dir, entry.manifest)
      const verifiedAt = problems.length === 0 ? new Date().toISOString() : null
      await this.updateManifest(id, (m) => ({ ...m, verified_at: verifiedAt }))
    } finally {
      await held.release()
    }
    return { ok: problems.length === 0, problems, item: await this.#itemFor(id) }
  }

  /** `GET /backups/:id/projects`: from backup.json only, with the live project of the same id. */
  async projects(id: string): Promise<BackupProjectsResponse> {
    const { entry } = await this.bundleOr404(id)
    const m = entry.manifest
    const ids = m.projects.map((p) => p.id)
    const live =
      ids.length === 0
        ? []
        : await this.deps.db
            .select({ id: projects.id, slug: projects.slug, name: projects.name })
            .from(projects)
            .where(inArray(projects.id, ids))
    const liveBy = new Map(live.map((p) => [p.id, p]))
    const at = new Date(m.created_at)
    const out: BackupProjectJson[] = []
    for (const p of m.projects) {
      const l = liveBy.get(p.id)
      out.push({
        id: p.id,
        slug: p.slug,
        name: p.name,
        kind: p.kind,
        items: p.items,
        history: p.history,
        restorable: p.archive !== null,
        skipped_reason: p.skipped_reason ?? null,
        live: l ? { slug: l.slug, name: l.name } : null,
        can_overwrite: l !== undefined && p.kind !== 'shared',
        suggested_slug: await uniqueCopySlug(this.deps.db, restoredCopySlug(p.slug, at)),
        suggested_name: restoredCopyName(p.name, at),
      })
    }
    return { backup_id: entry.id, created_at: m.created_at, projects: out }
  }
}

/**
 * `base`, or `base-2`, `base-3`, … (cut to the 40-character slug limit) when it is taken. The single-project
 * restore checks again inside its transaction (409 `slug_taken`).
 */
export async function uniqueCopySlug(db: DbOrTx, base: string): Promise<string> {
  const candidates = [base]
  for (let n = 2; n <= 50; n++) {
    const suffix = `-${n}`
    candidates.push(`${base.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`)
  }
  const taken = new Set(
    (await db.select({ slug: projects.slug }).from(projects).where(inArray(projects.slug, candidates))).map(
      (r) => r.slug,
    ),
  )
  return candidates.find((c) => !taken.has(c)) ?? base
}
