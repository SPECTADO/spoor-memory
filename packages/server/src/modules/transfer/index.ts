/**
 * Transfer module: export a project (or the shared space) as a zip, and import one losslessly or from a
 * folder of Markdown files. Design: data-model.md section 8, api.md section 9, auth-and-security.md section 9.
 * 0.8: async Markdown zips (export tasks, api.md section 13.4, ADR-0041): markdown.ts and tasks.ts.
 *
 * Wiring (src/app.ts): `const transfer = createTransferModule(deps)` then `api.route('/', transfer.routes)`
 * inside the cookie API, after the guards.
 */
import { Hono } from 'hono'
import type { ServerDeps } from '../../lib/deps.js'
import type { AppEnv } from '../../types.js'
import type { JobContext } from '../jobs/index.js'
import { exportTaskRoutes, transferRoutes } from './routes.js'
import { TransferService } from './service.js'
import { type ExportTaskOptions, ExportTaskService } from './tasks.js'

export {
  entryAllowed,
  type LosslessArchive,
  type ParsedArchive,
  parseArchive,
} from './archive.js'
export { buildExport, EXPORT_MAX_BYTES, type ExportResult } from './export.js'
export { type ImportOutcome, importArchive, takeTransferLock } from './import.js'
export { type MarkdownSource, type MarkdownZip, markdownZip } from './markdown.js'
export { TransferService } from './service.js'
export {
  type ExportSourceLoader,
  type ExportTaskOptions,
  type ExportTaskRow,
  ExportTaskService,
  type ExportTaskSource,
  type LoadedExportSource,
  taskFiles,
} from './tasks.js'
export { readZip } from './zip.js'

/**
 * `exportTasks` is the async Markdown zip service (ADR-0041); `exportsJobHandler` is the `exports` job's
 * handler (app.ts registers it). The backup module adds its source with `exportTasks.setSourceLoader('backup', …)`
 * and creates tasks with `exportTasks.create(ctx, {kind: 'backup', …})`.
 */
export function createTransferModule(deps: ServerDeps, opts: { exports?: ExportTaskOptions } = {}) {
  const transfer = new TransferService(deps)
  const exportTasks = new ExportTaskService(deps, transfer, opts.exports)
  const routes = new Hono<AppEnv>()
    .route('/', transferRoutes(deps, transfer))
    .route('/', exportTaskRoutes(deps, exportTasks))
  return {
    name: 'transfer',
    transfer,
    exportTasks,
    exportsJobHandler: (ctx: JobContext) => exportTasks.jobHandler(ctx),
    routes,
  }
}

export type TransferModule = ReturnType<typeof createTransferModule>
