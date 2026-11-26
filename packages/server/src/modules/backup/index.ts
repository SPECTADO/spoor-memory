/**
 * Backup module (0.8, ADR-0038 to ADR-0041): backup bundles in `SPOOR_BACKUP_DIR` (pg_dump + per-project
 * export zips + backup.json), the schedule and tiered retention, full restore with a maintenance gate, and
 * single projects from a backup. Routes under `/api/v1/backups` (IA, cookie only; api.md section 13).
 *
 *   pgtools.ts     pg_dump / pg_restore / psql: connection only through PG* env vars, data only through pipes
 *   catalog.ts     the directory is the catalog: list, read, atomic backup.json, .tmp sweep, free space
 *   bundle.ts      write (.tmp -> verify -> rename) and verify one bundle
 *   retention.ts   pure schedule (due, next, overdue) and tiered pruning
 *   lock.ts        one heavy operation at a time across containers (advisory lock + in-process flag)
 *   settings.ts    instance_settings key 'backup'
 *   service.ts     BackupService: list/status, settings, manual + scheduled backups, pin, delete, verify
 *   routes.ts      the HTTP routes
 *   restore.ts     RestoreService: full restore (prepare, confirm, the psql transaction, restore-state.json)
 *   maintenance.ts the maintenance gate of a full restore (503 `maintenance`, requests in flight)
 *   restore-routes.ts, project-restore.ts, project-routes.ts   full restore and one project from a backup
 *
 * Wiring (src/app.ts): `const backup = createBackupModule(deps, opts)`, `api.route('/', backup.routes)`, the
 * `backup` job registered with `backupJob(backup.jobHandler)`, the Status page's line through
 * `StatusSources.backups`, `backup.restore.setHost(…)` (scheduler, export tasks, MCP sessions, startup steps)
 * and `app.use('*', backup.maintenance)` right after /healthz.
 */
import { Hono } from 'hono'
import type { ServerDeps } from '../../lib/deps.js'
import type { AppEnv } from '../../types.js'
import type { JobHandler } from '../jobs/index.js'
import { ProjectRestoreService, type ProjectRestoreTransfer } from './project-restore.js'
import { backupProjectRoutes } from './project-routes.js'
import { RestoreService } from './restore.js'
import { restoreRoutes } from './restore-routes.js'
import { backupRoutes } from './routes.js'
import { BackupService, type BackupServiceOptions } from './service.js'

export {
  BackupWriteError,
  DUMP_ARGS,
  DUMP_EXCLUDED_TABLE_DATA,
  pickBackupId,
  readDumpThroughPgRestore,
  verifyBundleFiles,
  writeBundle,
} from './bundle.js'
export {
  type BundleEntry,
  bundleDir,
  DUMP_FILE,
  listBundles,
  MANIFEST_FILE,
  readBundle,
  writeManifest,
} from './catalog.js'
export { busyError, HeavyLock, type HeldLock } from './lock.js'
export { MaintenanceGate, RESTORE_STATUS_PATH, redactRestoreStatus } from './maintenance.js'
export { currentMigration, databaseMigration } from './migrations.js'
export {
  assertSafeArgs,
  PG_TOOLS,
  type PgConnectionEnv,
  type PgRunIo,
  type PgRunResult,
  type PgTool,
  PgToolError,
  PgTools,
  type PgToolsOptions,
  type PgToolsProbe,
  parsePgVersion,
  pgConnectionEnv,
  serverMajor,
} from './pgtools.js'
export {
  ProjectRestoreService,
  type ProjectRestoreTransfer,
  safetyArchiveName,
} from './project-restore.js'
export {
  RESTORE_PRELUDE,
  RESTORE_STATE_FILE,
  type RestoreHost,
  RestoreService,
  type RestoreServiceOptions,
  readStateFile,
  restoreEpilogue,
  runRestoreTransaction,
} from './restore.js'
export { planRetention, type RetentionBundle } from './retention.js'
export {
  type BackupAvailability,
  BackupService,
  type BackupServiceOptions,
  type BackupStatusSummary,
  uniqueCopySlug,
} from './service.js'
export { BACKUP_SETTINGS_KEY, readBackupSettings, writeBackupSettings } from './settings.js'

/**
 * `links.transfer` (the transfer module) enables one project from a backup: the restore and export routes of
 * api.md section 13.3, and the `backup` source of export tasks (registered on `transfer.exportTasks`).
 */
export function createBackupModule(
  deps: ServerDeps,
  opts: BackupServiceOptions = {},
  links: { transfer?: ProjectRestoreTransfer } = {},
) {
  const service = new BackupService(deps, opts)
  const jobHandler: JobHandler = (ctx) => service.jobHandler(ctx)
  // full restore (ADR-0039): its host (scheduler, export tasks, MCP, startup steps) is set by src/app.ts
  const restore = new RestoreService(deps, service, opts.restore)
  const maintenance = restore.gate.middleware(() => restore.status())
  const routes = new Hono<AppEnv>().route('/', restoreRoutes(restore)).route('/', backupRoutes(service))
  let projectRestore: ProjectRestoreService | null = null
  if (links.transfer) {
    projectRestore = new ProjectRestoreService(deps, service, links.transfer, opts.projectRestore)
    links.transfer.exportTasks.setSourceLoader('backup', projectRestore.exportSourceLoader)
    routes.route('/', backupProjectRoutes(projectRestore))
  }
  return { name: 'backup', service, restore, maintenance, projectRestore, jobHandler, routes }
}

export type BackupModule = ReturnType<typeof createBackupModule>
