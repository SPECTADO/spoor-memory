/**
 * Export and import of a project or the shared space (api.md section 9, data-model.md section 8,
 * auth-and-security.md section 9). Roles: project admin (shared: instance admin) for export and for import
 * into an existing project, instance admin for import into a NEW project; nothing here is reachable by a
 * bearer token.
 *
 * One import or export at a time per instance: an in-process flag here and an advisory transaction lock in
 * the transaction itself (so two server processes cannot overlap either). The synchronous unzip and parse
 * run on the request thread, not in a worker thread (a documented deviation, see docs/design/deviations.md
 * I43); their cost is bounded by the zip limits.
 */
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError } from '../../lib/errors.js'
import { VERSION } from '../../version.js'
import { assertCan, type UserContext, webPrincipal } from '../auth/index.js'
import type { ProjectAccess } from '../projects/index.js'
import { entryAllowed, parseArchive } from './archive.js'
import { buildExport, type ExportResult } from './export.js'
import { type ImportResponse, type ImportTarget, importArchive } from './import.js'
import { readZip } from './zip.js'

export interface ImportInput {
  file: Uint8Array
  remapIds: boolean
}

export class TransferService {
  #busy = false

  constructor(private readonly deps: ServerDeps) {}

  async #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#busy) {
      throw new ApiError('busy', {
        message: 'Another import or export is running.',
        hint: 'Try again in a minute.',
      })
    }
    this.#busy = true
    try {
      return await fn()
    } finally {
      this.#busy = false
    }
  }

  /** `GET /projects/:slug/export`. PA, IA (shared: IA). */
  exportProject(access: ProjectAccess, opts: { history: boolean }): Promise<ExportResult> {
    access.assert('project.transfer')
    return this.#exclusive(() =>
      buildExport(this.deps.db, access.project, { history: opts.history, version: VERSION }),
    )
  }

  /** `POST /projects/import`: a new project from an archive. Instance admins only. */
  importNew(ctx: UserContext, input: ImportInput & { slug: string; name?: string }): Promise<ImportResponse> {
    assertCan(webPrincipal(ctx.user, null), 'project.create')
    return this.#run(
      ctx,
      input,
      (name) => ({ kind: 'new', slug: input.slug, name: input.name ?? name }),
      () => assertCan(webPrincipal(ctx.user, null), 'library.write'),
    )
  }

  /** `POST /projects/:slug/import`: into an empty project (or the shared space). PA, IA (shared: IA). */
  importInto(access: ProjectAccess, input: ImportInput): Promise<ImportResponse> {
    access.assert('project.transfer')
    return this.#run(
      access.ctx,
      input,
      () => ({ kind: 'existing', project: access.project }),
      () => access.assert('library.write'),
    )
  }

  #run(
    ctx: UserContext,
    input: ImportInput,
    target: (defaultName: string) => ImportTarget,
    assertLibrary: () => void,
  ): Promise<ImportResponse> {
    return this.#exclusive(async () => {
      const entries = readZip(input.file, entryAllowed)
      const parsed = parseArchive(entries)
      // library pages are written by humans with the library right (ADR-0014). `project.transfer` implies it
      // today; the explicit check keeps the rule if that ever changes.
      const spacesIn =
        parsed.kind === 'lossless' ? parsed.items.map((i) => i.m.space) : parsed.files.map((f) => f.space)
      if (spacesIn.includes('library')) assertLibrary()
      const defaultName = parsed.kind === 'lossless' ? parsed.manifest.project.name : 'Imported'
      const outcome = await importArchive(this.deps, {
        parsed,
        target: target(defaultName),
        remapIds: input.remapIds,
        importer: ctx,
      })
      // chunk rows exist (NULL embeddings, written in the import transaction); embed-pending fills them
      this.deps.ports.jobs.enqueue('embed-pending', { projectId: outcome.projectId })
      return {
        ...outcome.response,
        notes: [
          ...outcome.response.notes,
          'Full-text search works at once; embeddings are computed in the background.',
        ],
      }
    })
  }
}
