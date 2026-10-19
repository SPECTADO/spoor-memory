/**
 * The repo mirror (data-model.md section 7, api.md sections 7.2 and 7.3, deviations I3, I42, I44):
 * `POST /p/:slug/api/push` and `POST /p/:slug/api/adr/import`. The request carries the file as text; the
 * server parses it with the shared frontmatter schema and decides titles, slugs, numbers and extras.
 *
 * - Matching: `spoor_id` in this project → `(project, source_path)`. A foreign `spoor_id` is ignored
 *   (`foreign_spoor_id`). The ADR number is never a match key: a held number is a collision and the new
 *   file is renumbered (import: above `reserve_above`), so a file can never overwrite another ADR.
 * - Fast-forward: `base_revision` equals the current revision, or the latest revision came from the CLI.
 *   Otherwise 409 `pushed_over_spoor_edit` and only `push_conflict_at` is written (audited as
 *   `item.push_rejected`); `force` writes anyway (`data.forced` in the audit row). Identical content is a
 *   no-op that also clears a recorded push conflict (the file was aligned with Spoor).
 * - Content keys follow the file (missing ones take defaults); `pinned` / `last_verified` only on create;
 *   server-owned extras survive; `superseded` is sticky while a live superseder exists.
 * - Edges from `relations`, `supersedes`, `drafted_from` and `Superseded by …` are added in a second pass,
 *   so refs to files later in the same import batch resolve. ADR refs go through the batch's
 *   `{repo number → assigned number}` map; a ref to a renumbered number is not applied (`ambiguous_ref`).
 */
import {
  extrasOf,
  FrontmatterError,
  formatHandle,
  itemSlug,
  normalizeFilePath,
  parseHandle,
  splitFrontmatter,
} from '@spoor/shared'
import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { edges, itemRevisions, items } from '../../db/schema.js'
import { type DbOrTx, isUniqueViolation, lockProjectForWrite, type Tx, withTx } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError } from '../../lib/errors.js'
import type { Space } from '../../ports.js'
import { addEdge, rewriteWikilinks, sharedProjectId, TYPED_KINDS, type TypedKind } from './links.js'
import {
  dateFromSection,
  fileStem,
  firstH1,
  humanizeFileName,
  numberFromFileName,
  numberFromH1,
  SERVER_OWNED_EXTRAS,
  statusFromSection,
  stripAdrPrefix,
  validateFrontmatter,
} from './markdown.js'
import { handleOf, type LoadedItem, loadItem, viewOf } from './rows.js'
import type { AdrImportRequest, PushRequest } from './schemas.js'
import type { ItemService, Warning } from './service.js'
import {
  actorOf,
  assertWritable,
  type Caller,
  type ContentFields,
  cleanAnchors,
  cleanBody,
  cleanTags,
  cleanTitle,
  contentOf,
  deriveSlug,
  invalid,
  sameContent,
  stickyStatus,
  writeContent,
} from './writes.js'

export interface PushResult {
  source_path: string
  status: 'created' | 'updated' | 'unchanged'
  handle: string
  spoor_id: string
  space: Space
  revision: number
  number: number
  adr_number: number | null
  renumbered: { from: number; to: number } | null
  warnings: Warning[]
}

export interface PushError {
  source_path: string
  error: string
  message?: string
  details?: Record<string, unknown>
}

interface ParsedFile {
  sourcePath: string
  space: 'decisions' | 'docs'
  fields: ContentFields
  /** Number the file names (frontmatter `adr`, file name, H1), decisions only. */
  fileNumber: number | null
  spoorId: string | null
  pinned: boolean
  lastVerified: string | null
  relations: { kind: TypedKind; to: string }[]
  supersedes: string | null
  draftedFrom: string[]
  supersededBy: string | null
  slugBase: string
}

interface Batch {
  reserveAbove: number | null
  /** repo number → assigned number, for ADR refs inside the batch. */
  map: Map<number, number>
}

