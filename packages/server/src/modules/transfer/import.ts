/**
 * Writing a parsed archive into the database, in ONE transaction (data-model.md section 8, import steps 2 to
 * 8; auth-and-security.md section 9). Lossless archives keep ids, numbers, revisions and edges; a folder of
 * Markdown files becomes new items. Chunk rows are written here with NULL embeddings (no embedding call
 * holds the transaction); the `embed-pending` job, nudged after the commit, fills them.
 *
 * Provenance is marked, never forged: no row written here carries a user id or a token id.
 */
import {
  extractWikilinks,
  isReservedSlugShape,
  isValidProjectSlug,
  itemSlug,
  parseHandle,
  projectSettingsPatch,
  refHandle,
  uniqueSlug,
} from '@spoor/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { auditLog, edges, itemRevisions, items, projects } from '../../db/schema.js'
import { webActor, writeAudit } from '../../lib/audit.js'
import { isUniqueViolation, pgError, type Tx, withTx } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError } from '../../lib/errors.js'
import type { Space } from '../../ports.js'
import type { UserContext } from '../auth/index.js'
import { canonicalFrontmatter, itemHandle } from '../items/index.js'
import { type ProjectRow, resolveSettings } from '../projects/index.js'
import {
  cleanClient,
  type FileItem,
  type FilesArchive,
  importedLabel,
  type LosslessArchive,
  type ParsedArchive,
  type PlannedItem,
} from './archive.js'
import { invalidArchive } from './errors.js'
import { RefIndex, type RefRow } from './refs.js'

export type ImportTarget =
  | { kind: 'new'; slug: string; name: string }
  | { kind: 'existing'; project: ProjectRow }

export interface ImportOptions {
  parsed: ParsedArchive
  target: ImportTarget
  remapIds: boolean
  importer: UserContext
}

/** What the chunk step at the end of the import transaction needs for one item. */
export interface IndexJob {
  id: string
  projectId: string
  space: Space
  title: string
  tags: string[]
  body: string
  revision: number
}

export interface ImportResponse {
  project: { slug: string }
  counts: { items: number; revisions: number; edges: number; audit: number }
  remapped: boolean
  appended_revisions: string[]
  dangling_edges: { from: string; dst_ref: string }[]
  notes: string[]
}

export interface ImportOutcome {
  response: ImportResponse
  projectId: string
  toIndex: IndexJob[]
}

const BATCH = 200
const MAX_LISTED = 100

async function batched<T>(rows: T[], fn: (chunk: T[]) => Promise<unknown>, size = BATCH): Promise<void> {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size))
}