interface Pass1 {
  parsed: ParsedFile
  row: LoadedItem
  result: PushResult
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const adrHandle = (n: number) => formatHandle('decision', n)
const INVALID_FILE_PATH = 'must be a repo-relative path of 1 to 256 characters without ".." segments or NUL'
const ABSOLUTE_PATH_RE = /^(?:[/\\~]|[A-Za-z]:)/

export class PushService {
  constructor(
    private readonly deps: ServerDeps,
    private readonly items: ItemService,
  ) {}

  get db() {
    return this.deps.db
  }

  /** `POST /p/:slug/api/push`: one file; failures are thrown as API errors. */
  async push(caller: Caller, req: PushRequest): Promise<PushResult> {
    assertWritable(caller)
    const batch: Batch = { reserveAbove: null, map: new Map() }
    const p1 = await this.pass1(caller, req.space, req.source_path, req.content, batch, {
      baseRevision: req.base_revision ?? null,
      force: req.force === true,
    })
    await this.pass2(caller, p1, batch)
    return p1.result
  }

  /** `POST /p/:slug/api/adr/import`: a batch of ADR files; a bad file does not fail the batch. */
  async adrImport(caller: Caller, req: AdrImportRequest): Promise<{ results: (PushResult | PushError)[] }> {
    assertWritable(caller)
    const batch: Batch = { reserveAbove: req.reserve_above ?? null, map: new Map() }
    const files = [...req.files].sort((a, b) =>
      a.source_path < b.source_path ? -1 : a.source_path > b.source_path ? 1 : 0,
    )
    const done: (Pass1 | PushError)[] = []
    for (const f of files) {
      try {
        done.push(
          await this.pass1(caller, 'decisions', f.source_path, f.content, batch, {
            baseRevision: null,
            force: false,
          }),
        )
      } catch (err) {
        done.push(toPushError(f.source_path, err))
      }
    }
    for (const d of done) {
      if (!('parsed' in d)) continue
      try {
        await this.pass2(caller, d, batch)
      } catch (err) {
        d.result.warnings.push({ code: 'edges_failed', ...toPushError(d.parsed.sourcePath, err) })
      }
    }
    // the input order of the request, so the CLI can zip results with its files
    const byPath = new Map(done.map((d) => ['parsed' in d ? d.parsed.sourcePath : d.source_path, d]))
    return {
      results: req.files.map((f) => {
        const norm = normalizeFilePath(f.source_path)
        const d = byPath.get(norm ?? f.source_path) ?? byPath.get(f.source_path)
        if (!d) return { source_path: f.source_path, error: 'internal', message: 'not processed' }
        return 'parsed' in d ? d.result : d
      }),
    }
  }

  // ---- parsing ------------------------------------------------------------------------------------------

  parse(space: 'decisions' | 'docs', sourcePath: string, content: string): ParsedFile {
    // repo-relative only: an absolute path, a drive letter or a home path is refused, not silently
    // re-rooted (the normaliser would strip a leading `/`)
    const path = ABSOLUTE_PATH_RE.test(sourcePath.trim()) ? null : normalizeFilePath(sourcePath)
    if (path === null || path.endsWith('/'))
      throw invalid('source_path', path === null ? INVALID_FILE_PATH : 'must name a file')
    let md: ReturnType<typeof splitFrontmatter>
    let data: Record<string, unknown>
    try {
      md = splitFrontmatter(content)
      data = validateFrontmatter(space, md.data)
    } catch (err) {
      if (err instanceof FrontmatterError) {
        throw new ApiError('invalid_input', {
          message: 'Invalid frontmatter.',
          details: { issues: err.issues },
        })
      }
      throw err
    }
    const h1 = firstH1(md.body)
    const titleText =
      (data.title as string | undefined) ??
      (h1 ? (space === 'decisions' ? stripAdrPrefix(h1) || h1 : h1) : null) ??
      humanizeFileName(path, space)
    const extras = extrasOf(space, md.data)
    let status = 'active'
    let supersededBy: string | null = null
    let fileNumber: number | null = null
    let decidedOn: string | null = null
    if (space === 'decisions') {
      fileNumber = (data.adr as number | undefined) ?? numberFromFileName(path) ?? numberFromH1(h1)
      if (fileNumber !== null && fileNumber > 99999) throw invalid('adr', 'ADR numbers go up to 99999')
      const section = data.status === undefined ? statusFromSection(md.body) : null
      status = (data.status as string | undefined) ?? section?.status ?? 'accepted'
      if (section?.original && extras.original_status === undefined) extras.original_status = section.original
      supersededBy = section?.supersededBy ?? null
      decidedOn =
        (data.date as string | undefined) ?? (data.date === undefined ? dateFromSection(md.body) : null)
    }
    const stem = fileStem(path, space)
    return {
      sourcePath: path,
      space,
      fields: {
        title: cleanTitle(titleText),
        body: cleanBody(md.body),
        status,
        type: null,
        confidence: null,
        tags: cleanTags((data.tags as string[]) ?? []),
        anchors: cleanAnchors((data.anchors as string[]) ?? []),
        extras,
        decidedOn,
      },
      fileNumber,
      spoorId: (data.spoor_id as string | undefined)?.toLowerCase() ?? null,
      pinned: data.pinned === true,
      lastVerified: (data.last_verified as string | undefined) ?? null,
      relations: ((data.relations as { kind: TypedKind; to: string }[]) ?? []).filter((r) =>
        (TYPED_KINDS as readonly string[]).includes(r.kind),
      ),
      supersedes: (data.supersedes as string | undefined) ?? null,
      draftedFrom: space === 'decisions' ? ((data.drafted_from as string[] | undefined) ?? []) : [],
      supersededBy,
      slugBase: stem.trim() === '' ? deriveSlug(titleText) : itemSlug(stem),
    }
  }

  // ---- pass 1: content ----------------------------------------------------------------------------------