/** One import or export at a time per instance, across processes (the in-process flag is in service.ts). */
export async function takeTransferLock(tx: Tx): Promise<void> {
  const res = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext('spoor.transfer')) AS ok`)
  if (!(res.rows[0] as { ok: boolean } | undefined)?.ok) {
    throw new ApiError('busy', {
      message: 'Another import or export is running.',
      hint: 'Try again in a minute.',
    })
  }
}

/** A database error caused by archive content is the archive's fault (422), not a 500. */
function mapDbError(err: unknown): unknown {
  if (err instanceof ApiError) return err
  if (isUniqueViolation(err, 'projects_slug_key')) {
    return new ApiError('slug_taken', { message: 'That project slug is taken.' })
  }
  const pg = pgError(err)
  // SPL01 / SPL02: the library guards of migration 0004 (the importer drops such edges first; a hit here is
  // still the archive's content, never a server fault)
  if (
    pg &&
    (pg.code.startsWith('22') ||
      pg.code.startsWith('23') ||
      pg.code === 'P0002' ||
      pg.code === 'SPL01' ||
      pg.code === 'SPL02')
  ) {
    return invalidArchive('The archive violates a database constraint.', [
      { message: pg.constraint ?? `database error ${pg.code}` },
    ])
  }
  return err
}

export async function importArchive(deps: ServerDeps, o: ImportOptions): Promise<ImportOutcome> {
  try {
    return await withTx(deps.db, async (tx) => {
      const outcome =
        o.parsed.kind === 'lossless'
          ? await importLossless(tx, deps, o, o.parsed)
          : await importFiles(tx, deps, o, o.parsed)
      // step 8: chunk rows with NULL embeddings for every model of the locked set, in THIS transaction, so
      // full-text search works at once and nothing depends on a background task surviving; the
      // embed-pending job fills the embeddings (review D-import-chunks)
      for (const j of outcome.toIndex) {
        const source = { projectId: j.projectId, space: j.space, title: j.title, tags: j.tags, body: j.body }
        await deps.ports.search.indexItemChunks(
          tx,
          { id: j.id, projectId: j.projectId, space: j.space, revision: j.revision },
          { source, models: [], chunks: [], pending: true },
        )
      }
      return outcome
    })
  } catch (err) {
    throw mapDbError(err)
  }
}

// ---- project resolution (shared by both kinds) ------------------------------------------------------------

async function resolveTarget(
  tx: Tx,
  deps: ServerDeps,
  o: ImportOptions,
  p: { kind: 'project' | 'shared' | null; manifest?: LosslessArchive['manifest']; requireEmpty: boolean },
  newProjectId: string | null,
): Promise<{ project: ProjectRow; created: boolean; notes: string[] }> {
  const notes: string[] = []
  if (o.target.kind === 'new') {
    if (p.kind === 'shared') {
      throw invalidArchive('An archive of the shared space can only be imported into the shared space.')
    }
    if (!isValidProjectSlug(o.target.slug))
      throw new ApiError('invalid_input', { message: 'Invalid project slug.' })
    const taken = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.slug, o.target.slug))
      .limit(1)
    if (taken.length > 0)
      throw new ApiError('slug_taken', { message: `The project slug "${o.target.slug}" is taken.` })
    let settings: Record<string, unknown> = {}
    let provider = deps.ports.embeddings.defaultProvider
    if (p.manifest) {
      const parsed = projectSettingsPatch.safeParse(p.manifest.project.settings)
      if (!parsed.success) {
        throw invalidArchive('Project settings in the manifest are invalid.', [
          { path: 'manifest.project.settings', message: 'invalid settings' },
        ])
      }
      settings = { ...p.manifest.project.settings }
      const named = parsed.data.embedding?.provider
      if (named !== undefined) {
        const found = deps.ports.embeddings.byName(named)
        if (found) provider = found
        else {
          delete settings.embedding
          notes.push(
            `The embedding provider "${named}" is not enabled here; the project uses the default provider.`,
          )
        }
      }
    } else {
      settings = { embedding: { provider: provider.name } }
    }
    const [row] = await tx
      .insert(projects)
      .values({
        ...(newProjectId ? { id: newProjectId } : {}),
        kind: 'project',
        slug: o.target.slug,
        name: o.target.name,
        description: p.manifest?.project.description ?? '',
        settings,
        embeddingModel: provider.tag,
        createdBy: o.importer.user.id,
      })
      .returning()
    await writeAudit(tx, webActor(o.importer), {
      action: 'project.create',
      summary: `${o.importer.user.email} created project ${o.target.slug} from an archive`,
      data: { project_id: (row as ProjectRow).id, slug: o.target.slug, name: o.target.name, imported: true },
    })
    return { project: row as ProjectRow, created: true, notes }
  }
  const [row] = await tx.select().from(projects).where(eq(projects.id, o.target.project.id)).for('update')
  if (!row) throw new ApiError('not_found', { message: 'No such project.' })
  if (p.kind !== null && row.kind !== p.kind) {
    throw invalidArchive(
      p.kind === 'shared'
        ? 'An archive of the shared space cannot be imported into a project.'
        : 'An archive of a project cannot be imported into the shared space.',
    )
  }
  if (p.requireEmpty) {
    const [n] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(items)
      .where(eq(items.projectId, row.id))
    if ((n?.n ?? 0) > 0) {
      throw new ApiError('project_not_empty', {
        message: 'The target project already has items.',
        hint: 'Import into a new project, or into an empty one.',
      })
    }
  }
  return { project: row, created: false, notes }
}

async function existingIds(tx: Tx, table: typeof items | typeof edges, ids: string[]): Promise<string[]> {
  const found: string[] = []
  for (let i = 0; i < ids.length; i += 5000) {
    const chunk = ids.slice(i, i + 5000)
    const rows = await tx.select({ id: table.id }).from(table).where(inArray(table.id, chunk))
    for (const r of rows) found.push(r.id)
  }
  return found
}

async function sharedRows(tx: Tx): Promise<RefRow[]> {
  return tx
    .select({
      id: items.id,
      space: items.space,
      number: items.number,
      adrNumber: items.adrNumber,
      slug: items.slug,
    })
    .from(items)
    .innerJoin(projects, eq(projects.id, items.projectId))
    .where(eq(projects.kind, 'shared'))
}

const date = (s: string | null) => (s === null ? null : new Date(s))
/** A timestamp from the archive, never later than the import (database time). */
const notFuture = (s: string) => sql`least(${s}::timestamptz, now())`

/** Rewrite the ids that frontmatter snapshots carry (`spoor_id`, `supersedes`, `relations[].to`, `drafted_from`). */
export function rewriteSnapshotIds(
  fm: Record<string, unknown>,
  map: Map<string, string>,
): Record<string, unknown> {
  const swap = (v: unknown) => (typeof v === 'string' ? (map.get(v.toLowerCase()) ?? v) : v)
  const out: Record<string, unknown> = { ...fm }
  if ('spoor_id' in out) out.spoor_id = swap(out.spoor_id)
  if ('supersedes' in out) out.supersedes = swap(out.supersedes)
  if (Array.isArray(out.relations)) {
    out.relations = (out.relations as unknown[]).map((r) =>
      r && typeof r === 'object'
        ? { ...(r as Record<string, unknown>), to: swap((r as Record<string, unknown>).to) }
        : r,
    )
  }
  if (Array.isArray(out.drafted_from)) out.drafted_from = (out.drafted_from as unknown[]).map(swap)
  return out
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Edge kinds that never cross into the shared space (they change the target's status / meaning). */
const SYSTEM_KINDS = new Set<string>(['supersedes', 'drafted_from'])

/**
 * The edges an import never writes between a library page and another item (ADR-0014): `conflicts_with`
 * across the boundary in either direction, `drafted_from` into a library page, and any `supersedes` of or by a
 * library page. Wikilinks and refines / supports / depends_on out of or into a library page are kept.
 * `dstSpace` null (an unresolved target) is refused only for `supersedes` and `conflicts_with` out of a library
 * page, so a crafted archive cannot leave those dangling. Layering: this importer drops every supersedes of or by
 * a library page, while the database trigger still accepts a library-to-library supersedes.
 */
export function refusedLibraryEdge(kind: string, srcSpace: Space, dstSpace: Space | null): boolean {
  const srcLib = srcSpace === 'library'
  if (dstSpace === null) return srcLib && (kind === 'supersedes' || kind === 'conflicts_with')
  const dstLib = dstSpace === 'library'
  if (kind === 'supersedes') return srcLib || dstLib
  if (srcLib === dstLib) return false
  if (kind === 'conflicts_with') return true
  return kind === 'drafted_from' && dstLib
}

/**
 * A wikilink of a library page is never captured or taken over by another item (ADR-0014): it stays dangling
 * until a library page with that slug exists, and a resolved one keeps its target.
 */
export function libraryClaimAllowed(
  srcSpace: Space,
  currentDstId: string | null,
  newDstSpace: Space,
): boolean {
  if (srcSpace !== 'library') return true
  return currentDstId === null && newDstSpace === 'library'
}

/** The space a `shared:<space>/<slug>` typed ref names, or null for any other ref. */
function sharedRefSpace(dstRef: string): Space | null {
  const m = /^shared:(memories|decisions|docs|library)\//.exec(dstRef)
  return m ? (m[1] as Space) : null
}

const emptyTaken = (): Record<Space, Set<string>> => ({
  memories: new Set(),
  decisions: new Set(),
  docs: new Set(),
  library: new Set(),
})

/**
 * Slugs shaped like a handle (`m42`, `d7`, `l3`, `adr-7`, a uuid) would shadow one: they get the `x-` prefix
 * the API gives them (`itemSlug`), unique within the space, and each rename is a note.
 */
function renameReservedSlugs(
  rows: { id: string; space: Space; slug: string; path: string }[],
  notes: string[],
): Map<string, string> {
  const taken = emptyTaken()
  for (const r of rows) taken[r.space].add(r.slug)
  const out = new Map<string, string>()
  for (const r of rows) {
    if (!isReservedSlugShape(r.slug)) continue
    const slug = uniqueSlug(itemSlug(r.slug), taken[r.space])
    taken[r.space].add(slug)
    out.set(r.id, slug)
    notes.push(`${r.path}: the slug "${r.slug}" has the shape of a handle; imported as "${slug}".`)
  }
  return out
}

// ---- lossless -------------------------------------------------------------------------------------------

async function importLossless(
  tx: Tx,
  deps: ServerDeps,
  o: ImportOptions,
  a: LosslessArchive,
): Promise<ImportOutcome> {
  await takeTransferLock(tx)
  const { manifest } = a
  const targetKind = manifest.project.kind

  // ids: kept unless something in the instance already has them
  const itemIds = a.items.map((i) => i.m.id)
  const edgeIds = a.edges.map((e) => e.id)
  const clashing = [...(await existingIds(tx, items, itemIds)), ...(await existingIds(tx, edges, edgeIds))]
  let projectIdClash = false
  if (o.target.kind === 'new') {
    projectIdClash =
      (
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, manifest.project.id))
          .limit(1)
      ).length > 0
  }
  if ((clashing.length > 0 || projectIdClash) && !o.remapIds) {
    throw new ApiError('id_collision', {
      message: 'Some ids in the archive already exist on this instance.',
      hint: 'Retry with remap_ids=true to give everything new ids.',
      // no ids and no count: they would tell whether chosen uuids exist in projects the importer cannot
      // see (data-model.md section 0, review S6)
    })
  }
  const idMap = new Map<string, string>()
  if (o.remapIds) {
    for (const id of [...itemIds, ...edgeIds]) idMap.set(id, crypto.randomUUID())
  }
  const mapId = (id: string) => idMap.get(id) ?? id

  const newProjectId = o.remapIds ? null : manifest.project.id
  const { project, notes: targetNotes } = await resolveTarget(
    tx,
    deps,
    o,
    { kind: targetKind, manifest, requireEmpty: true },
    newProjectId,
  )
  const targetShared = project.kind === 'shared'
  const notes = [...a.notes, ...targetNotes]
  if (o.remapIds) {
    notes.push('Items were given new ids; repo files that carry the old spoor_id no longer match.')
  }
  const renamedSlug = renameReservedSlugs(
    a.items.map((i) => ({ id: i.m.id, space: i.m.space, slug: i.m.slug, path: i.m.path })),
    notes,
  )

  // counters: numbers a project once used are never reused
  const maxNumber = a.items.reduce((n, i) => Math.max(n, i.m.number), 0)
  const maxAdr = a.items.reduce((n, i) => Math.max(n, i.m.adr_number ?? 0), 0)
  const nextItem = Math.max(project.nextItemNumber, manifest.project.next_item_number, maxNumber + 1)
  const nextAdr = Math.max(project.nextAdrNumber, manifest.project.next_adr_number, maxAdr + 1)
  await tx
    .update(projects)
    .set({ nextItemNumber: nextItem, nextAdrNumber: nextAdr })
    .where(eq(projects.id, project.id))

  // items
  await batched(a.items, (chunk) =>
    tx.insert(items).values(
      chunk.map((pi) => {
        const m = pi.m
        const c = pi.content
        return {
          id: mapId(m.id),
          projectId: project.id,
          space: m.space,
          number: m.number,
          adrNumber: m.adr_number,
          slug: renamedSlug.get(m.id) ?? m.slug,
          title: c.title,
          type: c.type,
          status: c.status,
          lifecycle: m.lifecycle,
          confidence: c.confidence,
          tags: c.tags,
          anchors: c.anchors,
          frontmatter: c.extras,
          body: c.body,
          revision: pi.revision,
          pinned: m.pinned,
          decidedOn: pi.decidedOn,
          statusChangedAt: pi.statusChangedAt,
          sourcePath: m.source_path,
          // the manifest is user-editable: a future time would keep an item from ever going stale
          lastVerifiedAt: notFuture(m.last_verified_at),
          lastUsedAt: m.last_used_at === null ? null : notFuture(m.last_used_at),
          expiresAt: date(m.expires_at),
          staleSince: date(m.stale_since),
          archivedAt: date(m.archived_at),
          archiveReason: m.archive_reason,
          pushConflictAt: date(m.push_conflict_at),
          provenance: m.provenance,
          createdAt: new Date(m.created_at),
          createdBy: null,
          createdByLabel: importedLabel(m.created_by_label),
          updatedAt: notFuture(pi.updatedAt.toISOString()),
          updatedBy: null,
          updatedByLabel: pi.updatedByLabel,
          clientName: cleanClient(m.client_name),
        }
      }),
    ),
  )

  // revisions (original created_at; the append-only trigger blocks only UPDATE and DELETE)
  const revisionRows = a.items.flatMap((pi) =>
    pi.revisions.map((r) => ({
      itemId: mapId(pi.m.id),
      revision: r.revision,
      title: r.title,
      body: r.body,
      status: r.status,
      frontmatter: o.remapIds ? rewriteSnapshotIds(r.frontmatter, idMap) : r.frontmatter,
      change: r.change,
      actorUserId: null,
      actorLabel: r.actorLabel,
      tokenId: null,
      via: r.via,
      clientName: r.clientName,
      importedFrom: r.importedFrom,
      createdAt: r.createdAt,
    })),
  )
  await batched(revisionRows, (chunk) => tx.insert(itemRevisions).values(chunk))

  // edges
  const byOldId = new Map<string, PlannedItem>(a.items.map((i) => [i.m.id, i]))
  const needsShared = !targetShared && a.edges.some((e) => e.dst_ref.startsWith('shared:'))
  const shared = needsShared ? new RefIndex(await sharedRows(tx)) : null
  const dangling: { from: string; dst_ref: string }[] = []
  const dropped: string[] = []
  const edgeRows = a.edges.flatMap((e) => {
    const src = byOldId.get(e.src_id) as PlannedItem
    const from = itemHandle(
      { space: src.m.space, number: src.m.number, adrNumber: src.m.adr_number },
      targetShared,
    )
    const isWiki = e.kind === 'wikilink'
    let dstId: string | null = null
    let dstRef = e.dst_ref
    // the target's space, for the library edge rule: an archive item's, a resolved shared item's, or the
    // `<space>` of a `shared:<space>/<slug>` ref (so a dangling typed edge is classified too)
    let dstSpace: Space | null = null
    const viaShared = e.dst_ref.startsWith('shared:') && !targetShared
    if (viaShared) {
      const rest = e.dst_ref.slice('shared:'.length)
      // `supersedes` / `drafted_from` stay inside a project: an edge into `_shared` would mark a shared
      // item superseded for every project (auth-and-security.md section 8, review S2); kept dangling
      if (!SYSTEM_KINDS.has(e.kind))
        dstId = (isWiki ? shared?.resolveWikilink(rest, src.m.space) : shared?.bySpaceSlug(rest)) ?? null
      dstSpace = (dstId ? shared?.rowOf(dstId)?.space : undefined) ?? sharedRefSpace(e.dst_ref)
    } else if (e.dst_id !== null) {
      const dst = byOldId.get(e.dst_id)
      if (dst) {
        dstId = mapId(e.dst_id)
        dstSpace = dst.m.space
      }
    } else if (targetShared) {
      dstSpace = sharedRefSpace(e.dst_ref)
    }
    if (refusedLibraryEdge(e.kind, src.m.space, dstSpace)) {
      if (dropped.length < MAX_LISTED)
        dropped.push(`${from}: ${e.kind} edge to ${e.dst_ref.slice(0, 120)} dropped (library link rule).`)
      return []
    }
    if (dstId === null && (viaShared || e.dst_id !== null)) dangling.push({ from, dst_ref: e.dst_ref })
    // a renamed reserved slug: the link that named it by slug names the new slug (like migration 0004)
    const renamed = isWiki && e.dst_id !== null ? renamedSlug.get(e.dst_id) : undefined
    if (renamed !== undefined) {
      const old = (byOldId.get(e.dst_id as string) as PlannedItem).m.slug
      if (dstRef === old) dstRef = renamed
      else if (dstRef === `shared:${old}`) dstRef = `shared:${renamed}`
    }
    if (!isWiki && o.remapIds && UUID_RE.test(dstRef)) dstRef = idMap.get(dstRef) ?? dstRef
    if (dstId === mapId(e.src_id)) {
      throw invalidArchive('An edge points at its own source.', [{ path: 'manifest.edges', message: e.id }])
    }
    return [
      {
        id: mapId(e.id),
        projectId: project.id,
        srcId: mapId(e.src_id),
        kind: e.kind,
        dstRef,
        dstId,
        createdAt: new Date(e.created_at),
        createdBy: null,
        createdByLabel: e.created_by_label === null ? null : importedLabel(e.created_by_label),
        clientName: cleanClient(e.client_name),
      },
    ]
  })
  notes.push(...dropped)
  await batched(edgeRows, (chunk) => tx.insert(edges).values(chunk))

  // audit: original timestamps, marked
  await batched(
    a.audit,
    (chunk) =>
      tx.insert(auditLog).values(
        chunk.map((l) => ({
          at: l.at,
          projectId: project.id,
          actorUserId: null,
          actorLabel: l.actorLabel,
          tokenId: null,
          via: 'import' as const,
          clientName: l.clientName,
          action: l.action,
          itemId: l.itemId === null ? null : mapId(l.itemId),
          itemHandle: l.itemHandle,
          summary: l.summary,
          data: l.data,
        })),
      ),
    500,
  )

  if (targetShared) await resolveInboundSharedEdges(tx)

  const counts = {
    items: a.items.length,
    revisions: revisionRows.length,
    edges: edgeRows.length,
    audit: a.audit.length,
  }
  await writeAudit(tx, webActor(o.importer), {
    projectId: project.id,
    action: 'project.import',
    summary: `${o.importer.user.email} imported an archive into ${project.slug}`,
    data: { counts, remapped: o.remapIds, history: manifest.history, source_slug: manifest.project.slug },
  })

  const appended = a.items
    .filter((i) => i.appended)
    .map((i) => itemHandle({ space: i.m.space, number: i.m.number, adrNumber: i.m.adr_number }, targetShared))
  return {
    response: {
      project: { slug: project.slug },
      counts,
      remapped: o.remapIds,
      appended_revisions: appended,
      dangling_edges: dangling.slice(0, MAX_LISTED),
      notes,
    },
    projectId: project.id,
    toIndex: a.items.map((pi) => ({
      id: mapId(pi.m.id),
      projectId: project.id,
      space: pi.m.space,
      title: pi.content.title,
      tags: pi.content.tags,
      body: pi.content.body,
      revision: pi.revision,
    })),
  }
}

/**
 * New shared items may be the target of links that were dangling in projects (`[[shared:x]]`, typed edges to
 * `shared:<space>/<slug>`): resolve every such edge again (data-model.md section 3, shared scope).
 */
async function resolveInboundSharedEdges(tx: Tx): Promise<void> {
  const index = new RefIndex(await sharedRows(tx))
  const rows = await tx
    .select({ id: edges.id, kind: edges.kind, dstRef: edges.dstRef, srcSpace: items.space })
    .from(edges)
    .innerJoin(items, eq(items.id, edges.srcId))
    .where(sql`${edges.dstId} IS NULL AND ${edges.dstRef} LIKE 'shared:%'`)
  for (const r of rows) {
    const rest = r.dstRef.slice('shared:'.length)
    const dst = r.kind === 'wikilink' ? index.resolveWikilink(rest, r.srcSpace) : index.bySpaceSlug(rest)
    if (!dst) continue
    const dstSpace = (index.rowOf(dst) as RefRow).space
    // the library rules (ADR-0014): no capture of a library page's wikilink by another item, and no edge
    // kind the library refuses (it would fail the edge trigger with SPL01 and abort this import)
    if (r.kind === 'wikilink' ? !libraryClaimAllowed(r.srcSpace, null, dstSpace) : false) continue
    if (refusedLibraryEdge(r.kind, r.srcSpace, dstSpace)) continue
    await tx.update(edges).set({ dstId: dst }).where(eq(edges.id, r.id))
  }
}

/**
 * The new items of a folder import claim the links the target project already had (data-model.md section 3,
 * review D-claim): dangling wikilinks naming a new item's slug or handle, and slug links that now resolve to a
 * new, higher-precedence item. Every existing wikilink edge whose `dst_ref` is one of the new refs is
 * re-resolved against the project's full ref index (existing plus new items) in one pass.
 */
async function claimExistingLinks(
  tx: Tx,
  projectId: string,
  index: RefIndex,
  created: RefRow[],
  targetShared: boolean,
): Promise<void> {
  if (created.length === 0) return
  const newIds = new Set(created.map((r) => r.id))
  const refs = new Set<string>()
  for (const r of created) {
    const handle = refHandle(r.space, r.number, r.adrNumber)
    for (const ref of [r.slug, handle]) {
      refs.add(ref)
      if (targetShared) refs.add(`shared:${ref}`) // inside `_shared`, both forms resolve in `_shared`
    }
  }
  const list = [...refs]
  const rows: { id: string; dstRef: string; dstId: string | null; srcId: string; srcSpace: Space }[] = []
  for (let i = 0; i < list.length; i += 1000) {
    rows.push(
      ...(await tx
        .select({
          id: edges.id,
          dstRef: edges.dstRef,
          dstId: edges.dstId,
          srcId: edges.srcId,
          srcSpace: items.space,
        })
        .from(edges)
        .innerJoin(items, eq(items.id, edges.srcId))
        .where(
          and(
            eq(edges.projectId, projectId),
            eq(edges.kind, 'wikilink'),
            inArray(edges.dstRef, list.slice(i, i + 1000)),
          ),
        )),
    )
  }
  const byTarget = new Map<string, string[]>()
  for (const r of rows) {
    if (newIds.has(r.srcId)) continue // resolved when they were planned
    const dst = index.resolveWikilink(r.dstRef.replace(/^shared:/, ''), r.srcSpace)
    if (!dst || dst === r.dstId || dst === r.srcId || !newIds.has(dst)) continue
    // a library page's link is claimed only by a library page and never taken over (ADR-0014)
    if (!libraryClaimAllowed(r.srcSpace, r.dstId, (index.rowOf(dst) as RefRow).space)) continue
    byTarget.set(dst, [...(byTarget.get(dst) ?? []), r.id])
  }
  for (const [dst, ids] of byTarget) {
    await batched(ids, (chunk) => tx.update(edges).set({ dstId: dst }).where(inArray(edges.id, chunk)), 1000)
  }
}

// ---- a folder of Markdown files ---------------------------------------------------------------------------

async function importFiles(
  tx: Tx,
  deps: ServerDeps,
  o: ImportOptions,
  a: FilesArchive,
): Promise<ImportOutcome> {
  await takeTransferLock(tx)
  const { project, notes: targetNotes } = await resolveTarget(
    tx,
    deps,
    o,
    { kind: null, requireEmpty: false },
    null,
  )
  const targetShared = project.kind === 'shared'
  const notes = [...a.notes, ...targetNotes]
  const label = importedLabel(o.importer.user.email)
  const settings = resolveSettings(project.settings)
  const now = new Date()

  const existing = await tx
    .select({
      id: items.id,
      space: items.space,
      number: items.number,
      adrNumber: items.adrNumber,
      slug: items.slug,
    })
    .from(items)
    .where(eq(items.projectId, project.id))
  const takenSlugs = emptyTaken()
  const usedAdr = new Set<number>()
  for (const r of existing) {
    takenSlugs[r.space].add(r.slug)
    if (r.adrNumber !== null) usedAdr.add(r.adrNumber)
  }

  // ADR numbers: explicit and free first, the rest from the counter (renumbered ones remember the old number)
  const adrOf = new Map<FileItem, { n: number; renumberedFrom: number | null }>()
  const decisions = a.files.filter((f) => f.space === 'decisions')
  for (const f of decisions) {
    if (f.adr !== null && !usedAdr.has(f.adr)) {
      usedAdr.add(f.adr)
      adrOf.set(f, { n: f.adr, renumberedFrom: null })
    }
  }
  let nextAdr = project.nextAdrNumber
  for (const f of decisions) {
    if (adrOf.has(f)) continue
    while (usedAdr.has(nextAdr)) nextAdr++
    usedAdr.add(nextAdr)
    adrOf.set(f, { n: nextAdr, renumberedFrom: f.adr })
  }
  const adrCounter = Math.max(project.nextAdrNumber, ...[...usedAdr].map((n) => n + 1))

  // ids, numbers, slugs
  let number = project.nextItemNumber
  const planned = a.files.map((f) => {
    const id = crypto.randomUUID()
    let slug = itemSlug(f.slug)
    slug = uniqueSlug(slug, takenSlugs[f.space])
    takenSlugs[f.space].add(slug)
    if (isReservedSlugShape(f.slug))
      notes.push(`${f.path}: the slug "${f.slug}" has the shape of a handle; imported as "${slug}".`)
    const adr =
      f.space === 'decisions' ? (adrOf.get(f) as { n: number; renumberedFrom: number | null }) : null
    const extras = {
      ...f.content.extras,
      ...(adr?.renumberedFrom != null ? { renumbered_from: adr.renumberedFrom } : {}),
    }
    return { f, id, number: number++, slug, adrNumber: adr?.n ?? null, extras }
  })

  const refRows: RefRow[] = [
    ...existing,
    ...planned.map((p) => ({
      id: p.id,
      space: p.f.space,
      number: p.number,
      adrNumber: p.adrNumber,
      slug: p.slug,
    })),
  ]
  const local = new RefIndex(refRows)
  const sharedIndex = targetShared ? null : new RefIndex(await sharedRows(tx))
  // folder-local lookups for relations / supersedes / drafted_from
  const bySpoorId = new Map<string, string>()
  const bySlug = new Map<string, string[]>()
  const byAdr = new Map<number, string>()
  for (const p of planned) {
    if (p.f.spoorId) bySpoorId.set(p.f.spoorId, p.id)
    bySlug.set(p.f.slug, [...(bySlug.get(p.f.slug) ?? []), p.id])
    if (p.f.space === 'decisions' && p.f.adr !== null) byAdr.set(p.f.adr, p.id)
  }
  const unresolved: string[] = []
  const resolveRef = (
    from: string,
    to: string,
    allowShared = true,
  ): { id: string | null; ref: string } | null => {
    const t = to.trim()
    const found = ((): { id: string | null; ref: string } | null => {
      const sharedRef = /^shared:(memories|decisions|docs|library)\/([a-z0-9-]+)$/.exec(t)
      // `supersedes` / `drafted_from` resolve only inside the archive (review S2): listed as unresolved
      if (!allowShared && (sharedRef || parseHandle(t)?.shared)) return null
      if (sharedRef) {
        const id = sharedIndex?.bySpaceSlug(`${sharedRef[1]}/${sharedRef[2]}`)
        return id ? { id, ref: t } : null
      }
      const handle = parseHandle(t)
      if (handle?.shared) {
        const id = sharedIndex?.resolveWikilink(t.slice(2), 'memories')
        const row = id ? sharedIndex?.rowOf(id) : undefined
        return id && row ? { id, ref: `shared:${row.space}/${row.slug}` } : null
      }
      if (UUID_RE.test(t.toLowerCase())) {
        const id = bySpoorId.get(t.toLowerCase())
        return id ? { id, ref: id } : null
      }
      const adr = /^adr-0*(\d+)$/i.exec(t)
      if (adr) {
        const id = byAdr.get(Number.parseInt(adr[1] as string, 10))
        return id ? { id, ref: id } : null
      }
      if (/^[mdl]\d+$/i.test(t)) return null // numbers of files in a folder mean nothing
      const hits = bySlug.get(t)
      return hits?.length === 1 ? { id: hits[0] as string, ref: hits[0] as string } : null
    })()
    if (!found && unresolved.length < MAX_LISTED)
      unresolved.push(`${from}: unresolved reference "${t.slice(0, 80)}"`)
    return found
  }

  const edgeRows: (typeof edges.$inferInsert)[] = []
  const seen = new Set<string>()
  const addEdge = (
    srcId: string,
    kind: (typeof edges.$inferInsert)['kind'],
    dstRef: string,
    dstId: string | null,
  ) => {
    if (dstId === srcId) return
    const key = `${srcId}|${kind}|${dstRef}`
    if (seen.has(key)) return
    seen.add(key)
    edgeRows.push({
      id: crypto.randomUUID(),
      projectId: project.id,
      srcId,
      kind,
      dstRef,
      dstId,
      createdAt: now,
      createdBy: null,
      createdByLabel: label,
      clientName: null,
    })
  }
  const dropped: string[] = []
  const spaceOf = (id: string | null): Space | null =>
    id === null ? null : (local.rowOf(id)?.space ?? sharedIndex?.rowOf(id)?.space ?? null)
  /** A typed edge, unless the library edge rule refuses it (ADR-0014): then dropped and listed. */
  const addTyped = (
    p: (typeof planned)[number],
    kind: 'refines' | 'supersedes' | 'drafted_from',
    t: { id: string | null; ref: string } | null,
    to: string,
  ) => {
    if (!t) return
    if (refusedLibraryEdge(kind, p.f.space, spaceOf(t.id))) {
      if (dropped.length < MAX_LISTED)
        dropped.push(`${p.f.path}: ${kind} edge to ${to.slice(0, 80)} dropped (library link rule).`)
      return
    }
    addEdge(p.id, kind, t.ref, t.id)
  }
  for (const p of planned) {
    const from = p.f.path
    for (const r of p.f.relations) addTyped(p, r.kind as 'refines', resolveRef(from, r.to), r.to)
    if (p.f.supersedes) addTyped(p, 'supersedes', resolveRef(from, p.f.supersedes, false), p.f.supersedes)
    for (const d of p.f.draftedFrom) addTyped(p, 'drafted_from', resolveRef(from, d, false), d)
    for (const l of extractWikilinks(p.f.content.body)) {
      const dst = l.shared
        ? (targetShared ? local : sharedIndex)?.resolveWikilink(l.ref, p.f.space)
        : local.resolveWikilink(l.ref, p.f.space)
      addEdge(p.id, 'wikilink', l.dstRef, dst ?? null)
    }
  }

  const itemRows = planned.map((p) => {
    const c = p.f.content
    // like push (`least(last_verified, now())`): a future date would keep the item from ever going stale
    const verified = p.f.lastVerified && p.f.lastVerified < now ? p.f.lastVerified : now
    return {
      id: p.id,
      projectId: project.id,
      space: p.f.space,
      number: p.number,
      adrNumber: p.adrNumber,
      slug: p.slug,
      title: c.title,
      type: c.type,
      status: c.status,
      confidence: c.confidence,
      tags: c.tags,
      anchors: c.anchors,
      frontmatter: p.extras,
      body: c.body,
      revision: 1,
      pinned: p.f.pinned,
      decidedOn: p.f.decidedOn,
      statusChangedAt: now,
      lastVerifiedAt: verified,
      expiresAt:
        c.type === 'observation'
          ? new Date(now.getTime() + settings.cleanup.observation_days * 86_400_000)
          : null,
      provenance: 'human' as const,
      createdAt: now,
      createdBy: null,
      createdByLabel: label,
      updatedAt: now,
      updatedBy: null,
      updatedByLabel: label,
      clientName: null,
    }
  })
  await batched(itemRows, (chunk) => tx.insert(items).values(chunk))
  await batched(
    planned.map((p) => ({
      itemId: p.id,
      revision: 1,
      title: p.f.content.title,
      body: p.f.content.body,
      status: p.f.content.status,
      frontmatter: canonicalFrontmatter({
        ...p.f.content,
        id: p.id,
        space: p.f.space,
        adrNumber: p.adrNumber,
        decidedOn: p.f.decidedOn,
        extras: p.extras,
      }),
      change: 'import' as const,
      actorUserId: null,
      actorLabel: label,
      tokenId: null,
      via: 'import' as const,
      clientName: null,
      importedFrom: null,
      createdAt: now,
    })),
    (chunk) => tx.insert(itemRevisions).values(chunk),
  )
  await batched(edgeRows, (chunk) => tx.insert(edges).values(chunk))
  await tx
    .update(projects)
    .set({ nextItemNumber: number, nextAdrNumber: adrCounter })
    .where(eq(projects.id, project.id))
  await claimExistingLinks(
    tx,
    project.id,
    local,
    planned.map((p) => ({
      id: p.id,
      space: p.f.space,
      number: p.number,
      adrNumber: p.adrNumber,
      slug: p.slug,
    })),
    targetShared,
  )
  if (targetShared) await resolveInboundSharedEdges(tx)

  const counts = { items: planned.length, revisions: planned.length, edges: edgeRows.length, audit: 0 }
  await writeAudit(tx, webActor(o.importer), {
    projectId: project.id,
    action: 'project.import',
    summary: `${o.importer.user.email} imported ${planned.length} Markdown files into ${project.slug}`,
    data: { counts, remapped: false, history: false, manifest: false },
  })
  return {
    response: {
      project: { slug: project.slug },
      counts,
      remapped: false,
      appended_revisions: [],
      dangling_edges: [],
      notes: [...notes, ...unresolved, ...dropped],
    },
    projectId: project.id,
    toIndex: planned.map((p) => ({
      id: p.id,
      projectId: project.id,
      space: p.f.space,
      title: p.f.content.title,
      tags: p.f.content.tags,
      body: p.f.content.body,
      revision: 1,
    })),
  }
}