  private async pass1(
    caller: Caller,
    space: 'decisions' | 'docs',
    sourcePath: string,
    content: string,
    batch: Batch,
    opts: { baseRevision: number | null; force: boolean },
  ): Promise<Pass1> {
    const parsed = this.parse(space, sourcePath, content)
    const warnings: Warning[] = []
    const view = viewOf(caller.project)

    // matching: spoor_id in this project, then source_path (data-model.md section 7)
    let match: LoadedItem | null = null
    let bySpoorId = false
    if (parsed.spoorId) {
      const row = UUID_RE.test(parsed.spoorId) ? await loadItem(this.db, parsed.spoorId) : undefined
      if (row && row.projectId === caller.project.id) {
        match = row
        bySpoorId = true
      } else warnings.push({ code: 'foreign_spoor_id' })
    }
    if (!match) {
      const [row] = await this.db
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.projectId, caller.project.id), eq(items.sourcePath, parsed.sourcePath)))
        .limit(1)
      if (row) match = (await loadItem(this.db, row.id)) ?? null
    }
    if (match && match.space !== space) {
      throw new ApiError('wrong_space', {
        message: `${handleOf(match, view)} is in the ${match.space} space, not ${space}.`,
      })
    }
    if (match) return this.pushUpdate(caller, parsed, match, bySpoorId, warnings, batch, opts)
    try {
      return await this.pushCreate(caller, parsed, warnings, batch)
    } catch (err) {
      // a concurrent push of the same new file: retry once as an update
      if (isUniqueViolation(err, 'items_source_uq')) {
        const [row] = await this.db
          .select({ id: items.id })
          .from(items)
          .where(and(eq(items.projectId, caller.project.id), eq(items.sourcePath, parsed.sourcePath)))
          .limit(1)
        const again = row ? await loadItem(this.db, row.id) : undefined
        if (again) return this.pushUpdate(caller, parsed, again, false, warnings, batch, opts)
      }
      throw err
    }
  }

  private async pushCreate(
    caller: Caller,
    parsed: ParsedFile,
    warnings: Warning[],
    batch: Batch,
  ): Promise<Pass1> {
    const view = viewOf(caller.project)
    // two sessions drafted the same memory: refuse the second ADR (already_drafted), write nothing.
    // Checked here (cheap, before the embedding call) and again inside the create transaction, where the
    // project row lock of `allocate` serialises creates and the edges are inserted at once (review D3).
    const drafted: LoadedItem[] = []
    for (const ref of parsed.draftedFrom) {
      const mem = await this.tryResolve(caller, ref, 'write')
      if (mem?.space !== 'memories') continue
      drafted.push(mem)
      await this.assertNotDrafted(this.db, caller, mem, null)
    }
    const prepared = await this.items.prepare({
      projectId: caller.project.id,
      space: parsed.space,
      ...parsed.fields,
    })
    let pending = false
    const { row, renumbered } = await this.items.createTx(false, async (tx) => {
      const ins = await this.items.insertNew(tx, caller, {
        space: parsed.space,
        fields: parsed.fields,
        pinned: parsed.pinned,
        slug: { value: parsed.slugBase, explicit: false },
        adr: { number: parsed.fileNumber, onTaken: 'renumber', reserveAbove: batch.reserveAbove },
        sourcePath: parsed.sourcePath,
        lastVerified: parsed.lastVerified,
      })
      const created = ins.row
      for (const mem of drafted) {
        await this.assertNotDrafted(tx, caller, mem, created.id)
        await addEdge(tx, created, 'drafted_from', mem, actorOf(caller))
      }
      pending = await this.items.index(tx, created, prepared)
      await this.items.audit(
        tx,
        caller,
        'item.push',
        created,
        `pushed ${handleOf(created, view)} (new) from ${parsed.sourcePath}`,
        {
          revision: 1,
          created: true,
          ...(ins.renumbered ? { renumbered: ins.renumbered } : {}),
        },
      )
      return { row: created, renumbered: ins.renumbered }
    })
    this.items.pendingWarning(caller.project.id, pending, warnings)
    if (parsed.fileNumber !== null && row.adrNumber !== null) batch.map.set(parsed.fileNumber, row.adrNumber)
    return {
      parsed,
      row,
      result: this.result(caller, parsed.sourcePath, 'created', row, renumbered, warnings),
    }
  }

  /** 409 `already_drafted` when a live ADR other than `selfId` was drafted from `mem`. */
  private async assertNotDrafted(db: DbOrTx, caller: Caller, mem: LoadedItem, selfId: string | null) {
    const [other] = await db
      .select({ id: edges.srcId })
      .from(edges)
      .innerJoin(items, eq(items.id, edges.srcId))
      .where(
        and(
          eq(edges.dstId, mem.id),
          eq(edges.kind, 'drafted_from'),
          ne(items.status, 'superseded'),
          selfId ? ne(edges.srcId, selfId) : undefined,
        ),
      )
      .limit(1)
    if (!other) return
    const view = viewOf(caller.project)
    const adr = (await loadItem(db, other.id)) as LoadedItem
    throw new ApiError('already_drafted', {
      message: `${handleOf(mem, view)} was already drafted as ${handleOf(adr, view)}.`,
      details: { handle: handleOf(mem, view), adr: handleOf(adr, view) },
    })
  }

  private async pushUpdate(
    caller: Caller,
    parsed: ParsedFile,
    match: LoadedItem,
    bySpoorId: boolean,
    warnings: Warning[],
    batch: Batch,
    opts: { baseRevision: number | null; force: boolean },
    attempt = 0,
  ): Promise<Pass1> {
    const view = viewOf(caller.project)
    const actor = actorOf(caller)
    const warningsBefore = warnings.length
    if (parsed.fileNumber !== null && match.adrNumber !== null && parsed.fileNumber !== match.adrNumber) {
      warnings.push({ code: 'number_mismatch', file: parsed.fileNumber, item: match.adrNumber })
    }
    if (parsed.fileNumber !== null && match.adrNumber !== null)
      batch.map.set(parsed.fileNumber, match.adrNumber)

    // a spoor_id match whose source_path differs: the file was renamed (or renumbered)
    let movePath: string | null = null
    if (bySpoorId && match.sourcePath !== parsed.sourcePath) {
      const [holder] = await this.db
        .select({ id: items.id })
        .from(items)
        .where(
          and(
            eq(items.projectId, caller.project.id),
            eq(items.sourcePath, parsed.sourcePath),
            ne(items.id, match.id),
          ),
        )
        .limit(1)
      if (holder) {
        const h = (await loadItem(this.db, holder.id)) as LoadedItem
        throw new ApiError('source_path_taken', {
          message: `${parsed.sourcePath} is mirrored by ${handleOf(h, view)}.`,
          details: { handle: handleOf(h, view) },
        })
      }
      movePath = parsed.sourcePath
      if (match.sourcePath) warnings.push({ code: 'source_path_updated', from: match.sourcePath })
    }

    // content follows the file; server-owned extras survive; `superseded` is sticky
    const fields: ContentFields = { ...parsed.fields, extras: { ...parsed.fields.extras } }
    for (const k of SERVER_OWNED_EXTRAS) {
      if (fields.extras[k] === undefined && match.frontmatter[k] !== undefined)
        fields.extras[k] = match.frontmatter[k]
    }
    const sticky = await stickyStatus(this.db, match, fields.status)
    if (sticky.kept) {
      fields.status = sticky.status
      warnings.push({ code: 'status_kept_superseded' })
    }

    if (sameContent(contentOf(match), fields)) {
      // identical content: no revision; an aligned file also clears a recorded push conflict
      const row = await withTx(this.db, async (tx) => {
        if (match.pushConflictAt || movePath) {
          await tx
            .update(items)
            .set({ pushConflictAt: null, ...(movePath ? { sourcePath: movePath } : {}) })
            .where(eq(items.id, match.id))
        }
        return (await loadItem(tx, match.id)) as LoadedItem
      })
      return { parsed, row, result: this.result(caller, parsed.sourcePath, 'unchanged', row, null, warnings) }
    }

    // fast-forward: the caller's base is current, or nobody edited the item in Spoor since the last push
    const [latest] = await this.db
      .select({ via: itemRevisions.via, label: itemRevisions.actorLabel })
      .from(itemRevisions)
      .where(eq(itemRevisions.itemId, match.id))
      .orderBy(desc(itemRevisions.revision))
      .limit(1)
    const ff = opts.baseRevision === match.revision || latest?.via === 'cli'
    if (!ff && !opts.force) {
      await withTx(this.db, async (tx) => {
        await tx.update(items).set({ pushConflictAt: sql`now()` }).where(eq(items.id, match.id))
        await this.items.audit(
          tx,
          caller,
          'item.push_rejected',
          match,
          `push of ${parsed.sourcePath} refused: ${handleOf(match, view)} was edited in Spoor`,
          {
            current_revision: match.revision,
            base_revision: opts.baseRevision,
          },
        )
      })
      throw new ApiError('pushed_over_spoor_edit', {
        message: `${handleOf(match, view)} was edited in Spoor (by ${latest?.label ?? 'unknown'} via ${latest?.via ?? 'unknown'}) after the last push.`,
        hint: 'Nothing was pushed. A human resolves it in a terminal, or aligns the file with Spoor.',
        details: {
          current_revision: match.revision,
          edited_by: latest?.label ?? null,
          via: latest?.via ?? null,
        },
      })
    }

    const prepared = await this.items.prepare({ projectId: match.projectId, space: match.space, ...fields })
    let pending = false
    let row: LoadedItem
    try {
      row = await withTx(this.db, async (tx) => {
        await lockProjectForWrite(tx, match.projectId)
        const settings = await this.items.projectSettings(match.projectId)
        const current = (await loadItem(tx, match.id, true)) as LoadedItem
        // `expected` is the revision the fast-forward decision above was made on: an edit that committed
        // since (e.g. during the embedding call) is a conflict, decided again below (review D1)
        const updated = await writeContent(tx, {
          item: current,
          expected: match.revision,
          fields,
          change: 'push',
          actor,
          provenance: 'human',
          observationDays: settings.cleanup.observation_days,
          extraSet: { pushConflictAt: null, ...(movePath ? { sourcePath: movePath } : {}) },
        })
        await rewriteWikilinks(tx, updated, await sharedProjectId(tx), actor)
        pending = await this.items.index(tx, updated, prepared)
        await this.items.audit(
          tx,
          caller,
          'item.push',
          updated,
          `pushed ${handleOf(updated, view)} r${updated.revision} from ${parsed.sourcePath}`,
          {
            revision: [current.revision, updated.revision],
            ...(opts.force && !ff ? { forced: true } : {}),
          },
        )
        return updated
      })
    } catch (err) {
      if (isUniqueViolation(err, 'items_source_uq')) {
        throw new ApiError('source_path_taken', {
          message: `${parsed.sourcePath} is mirrored by another item.`,
        })
      }
      // written meanwhile: decide again on the fresh row (fast-forward, 409 `pushed_over_spoor_edit`, or
      // identical content), never last-write-wins
      if (err instanceof ApiError && err.code === 'revision_conflict' && attempt < 3) {
        const fresh = await loadItem(this.db, match.id)
        if (fresh) {
          warnings.length = warningsBefore
          return this.pushUpdate(caller, parsed, fresh, bySpoorId, warnings, batch, opts, attempt + 1)
        }
      }
      throw err
    }
    this.items.pendingWarning(match.projectId, pending, warnings)
    return { parsed, row, result: this.result(caller, parsed.sourcePath, 'updated', row, null, warnings) }
  }

  private result(
    caller: Caller,
    sourcePath: string,
    status: PushResult['status'],
    row: LoadedItem,
    renumbered: PushResult['renumbered'],
    warnings: Warning[],
  ): PushResult {
    return {
      source_path: sourcePath,
      status,
      handle: handleOf(row, viewOf(caller.project)),
      spoor_id: row.id,
      space: row.space,
      revision: row.revision,
      number: row.number,
      adr_number: row.adrNumber,
      renumbered,
      warnings,
    }
  }

  // ---- pass 2: edges ------------------------------------------------------------------------------------

  private async tryResolve(caller: Caller, ref: string, mode: 'read' | 'write'): Promise<LoadedItem | null> {
    try {
      return await this.items.load(caller, ref, mode)
    } catch (err) {
      if (err instanceof ApiError && ['not_found', 'ambiguous_id', 'read_only_space'].includes(err.code))
        return null
      throw err
    }
  }

  /**
   * An ADR ref seen from a batch: through the batch map first; a number that was renumbered (in this batch,
   * or earlier: an item carries `renumbered_from`) is ambiguous and not applied.
   */
  private async resolveRef(
    caller: Caller,
    ref: string,
    batch: Batch,
    mode: 'read' | 'write',
  ): Promise<{
    item: LoadedItem | null
    ambiguous: { code: string; ref: string; candidates: string[] } | null
  }> {
    const h = parseHandle(ref)
    if (h && h.kind === 'decision' && !h.shared) {
      const mapped = batch.map.get(h.number)
      if (mapped !== undefined && mapped !== h.number) {
        return {
          item: null,
          ambiguous: { code: 'ambiguous_ref', ref, candidates: [adrHandle(h.number), adrHandle(mapped)] },
        }
      }
      if (mapped === undefined) {
        const [moved] = await this.db
          .select({ adr: items.adrNumber })
          .from(items)
          .where(
            and(
              eq(items.projectId, caller.project.id),
              sql`${items.frontmatter} ->> 'renumbered_from' = ${String(h.number)}`,
            ),
          )
          .limit(1)
        if (moved?.adr) {
          return {
            item: null,
            ambiguous: {
              code: 'ambiguous_ref',
              ref,
              candidates: [adrHandle(h.number), adrHandle(moved.adr)],
            },
          }
        }
      }
    }
    return { item: await this.tryResolve(caller, ref, mode), ambiguous: null }
  }

  private async pass2(caller: Caller, p: Pass1, batch: Batch): Promise<void> {
    const { parsed } = p
    const warnings = p.result.warnings
    const actor = actorOf(caller)
    type Op = (tx: Tx, self: LoadedItem) => Promise<void>
    const ops: Op[] = []
    const prepared: Map<string, Awaited<ReturnType<ItemService['prepare']>>> = new Map()

    for (const r of parsed.relations) {
      const { item, ambiguous } = await this.resolveRef(caller, r.to, batch, 'read')
      if (ambiguous) warnings.push(ambiguous)
      else if (!item) warnings.push({ code: 'unresolved_relation', ref: r.to })
      else if (item.id !== p.row.id)
        ops.push(async (tx, self) => void (await addEdge(tx, self, r.kind, item, actor)))
    }
    if (parsed.supersedes) {
      const { item, ambiguous } = await this.resolveRef(caller, parsed.supersedes, batch, 'write')
      if (ambiguous) warnings.push(ambiguous)
      else if (!item || item.space !== parsed.space || item.id === p.row.id) {
        warnings.push({ code: 'unresolved_supersedes', ref: parsed.supersedes })
      } else {
        if (item.status !== 'superseded') prepared.set(item.id, await this.items.prepare(item))
        ops.push(async (tx, self) => {
          const settings = await this.items.projectSettings(self.projectId)
          await this.items.applySupersede(tx, caller, self, item, {
            obsDays: settings.cleanup.observation_days,
            prepared: prepared.get(item.id) ?? null,
          })
        })
      }
    }
    if (parsed.supersededBy) {
      const { item, ambiguous } = await this.resolveRef(caller, parsed.supersededBy, batch, 'write')
      if (ambiguous) warnings.push(ambiguous)
      else if (!item || item.space !== parsed.space || item.id === p.row.id) {
        warnings.push({ code: 'unresolved_supersedes', ref: parsed.supersededBy })
      } else ops.push(async (tx, self) => void (await addEdge(tx, item, 'supersedes', self, actor)))
    }
    for (const ref of parsed.draftedFrom) {
      const { item, ambiguous } = await this.resolveRef(caller, ref, batch, 'write')
      if (ambiguous) warnings.push(ambiguous)
      else if (item?.space !== 'memories') warnings.push({ code: 'unresolved_drafted_from', ref })
      else ops.push(async (tx, self) => void (await addEdge(tx, self, 'drafted_from', item, actor)))
    }
    if (ops.length === 0) return
    await withTx(this.db, async (tx) => {
      await lockProjectForWrite(tx, p.row.projectId)
      const self = (await loadItem(tx, p.row.id, true)) as LoadedItem
      for (const op of ops) await op(tx, self)
    })
  }
}

function toPushError(sourcePath: string, err: unknown): PushError {
  if (err instanceof ApiError) {
    const out: PushError = { source_path: sourcePath, error: err.code }
    if (err.publicMessage) out.message = err.publicMessage
    if (err.details) out.details = err.details
    return out
  }
  throw err
}
