/**
 * The item service (data-model.md sections 3 and 6, api.md section 5, mcp.md section 5 semantics,
 * cleanup-and-jobs.md sections 1 to 3). One implementation for every surface: the web routes, the MCP
 * tools and the CLI push call the same methods with a `Caller` (`via` = web | mcp | cli).
 *
 * Rules that live here (not in the routes):
 * - shared-space writes: humans in the web UI with IA or `shared_editor` only; library pages: humans in the
 *   web UI holding `library.write` only (`assertWritable`: a no-space entry check, then the space-aware
 *   check on every resolved write target and every insert);
 * - library pages are never pinned, verified or superseded (`wrong_space`), their status is `active`;
 * - every id goes through the project-scoped resolver (write positions: own project; reads and edge
 *   targets: own project plus `_shared`);
 * - content writes use the one content statement (`writeContent`), then wikilinks and chunks;
 * - operational changes (pin, verify, archive, restore) never create a revision;
 * - provenance: `agent` after an MCP content write, `human` after a web write, verify, pin or a CLI push;
 * - `last_used_at` is bumped only by a near-duplicate hit, a `relate` target (and `spoor_get`, which calls
 *   `touchUsed`), never by REST reads, lists or search.
 */
import {
  bestStrength,
  canonicalRef,
  type GraphQuery,
  knownKeys,
  normalizeFilePath,
  RELATED_PENDING_NOTE,
  type RelatedResponse,
  relatedMinCos,
} from '@spoor/shared'
import { and, asc, desc, eq, inArray, ne, or, type SQL, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { edges, itemRevisions, items, memberships, projects } from '../../db/schema.js'
import { writeAudit } from '../../lib/audit.js'
import {
  allowPurge,
  type DbOrTx,
  escapeLike,
  isUniqueViolation,
  lockProjectForWrite,
  type Tx,
  withTx,
} from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError } from '../../lib/errors.js'
import { cursorTimestamp, decodeTypedCursor, encodeCursor } from '../../lib/pagination.js'
import type { DedupeCandidate, PreparedChunk, PreparedChunks, Space } from '../../ports.js'
import { resolveSettings } from '../projects/index.js'
import { graph } from './graph.js'
import {
  addEdge,
  claimWikilinks,
  resolveWikilinks,
  rewriteWikilinks,
  sharedProjectId,
  sqlTextArray,
  TYPED_KINDS,
  type TypedKind,
} from './links.js'
import { type ResolveMode, resolveItemRef } from './resolve.js'
import {
  handleOf,
  type ItemJson,
  itemJson,
  type LoadedItem,
  loadItem,
  loadItems,
  summaryJson,
  viewOf,
} from './rows.js'
import type { ItemCreateRequest, ItemPatchRequest, ListQuery, SupersedeRequest } from './schemas.js'
import {
  actorOf,
  allocate,
  assertWritable,
  type Caller,
  type ContentFields,
  cleanAnchors,
  cleanBody,
  cleanExtras,
  cleanTags,
  cleanTitle,
  contentOf,
  deriveSlug,
  ITEM_SLUG_CONSTRAINT,
  invalid,
  libraryGuardError,
  pickSlug,
  provenanceOf,
  sameContent,
  slugTaken,
  snapshotOf,
  stickyStatus,
  touchUsed,
  validSlug,
  writeContent,
} from './writes.js'

export type { Caller } from './writes.js'

export interface Warning {
  code: string
  [key: string]: unknown
}

/** An MCP edit of a repo-mirrored ADR or doc (mcp.md section 7, 409). REST never raises it (a warning). */
export const mirroredItem = (handle: string, sourcePath: string) =>
  new ApiError('mirrored_item', {
    message: `${handle} mirrors the repo file ${sourcePath}.`,
    hint: `edit ${sourcePath}; the PostToolUse hook pushes it`,
    details: { handle, source_path: sourcePath },
  })

/** A typed edge written by `update` with `relations` (`changed=false`: it existed already). */
export interface AddedRelation {
  kind: TypedKind
  to: LoadedItem
  edgeId: string
  changed: boolean
}

export interface DuplicateHit {
  handle: string
  id: string
  title: string
  type: string | null
  revision: number
  lifecycle: string
  cos: number
}

/** The closest item at or above the duplicate threshold of a create that was saved anyway (ADR-0025). */
export interface NearDuplicate extends DuplicateHit {
  /** Values each side states and the other lacks (`60` vs `600`): a different claim. `null` = maybe the same. */
  values: { new: string[]; existing: string[] } | null
}

export interface CreateResult {
  /** `null` when an MCP create was refused as a duplicate. */
  item: ItemJson | null
  row: LoadedItem | null
  warnings: Warning[]
  /** Set only when an MCP create was refused: the same title and body already exist. */
  duplicate: DuplicateHit | null
  /** Set when the create was saved next to a similar item (MCP: the `note: similar to` line). */
  similar: NearDuplicate | null
  /** `duplicate check skipped` etc., for the MCP text result. */
  notes: string[]
}

/** A fully cleaned new item (what every create path, incl. push, hands to `insertNew`). */
export interface NewItemSpec {
  space: Space
  fields: ContentFields
  pinned: boolean
  slug: { value: string; explicit: boolean }
  adr?: { number?: number | null; onTaken: 'error' | 'renumber'; reserveAbove?: number | null }
  /** `true`: today (web create default); a `YYYY-MM-DD`; null. Decisions only. */
  decidedToday?: boolean
  sourcePath?: string | null
  /** ISO date or date-time from a file's `last_verified` (applied on create only). */
  lastVerified?: string | null
  change?: 'create' | 'push'
}

type Cursor = (string | number | null)[]

/** Resolver refusals that skip one ref of a bulk action (`verifyMany`, `reviewBulk`) instead of failing. */
const BULK_SKIPPED = ['not_found', 'read_only_space', 'ambiguous_id']

/** Pin and verify on a library page (ADR-0014). */
const libraryNotPinned = () =>
  new ApiError('wrong_space', {
    message: 'Library pages are always in the digest; they are not pinned or verified.',
  })

const TODAY = sql<string>`(now() AT TIME ZONE 'UTC')::date`
const MEMORY_STATUSES = ['active', 'superseded']
const DECISION_STATUSES = ['proposed', 'accepted', 'superseded', 'deprecated']

export const observationDays = (settings: unknown) => resolveSettings(settings).cleanup.observation_days

export class ItemService {
  constructor(private readonly deps: ServerDeps) {}

  get db() {
    return this.deps.db
  }

  // ---- shared helpers ---------------------------------------------------------------------------------

  /**
   * Resolve `ref` in the caller's scope. A write position also runs the space-aware write rule on the
   * resolved item (`read_only_space` for a library page without the library right, `forbidden` for a
   * flagged viewer on any other item), before any space or kind check of the caller.
   */
  async resolve(caller: Caller, ref: string, mode: ResolveMode) {
    const r = await resolveItemRef(
      this.db,
      { projectId: caller.project.id, projectIsShared: caller.project.kind === 'shared', mode },
      ref,
    )
    if (mode === 'write') assertWritable(caller, r.space)
    return r
  }

  /** Resolve and load; `not_found` when the row vanished meanwhile. */
  async load(caller: Caller, ref: string, mode: ResolveMode, db: DbOrTx = this.db): Promise<LoadedItem> {
    const r = await this.resolve(caller, ref, mode)
    const row = await loadItem(db, r.id)
    if (!row) throw new ApiError('not_found')
    return row
  }

  async json(caller: Caller, row: LoadedItem, db: DbOrTx = this.db): Promise<ItemJson> {
    return itemJson(db, row, viewOf(caller.project))
  }

  async projectSettings(projectId: string) {
    const [p] = await this.db
      .select({ settings: projects.settings })
      .from(projects)
      .where(eq(projects.id, projectId))
    return resolveSettings(p?.settings)
  }

  /** Chunk + embed before any transaction; a failing provider gives a pending (NULL-embedding) set. */
  async prepare(src: {
    projectId: string
    space: Space
    title: string
    tags: string[]
    body: string
  }): Promise<PreparedChunks> {
    const source = {
      projectId: src.projectId,
      space: src.space,
      title: src.title,
      tags: src.tags,
      body: src.body,
    }
    try {
      return await this.deps.ports.search.prepareChunks(source)
    } catch (err) {
      this.deps.logger.warn({ err: (err as Error).message }, 'prepareChunks failed; storing pending chunks')
      return { source, models: [], chunks: [], pending: true }
    }
  }

  /** Inside the write transaction: replace the item's chunks at its current revision. */
  async index(tx: Tx, row: LoadedItem, prepared: PreparedChunks): Promise<boolean> {
    const r = await this.deps.ports.search.indexItemChunks(
      tx,
      { id: row.id, projectId: row.projectId, space: row.space, revision: row.revision },
      prepared,
    )
    return r.embeddingPending
  }

  /** After commit: nudge the embed-pending job and say so. */
  pendingWarning(projectId: string, pending: boolean, warnings: Warning[]) {
    if (!pending) return
    this.deps.ports.jobs.enqueue('embed-pending', { projectId })
    if (!warnings.some((w) => w.code === 'embedding_pending')) warnings.push({ code: 'embedding_pending' })
  }

  async audit(
    db: DbOrTx,
    caller: Caller,
    action: string,
    item: LoadedItem,
    summary: string,
    data: Record<string, unknown> = {},
  ) {
    await writeAudit(
      db,
      { ctx: caller.ctx, via: caller.via },
      {
        action,
        summary,
        projectId: item.projectId,
        itemId: item.id,
        // the snapshot is relative to the row's own project (plain `m1` inside `_shared`, api.md 0.6), so
        // `?item=m1` finds the history of a deleted shared item (review SC1)
        itemHandle: handleOf(item, {
          projectId: item.projectId,
          projectIsShared: item.projectKind === 'shared',
        }),
        data,
      },
    )
  }

  private async withConflictDetails<T>(caller: Caller, id: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'revision_conflict') {
        const current = await loadItem(this.db, id)
        throw new ApiError('revision_conflict', {
          message: err.publicMessage,
          hint: err.hint,
          details: { ...err.details, ...(current ? { current: await this.json(caller, current) } : {}) },
        })
      }
      throw err
    }
  }

  private checkStatus(space: Space, status: string, path = 'status') {
    const ok = space === 'decisions' ? DECISION_STATUSES : space === 'library' ? ['active'] : MEMORY_STATUSES
    if (!ok.includes(status)) throw invalid(path, `one of ${ok.join(', ')}`)
  }

  // ---- create -----------------------------------------------------------------------------------------

  /**
   * Insert a new item at revision 1 inside `tx`: numbers under the project row lock, slug, observation
   * expiry, revision snapshot, wikilinks (incl. claiming dangling links). Edges, chunks and audit are the
   * caller's.
   */
  async insertNew(tx: Tx, caller: Caller, spec: NewItemSpec) {
    // the backstop for every path that inserts rows (create, supersede, push)
    assertWritable(caller, spec.space)
    const view = viewOf(caller.project)
    const actor = actorOf(caller)
    const alloc = await allocate(tx, caller.project, spec.space, spec.adr ?? { onTaken: 'error' }, view)
    const slug = await pickSlug(tx, caller.project, spec.space, spec.slug.value, spec.slug.explicit, view)
    // a renumbered ADR remembers its repo number (server-owned extra, data-model.md section 7)
    const f: ContentFields = alloc.renumbered
      ? { ...spec.fields, extras: { ...spec.fields.extras, renumbered_from: alloc.renumbered.from } }
      : spec.fields
    const obsDays = observationDays(alloc.settings)
    const inserted = await tx
      .insert(items)
      .values({
        projectId: caller.project.id,
        space: spec.space,
        number: alloc.number,
        adrNumber: alloc.adrNumber,
        slug,
        title: f.title,
        type: f.type as LoadedItem['type'],
        status: f.status,
        confidence: f.confidence as LoadedItem['confidence'],
        tags: f.tags,
        anchors: f.anchors,
        frontmatter: f.extras,
        body: f.body,
        pinned: spec.pinned,
        decidedOn: spec.decidedToday ? TODAY : f.decidedOn,
        sourcePath: spec.sourcePath ?? null,
        lastVerifiedAt: spec.lastVerified ? sql`least(${spec.lastVerified}::timestamptz, now())` : sql`now()`,
        expiresAt: f.type === 'observation' ? sql`now() + make_interval(days => ${obsDays}::int)` : null,
        provenance: provenanceOf(caller.via),
        createdBy: actor.userId,
        createdByLabel: actor.label,
        updatedBy: actor.userId,
        updatedByLabel: actor.label,
        clientName: actor.clientName,
      })
      .returning({ id: items.id })
    const id = (inserted[0] as { id: string }).id
    const row = (await loadItem(tx, id)) as LoadedItem
    await tx
      .insert(itemRevisions)
      .values({
        itemId: id,
        revision: 1,
        title: row.title,
        body: row.body,
        status: row.status,
        frontmatter: snapshotOf(row, contentOf(row)),
        change: spec.change ?? 'create',
        actorUserId: actor.userId,
        actorLabel: actor.label,
        tokenId: actor.tokenId,
        via: actor.via,
        clientName: actor.clientName,
      })
      .catch((err: unknown) => {
        throw libraryGuardError(err)
      })
    const sharedId = await sharedProjectId(tx)
    await claimWikilinks(tx, row)
    await rewriteWikilinks(tx, row, sharedId, actor)
    return { row, renumbered: alloc.renumbered, obsDays }
  }

  /** Run `fn` in a transaction, retrying a derived-slug collision with the next suffix (mcp.md section 8). */
  async createTx<T>(explicitSlug: boolean, fn: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await withTx(this.db, fn)
      } catch (err) {
        if (isUniqueViolation(err, ITEM_SLUG_CONSTRAINT) && !explicitSlug && attempt < 4) continue
        throw err
      }
    }
  }

  /**
   * Clean the create body into content fields (space rules of api.md section 5.1). Library pages take the
   * docs rules, and are never pinned.
   */
  cleanCreate(space: Space, input: ItemCreateRequest): ContentFields {
    if (space === 'library' && input.pinned === true)
      throw invalid('pinned', 'library pages are always in the digest; they are not pinned')
    if (space === 'memories') {
      if (!input.type) throw invalid('type', 'required for memories')
    } else {
      if (input.type) throw invalid('type', 'only memories have a type')
      if (input.confidence) throw invalid('confidence', 'only memories have a confidence')
      if (input.allow_duplicate !== undefined && space === 'decisions')
        throw invalid('allow_duplicate', 'only memories and docs are checked for duplicates')
    }
    if (space !== 'decisions') {
      if (input.status) throw invalid('status', 'only decisions take a status on create')
      if (input.adr_number !== undefined) throw invalid('adr_number', 'decisions only')
      if (input.decided_on) throw invalid('decided_on', 'decisions only')
    }
    return {
      title: cleanTitle(input.title),
      body: cleanBody(input.body ?? ''),
      status: space === 'decisions' ? (input.status ?? 'proposed') : 'active',
      type: space === 'memories' ? (input.type ?? null) : null,
      confidence: space === 'memories' ? (input.confidence ?? 'medium') : null,
      tags: cleanTags(input.tags ?? []),
      anchors: cleanAnchors(input.anchors ?? []),
      extras: cleanExtras(input.extra ?? {}, knownKeys(space)),
      decidedOn: input.decided_on ?? null,
    }
  }

  /**
   * Near-duplicate check (search-and-digest.md section 5, ADR-0025). `same`: a candidate with the same title and
   * body. `similar`: the first candidate at or above the per-project threshold whose values agree, else the first
   * one at or above it whose values differ. `skipped` when no probe vector exists.
   */
  async dedupe(
    caller: Caller,
    space: Space,
    type: string | null,
    excludeItemId: string | null,
    prepared: PreparedChunks,
  ): Promise<{ same: DedupeCandidate | null; similar: DedupeCandidate | null; skipped: boolean }> {
    const settings = await this.projectSettings(caller.project.id)
    const res = await this.deps.ports.search.dedupeCandidates(this.db, {
      projectId: caller.project.id,
      space,
      type,
      excludeItemId,
      prepared,
    })
    if (res.skipped) return { same: null, similar: null, skipped: true }
    const near = res.candidates.filter((c) => c.cos >= settings.dedupe.threshold)
    return {
      same: res.candidates.find((c) => c.sameText) ?? null,
      similar: near.find((c) => c.values === null) ?? near[0] ?? null,
      skipped: false,
    }
  }

  private dupJson(caller: Caller, c: DedupeCandidate): DuplicateHit {
    const handle = handleOf({ ...c, projectKind: caller.project.kind }, viewOf(caller.project))
    return {
      handle,
      id: c.id,
      title: c.title,
      type: c.type,
      revision: c.revision,
      lifecycle: c.lifecycle,
      cos: c.cos,
    }
  }

  /**
   * Create an item (web `POST …/spaces/:space/items`, MCP `spoor_remember` / `spoor_decide` /
   * `spoor_doc_write`). Duplicates (ADR-0025): a similar item is reported and the create saved (web: a
   * `near_duplicate` warning unless the values differ; MCP: `similar`). Only MCP (`dedupe: 'block'`) refuses, and
   * only the same title and body: it writes nothing but `last_used_at` of the existing item and returns it.
   * `allow_duplicate` skips the check.
   */
  async create(
    caller: Caller,
    space: Space,
    input: ItemCreateRequest,
    opts: { dedupe?: 'warn' | 'block' | 'off' } = {},
  ): Promise<CreateResult> {
    assertWritable(caller, space)
    const fields = this.cleanCreate(space, input)
    const view = viewOf(caller.project)
    const explicitSlug = input.slug !== undefined
    const slugValue = explicitSlug ? validSlug(input.slug as string) : deriveSlug(fields.title)

    // supersedes target: same project, same space; decisions and memories only
    let old: LoadedItem | null = null
    if (input.supersedes) {
      if (space === 'docs' || space === 'library') {
        throw new ApiError('wrong_space', {
          message:
            space === 'docs'
              ? 'Docs are edited, not superseded.'
              : 'Library pages are edited, not superseded.',
        })
      }
      old = await this.load(caller, input.supersedes, 'write')
      if (old.space !== space) {
        throw new ApiError('wrong_space', { message: `${handleOf(old, view)} is not in the ${space} space.` })
      }
    }
    // typed relations: targets in this project or `_shared`
    const relTargets = await this.relationTargets(caller, input.relations ?? [])

    const prepared = await this.prepare({ projectId: caller.project.id, space, ...fields })
    const warnings: Warning[] = []
    const notes: string[] = []
    const mode = input.allow_duplicate ? 'off' : (opts.dedupe ?? (caller.via === 'mcp' ? 'block' : 'warn'))
    let similar: NearDuplicate | null = null
    if (mode !== 'off' && space !== 'decisions') {
      const found = await this.dedupe(caller, space, fields.type, old?.id ?? null, prepared)
      if (found.skipped) notes.push('duplicate check skipped')
      const same = found.same
      if (same && mode === 'block') {
        const dup = this.dupJson(caller, same)
        await withTx(this.db, async (tx) => {
          await touchUsed(tx, [same.id])
          const existing = (await loadItem(tx, same.id)) as LoadedItem
          await this.audit(tx, caller, 'item.dedupe_hit', existing, `duplicate of ${dup.handle} refused`, {
            cos: Number(same.cos.toFixed(4)),
          })
        })
        return { item: null, row: null, warnings, duplicate: dup, similar: null, notes }
      }
      if (found.similar) {
        similar = { ...this.dupJson(caller, found.similar), values: found.similar.values }
        if (similar.values === null) {
          warnings.push({
            code: 'near_duplicate',
            handle: similar.handle,
            cos: Number(similar.cos.toFixed(4)),
            title: similar.title,
          })
        }
      }
    }

    const oldPrepared = old && old.status !== 'superseded' ? await this.prepare(old) : null
    let pending = false
    const row = await this.createTx(explicitSlug, async (tx) => {
      const actor = actorOf(caller)
      const { row: created, obsDays } = await this.insertNew(tx, caller, {
        space,
        fields,
        pinned: input.pinned ?? false,
        slug: { value: slugValue, explicit: explicitSlug },
        adr: { number: input.adr_number ?? null, onTaken: 'error' },
        decidedToday: space === 'decisions' && !input.decided_on,
      })
      for (const r of relTargets) await addEdge(tx, created, r.kind, r.to, actor)
      if (old) await this.applySupersede(tx, caller, created, old, { obsDays, prepared: oldPrepared })
      pending = (await this.index(tx, created, prepared)) || pending
      await this.audit(
        tx,
        caller,
        'item.create',
        created,
        `created ${handleOf(created, view)} "${created.title}"`,
        {
          revision: 1,
        },
      )
      return created
    }).catch(async (err) => {
      if (explicitSlug && isUniqueViolation(err, ITEM_SLUG_CONSTRAINT)) {
        const [h] = await this.db
          .select({ id: items.id })
          .from(items)
          .where(
            and(eq(items.projectId, caller.project.id), eq(items.space, space), eq(items.slug, slugValue)),
          )
        if (h) throw await slugTaken(this.db, h.id, view)
      }
      throw err
    })
    this.pendingWarning(caller.project.id, pending, warnings)
    const fresh = (await loadItem(this.db, row.id)) as LoadedItem
    return { item: await this.json(caller, fresh), row: fresh, warnings, duplicate: null, similar, notes }
  }

  /**
   * new → old `supersedes` edge, and the old item's status becomes `superseded` (a `change='supersede'`
   * revision; checked against `expected` when given). Inside the caller's transaction.
   */
  async applySupersede(
    tx: Tx,
    caller: Caller,
    newer: LoadedItem,
    old: LoadedItem,
    opts: { expected?: number; obsDays: number; prepared: PreparedChunks | null },
  ): Promise<LoadedItem> {
    const actor = actorOf(caller)
    await addEdge(tx, newer, 'supersedes', old, actor)
    const current = (await loadItem(tx, old.id, true)) as LoadedItem
    if (opts.expected !== undefined && opts.expected !== current.revision) {
      throw new ApiError('revision_conflict', {
        message: `Item is at revision ${current.revision}, the request was based on ${opts.expected}.`,
        hint: 'Re-read the item and re-apply your change.',
        details: { current_revision: current.revision },
      })
    }
    if (current.status === 'superseded') return current
    const updated = await writeContent(tx, {
      item: current,
      expected: current.revision,
      fields: { ...contentOf(current), status: 'superseded' },
      change: 'supersede',
      actor,
      provenance: provenanceOf(caller.via),
      observationDays: opts.obsDays,
    })
    const prepared = opts.prepared ?? (await this.prepare(updated))
    if (await this.index(tx, updated, prepared))
      this.deps.ports.jobs.enqueue('embed-pending', { projectId: updated.projectId })
    const view = viewOf(caller.project)
    await this.audit(
      tx,
      caller,
      'item.supersede',
      updated,
      `${handleOf(newer, view)} supersedes ${handleOf(updated, view)}`,
      {
        by: handleOf(newer, view),
        revision: [current.revision, updated.revision],
      },
    )
    return updated
  }

  // ---- read -------------------------------------------------------------------------------------------

  /** `GET …/items/:ref`. Does not bump `last_used_at` (MCP `spoor_get` calls `touchUsed` itself). */
  async get(caller: Caller, ref: string): Promise<ItemJson> {
    return this.json(caller, await this.load(caller, ref, 'read'))
  }

  /** `spoor_get`'s use signal (cleanup-and-jobs.md section 3). */
  touchUsed(ids: string[]) {
    return touchUsed(this.db, ids)
  }

  /** `GET …/spaces/:space/items` with filters and cursor pagination (api.md section 5.1). */
  async list(caller: Caller, space: Space, q: ListQuery) {
    const view = viewOf(caller.project)
    const conds: (SQL | undefined)[] = [eq(items.projectId, caller.project.id), eq(items.space, space)]
    const lifecycles = q.lifecycle ?? ['active', 'stale']
    if (!lifecycles.includes('all'))
      conds.push(inArray(items.lifecycle, lifecycles as ('active' | 'stale' | 'archived')[]))
    if (q.type) conds.push(inArray(items.type, q.type))
    if (q.status) conds.push(inArray(items.status, q.status))
    const tagList = q.tag === undefined ? [] : Array.isArray(q.tag) ? q.tag : [q.tag]
    if (tagList.length) conds.push(sql`${items.tags} @> ${sqlTextArray(tagList)}`)
    if (q.pinned) conds.push(eq(items.pinned, q.pinned === 'true'))
    if (q.q_title) conds.push(sql`${items.title} ILIKE ${`%${escapeLike(q.q_title)}%`}`)
    let file: string | null = null
    if (q.anchor) {
      file = normalizeFilePath(q.anchor)
      if (file === null) throw invalid('anchor', 'must be a repo-relative path without ".." segments or NUL')
      conds.push(sql`cardinality(${items.anchors}) > 0`)
    }

    const col =
      q.sort === 'created'
        ? items.createdAt
        : q.sort === 'verified'
          ? items.lastVerifiedAt
          : q.sort === 'number'
            ? items.number
            : items.updatedAt
    const isTs = q.sort !== 'number'
    const keyExpr = isTs ? cursorTimestamp(col) : sql<number>`${col}`
    const cmp = q.dir === 'desc' ? sql`<` : sql`>`
    const order = q.dir === 'desc' ? [desc(col), desc(items.id)] : [asc(col), asc(items.id)]

    let cursor: Cursor | null = q.cursor
      ? decodeTypedCursor(q.cursor, [isTs ? 'timestamp' : 'int', 'uuid'] as const)
      : null
    const out: { row: LoadedItem; key: Cursor }[] = []
    const batch = file ? 200 : q.limit + 1
    for (let guard = 0; guard < 50 && out.length <= q.limit; guard++) {
      const page = [...conds]
      if (cursor) {
        const [v, id] = cursor
        page.push(
          isTs
            ? sql`(${col}, ${items.id}) ${cmp} (${v}::timestamptz, ${id}::uuid)`
            : sql`(${col}, ${items.id}) ${cmp} (${Number(v)}::int, ${id}::uuid)`,
        )
      }
      const rows = await this.db
        .select({ item: items, projectSlug: projects.slug, projectKind: projects.kind, key: keyExpr })
        .from(items)
        .innerJoin(projects, eq(projects.id, items.projectId))
        .where(and(...page))
        .orderBy(...order)
        .limit(batch)
      for (const r of rows) {
        const row: LoadedItem = { ...r.item, projectSlug: r.projectSlug, projectKind: r.projectKind }
        const key: Cursor = [r.key as string | number, r.item.id]
        cursor = key
        if (file && bestStrength(row.anchors, file) === 0) continue
        out.push({ row, key })
        if (out.length > q.limit) break
      }
      if (rows.length < batch) break
    }
    const more = out.length > q.limit
    const kept = more ? out.slice(0, q.limit) : out
    const last = kept[kept.length - 1]
    return {
      items: kept.map((o) => summaryJson(o.row, view)),
      next_cursor: more && last ? encodeCursor(last.key) : null,
    }
  }

  // ---- update -----------------------------------------------------------------------------------------

  /**
   * `PATCH …/items/:ref` and the MCP update paths. Patch semantics; `revision` required. A web edit of a
   * mirrored item is saved with the warning `mirrored_item`; an MCP edit is refused (409 `mirrored_item`).
   */
  async update(
    caller: Caller,
    ref: string,
    patch: ItemPatchRequest,
    opts: {
      expectSpace?: Space
      /**
       * Typed edges from this item, added in the same transaction as the content write (mcp.md section 8:
       * one transaction per tool call; `spoor_remember` with `id` and `relations`). Targets are resolved
       * before anything is written; a missing one is `not_found` naming `relations.<i>.to`.
       */
      relations?: { kind: TypedKind; to: string }[]
    } = {},
  ): Promise<{ item: ItemJson; warnings: Warning[]; changed: boolean; relations: AddedRelation[] }> {
    assertWritable(caller)
    if (patch.revision === undefined) {
      throw new ApiError('revision_required', {
        message: 'An update must carry the revision it is based on.',
        hint: 'Read the item first and send its revision.',
      })
    }
    const item = await this.load(caller, ref, 'write')
    const view = viewOf(caller.project)
    if (opts.expectSpace && item.space !== opts.expectSpace) {
      throw new ApiError('wrong_space', { message: `${handleOf(item, view)} is in the ${item.space} space.` })
    }
    const warnings: Warning[] = []
    if (item.sourcePath) {
      if (caller.via === 'mcp') throw mirroredItem(handleOf(item, view), item.sourcePath)
      if (caller.via === 'web') warnings.push({ code: 'mirrored_item', source_path: item.sourcePath })
    }
    const space = item.space
    if (space !== 'memories' && (patch.type !== undefined || patch.confidence !== undefined)) {
      throw invalid(patch.type !== undefined ? 'type' : 'confidence', 'only memories have this field')
    }
    if (space !== 'decisions' && patch.decided_on !== undefined) throw invalid('decided_on', 'decisions only')
    if (patch.status !== undefined) this.checkStatus(space, patch.status)
    const relTargets = await this.relationTargets(caller, opts.relations ?? [])
    for (const [i, r] of relTargets.entries()) {
      if (r.to.id === item.id) throw invalid(`relations.${i}.to`, 'an item cannot link to itself')
    }

    const base = contentOf(item)
    const fields: ContentFields = {
      title: patch.title !== undefined ? cleanTitle(patch.title) : base.title,
      body: patch.body !== undefined ? cleanBody(patch.body) : base.body,
      status: patch.status ?? base.status,
      type: patch.type ?? base.type,
      confidence: patch.confidence ?? base.confidence,
      tags: patch.tags !== undefined ? cleanTags(patch.tags) : base.tags,
      anchors: patch.anchors !== undefined ? cleanAnchors(patch.anchors) : base.anchors,
      extras: patch.extra !== undefined ? cleanExtras(patch.extra, knownKeys(space)) : base.extras,
      decidedOn: patch.decided_on !== undefined ? patch.decided_on : base.decidedOn,
    }
    const sticky = await stickyStatus(this.db, item, fields.status)
    if (sticky.kept) {
      fields.status = sticky.status
      warnings.push({ code: 'status_kept_superseded' })
    }
    if (patch.revision !== item.revision) {
      throw new ApiError('revision_conflict', {
        message: `Item ${handleOf(item, view)} is at revision ${item.revision}, the request was based on ${patch.revision}.`,
        hint: 'Re-read the item and re-apply your change.',
        details: { current_revision: item.revision, current: await this.json(caller, item) },
      })
    }
    const changed = !sameContent(base, fields)
    if (!changed && relTargets.length === 0)
      return { item: await this.json(caller, item), warnings, changed: false, relations: [] }
    if (!changed) {
      // relations only: no revision, the edges in one transaction
      const added = await withTx(this.db, async (tx) => {
        const out: AddedRelation[] = []
        for (const r of relTargets) out.push(await this.addRelation(tx, caller, item, r.kind, r.to))
        return out
      })
      return { item: await this.json(caller, item), warnings, changed: false, relations: added }
    }

    const prepared = await this.prepare({ projectId: item.projectId, space, ...fields })
    let pending = false
    const added: AddedRelation[] = []
    const updated = await this.withConflictDetails(caller, item.id, () =>
      withTx(this.db, async (tx) => {
        added.length = 0
        await lockProjectForWrite(tx, item.projectId)
        const settings = await this.projectSettings(item.projectId)
        const row = await writeContent(tx, {
          item,
          expected: patch.revision as number,
          fields,
          change: 'update',
          actor: actorOf(caller),
          provenance: provenanceOf(caller.via),
          observationDays: settings.cleanup.observation_days,
        })
        await rewriteWikilinks(tx, row, await sharedProjectId(tx), actorOf(caller))
        pending = await this.index(tx, row, prepared)
        await this.audit(
          tx,
          caller,
          'item.update',
          row,
          `updated ${handleOf(row, view)} to r${row.revision}`,
          {
            revision: [item.revision, row.revision],
          },
        )
        for (const r of relTargets) added.push(await this.addRelation(tx, caller, row, r.kind, r.to))
        return row
      }),
    )
    this.pendingWarning(item.projectId, pending, warnings)
    return { item: await this.json(caller, updated), warnings, changed: true, relations: added }
  }

  /** Resolve typed-relation targets (own project or `_shared`); `not_found` names `relations.<i>.to`. */
  async relationTargets(
    caller: Caller,
    relations: { kind: TypedKind; to: string }[],
  ): Promise<{ kind: TypedKind; to: LoadedItem }[]> {
    const out: { kind: TypedKind; to: LoadedItem }[] = []
    for (const [i, r] of relations.entries()) {
      try {
        out.push({ kind: r.kind, to: await this.load(caller, r.to, 'read') })
      } catch (err) {
        if (err instanceof ApiError && err.code === 'not_found')
          throw new ApiError('not_found', { message: `relations.${i}.to: no item ${JSON.stringify(r.to)}.` })
        throw err
      }
    }
    return out
  }

  /** One typed edge inside the caller's transaction: insert (idempotent), bump the target's use, audit. */
  private async addRelation(
    tx: Tx,
    caller: Caller,
    from: LoadedItem,
    kind: TypedKind,
    to: LoadedItem,
  ): Promise<AddedRelation> {
    const view = viewOf(caller.project)
    const r = await addEdge(tx, from, kind, to, actorOf(caller))
    await touchUsed(tx, [to.id])
    if (r.created) {
      await this.audit(
        tx,
        caller,
        'edge.add',
        from,
        `${handleOf(from, view)} ${kind} ${handleOf(to, view)}`,
        {
          kind,
          to: handleOf(to, view),
        },
      )
    }
    return { kind, to, edgeId: r.id, changed: r.created }
  }

  // ---- operational actions (no revision) --------------------------------------------------------------

  private async operational(
    caller: Caller,
    ref: string,
    fn: (
      tx: Tx,
      item: LoadedItem,
    ) => Promise<{ action: string; summary: string; data?: Record<string, unknown> } | null>,
  ): Promise<ItemJson> {
    assertWritable(caller)
    const r = await this.resolve(caller, ref, 'write')
    const row = await withTx(this.db, async (tx) => {
      const item = await loadItem(tx, r.id, true)
      if (!item) throw new ApiError('not_found')
      const audit = await fn(tx, item)
      const after = (await loadItem(tx, item.id)) as LoadedItem
      if (audit) await this.audit(tx, caller, audit.action, after, audit.summary, audit.data)
      return after
    })
    return this.json(caller, row)
  }

  /**
   * Pin / unpin (every space). A human pin counts as verification: stale → active, `last_verified_at`,
   * provenance `human`; an archived item stays archived.
   */
  pin(caller: Caller, ref: string, pinned: boolean, note?: string) {
    return this.operational(caller, ref, async (tx, item) => {
      if (item.space === 'library') throw libraryNotPinned()
      const view = viewOf(caller.project)
      if (!pinned) {
        if (!item.pinned) return null
        await tx.update(items).set({ pinned: false }).where(eq(items.id, item.id))
        return {
          action: 'item.pin',
          summary: `unpinned ${handleOf(item, view)}`,
          data: { pinned: false, note },
        }
      }
      await tx
        .update(items)
        .set({
          pinned: true,
          lifecycle: sql`CASE WHEN ${items.lifecycle} = 'stale' THEN 'active' ELSE ${items.lifecycle} END`,
          staleSince: sql`CASE WHEN ${items.lifecycle} = 'stale' THEN NULL ELSE ${items.staleSince} END`,
          lastVerifiedAt: sql`now()`,
          ...(caller.via === 'mcp' ? {} : { provenance: 'human' as const }),
        })
        .where(eq(items.id, item.id))
      return {
        action: 'item.pin',
        summary: `pinned ${handleOf(item, view)}`,
        data: { pinned: true, restored: item.lifecycle === 'stale', note },
      }
    })
  }

  /**
   * Verify: `last_verified_at = now()`, stale → active. Web: provenance `human`. MCP (`spoor_verify`): also
   * `last_used_at`, provenance unchanged. Archived items: 400 `invalid_input` (restore first).
   */
  verify(caller: Caller, ref: string, note?: string) {
    return this.operational(caller, ref, async (tx, item) => {
      if (item.space === 'library') throw libraryNotPinned()
      if (item.lifecycle === 'archived') {
        throw new ApiError('invalid_input', {
          message: 'Archived items cannot be verified.',
          hint: 'restore first',
        })
      }
      await this.verifyRow(tx, caller, item)
      return {
        action: 'item.verify',
        summary: `verified ${handleOf(item, viewOf(caller.project))}`,
        data: { restored: item.lifecycle === 'stale', ...(note ? { note } : {}) },
      }
    })
  }

  private async verifyRow(tx: Tx, caller: Caller, item: LoadedItem) {
    await tx
      .update(items)
      .set({
        lastVerifiedAt: sql`now()`,
        lifecycle: sql`CASE WHEN ${items.lifecycle} = 'stale' THEN 'active' ELSE ${items.lifecycle} END`,
        staleSince: sql`CASE WHEN ${items.lifecycle} = 'stale' THEN NULL ELSE ${items.staleSince} END`,
        ...(caller.via === 'mcp' ? { lastUsedAt: sql`now()` } : { provenance: 'human' as const }),
      })
      .where(eq(items.id, item.id))
  }

  /**
   * Verify several (MCP `spoor_verify`, review bulk): archived and shared items are skipped, one audit row
   * per verified item.
   */
  async verifyMany(caller: Caller, refs: string[], note?: string) {
    assertWritable(caller)
    const view = viewOf(caller.project)
    const verified: string[] = []
    const restored: string[] = []
    const skipped: { ref: string; handle?: string; reason: string }[] = []
    for (const ref of refs) {
      let id: string
      try {
        const r = await this.resolve(caller, ref, 'write')
        // library pages are never verified (they are always in the digest)
        if (r.space === 'library') {
          skipped.push({ ref, handle: r.handle, reason: 'wrong_space' })
          continue
        }
        id = r.id
      } catch (err) {
        if (err instanceof ApiError && BULK_SKIPPED.includes(err.code)) {
          skipped.push({ ref, reason: err.code })
          continue
        }
        throw err
      }
      await withTx(this.db, async (tx) => {
        const item = (await loadItem(tx, id, true)) as LoadedItem
        const handle = handleOf(item, view)
        if (item.lifecycle === 'archived') {
          skipped.push({ ref, handle, reason: 'archived' })
          return
        }
        await this.verifyRow(tx, caller, item)
        await this.audit(tx, caller, 'item.verify', item, `verified ${handle}`, {
          restored: item.lifecycle === 'stale',
          ...(note ? { note } : {}),
        })
        verified.push(handle)
        if (item.lifecycle === 'stale') restored.push(handle)
      })
    }
    return { verified, restored, skipped }
  }

  /** Archive by hand (`archive_reason='manual'`); idempotent. */
  archive(caller: Caller, ref: string, note?: string) {
    return this.operational(caller, ref, async (tx, item) => {
      if (item.lifecycle === 'archived') return null
      await this.archiveRow(tx, item)
      return {
        action: 'item.archive',
        summary: `archived ${handleOf(item, viewOf(caller.project))}`,
        data: { reason: 'manual', ...(note ? { note } : {}) },
      }
    })
  }

  private async archiveRow(tx: Tx, item: LoadedItem) {
    await tx
      .update(items)
      .set({ lifecycle: 'archived', archivedAt: sql`now()`, archiveReason: 'manual', staleSince: null })
      .where(eq(items.id, item.id))
  }

  /**
   * `POST …/review/bulk` (api.md section 8): verify or archive up to 100 refs of the caller's project, one
   * transaction and one audit row per item. Refs that do not resolve in a write position (`not_found`,
   * `ambiguous_id`, a shared ref from a project: `read_only_space`), archived items on verify (`archived`)
   * and already archived items on archive (`already_archived`) are skipped, never an error.
   */
  async reviewBulk(
    caller: Caller,
    action: 'verify' | 'archive',
    refs: string[],
  ): Promise<{ done: string[]; skipped: { handle: string; reason: string }[] }> {
    if (action === 'verify') {
      const r = await this.verifyMany(caller, refs)
      return {
        done: r.verified,
        skipped: r.skipped.map((x) => ({ handle: x.handle ?? x.ref, reason: x.reason })),
      }
    }
    assertWritable(caller)
    const view = viewOf(caller.project)
    const done: string[] = []
    const skipped: { handle: string; reason: string }[] = []
    for (const ref of refs) {
      let id: string
      try {
        id = (await this.resolve(caller, ref, 'write')).id
      } catch (err) {
        if (err instanceof ApiError && BULK_SKIPPED.includes(err.code)) {
          skipped.push({ handle: ref, reason: err.code })
          continue
        }
        throw err
      }
      await withTx(this.db, async (tx) => {
        const item = (await loadItem(tx, id, true)) as LoadedItem
        const handle = handleOf(item, view)
        if (item.lifecycle === 'archived') {
          skipped.push({ handle, reason: 'already_archived' })
          return
        }
        await this.archiveRow(tx, item)
        await this.audit(tx, caller, 'item.archive', item, `archived ${handle}`, {
          reason: 'manual',
          bulk: true,
        })
        done.push(handle)
      })
    }
    return { done, skipped }
  }

  /**
   * Restore an archived item: active, `archived_*` cleared, `last_verified_at = now()`. An observation whose
   * expiry has passed must be promoted to a fact in the same action (409 `promote_required`), which is a
   * content revision checked against `revision`.
   */
  async restore(
    caller: Caller,
    ref: string,
    body: { note?: string; promote_to_fact?: boolean; revision?: number },
  ) {
    assertWritable(caller)
    const item = await this.load(caller, ref, 'write')
    if (item.space === 'library' && body.promote_to_fact) {
      throw new ApiError('wrong_space', {
        message: 'Library pages are not memories; there is nothing to promote.',
        hint: 'Restore without promote_to_fact.',
      })
    }
    if (item.lifecycle !== 'archived') return this.json(caller, item)
    const expiredIn = async (db: DbOrTx) => {
      const [{ expired } = { expired: false }] = await db
        .select({ expired: sql<boolean>`${items.expiresAt} IS NOT NULL AND ${items.expiresAt} <= now()` })
        .from(items)
        .where(eq(items.id, item.id))
      return expired
    }
    const mustPromote = (row: LoadedItem, expired: boolean) => {
      if (row.type !== 'observation' || !expired) return false
      if (!body.promote_to_fact) {
        throw new ApiError('promote_required', {
          message: 'This observation has expired; restoring it needs a promotion to a fact.',
          hint: 'Send {"promote_to_fact": true, "revision": n}.',
        })
      }
      if (body.revision === undefined) {
        throw new ApiError('revision_required', {
          message: 'Promotion is a content change and needs the revision.',
        })
      }
      return true
    }
    // a cheap early answer; the decision that counts is re-made on the locked row below
    const promoteBefore = mustPromote(item, await expiredIn(this.db))
    const view = viewOf(caller.project)
    const prepared = promoteBefore ? await this.prepare(item) : null
    let promote = false
    const row = await this.withConflictDetails(caller, item.id, () =>
      withTx(this.db, async (tx) => {
        await lockProjectForWrite(tx, item.projectId)
        let current = (await loadItem(tx, item.id, true)) as LoadedItem
        if (current.lifecycle !== 'archived') return current
        // the expiry may have passed since the check above (phase-2 review D-restore)
        promote = mustPromote(current, await expiredIn(tx))
        if (promote) {
          const settings = await this.projectSettings(item.projectId)
          current = await writeContent(tx, {
            item: current,
            expected: body.revision as number,
            fields: { ...contentOf(current), type: 'fact' },
            change: 'update',
            actor: actorOf(caller),
            provenance: provenanceOf(caller.via),
            observationDays: settings.cleanup.observation_days,
          })
          // no prepared set (the expiry passed meanwhile): pending chunks, embed-pending fills them
          const ready: PreparedChunks = prepared ?? {
            source: {
              projectId: current.projectId,
              space: current.space,
              title: current.title,
              tags: current.tags,
              body: current.body,
            },
            models: [],
            chunks: [],
            pending: true,
          }
          if (await this.index(tx, current, ready))
            this.deps.ports.jobs.enqueue('embed-pending', { projectId: current.projectId })
        }
        await tx
          .update(items)
          .set({
            lifecycle: 'active',
            archivedAt: null,
            archiveReason: null,
            staleSince: null,
            lastVerifiedAt: sql`now()`,
          })
          .where(eq(items.id, item.id))
        const after = (await loadItem(tx, item.id)) as LoadedItem
        await this.audit(tx, caller, 'item.restore', after, `restored ${handleOf(after, view)}`, {
          ...(promote ? { promoted_to_fact: true, revision: [item.revision, after.revision] } : {}),
          ...(body.note ? { note: body.note } : {}),
        })
        return after
      }),
    )
    return this.json(caller, row)
  }

  // ---- hard delete ------------------------------------------------------------------------------------

  /**
   * Human hard delete (web only; the route checks PA/IA, shared IA/SE). The one purge transaction:
   * incoming typed / `supersedes` / `drafted_from` edges go, incoming wikilinks dangle (FK), an item whose
   * only superseder was this one returns to `active` / `accepted` (`change='status'`), revisions and
   * chunks cascade, the audit row stays.
   */
  async delete(caller: Caller, ref: string, confirm: string | undefined): Promise<void> {
    assertWritable(caller)
    if (caller.via !== 'web')
      throw new ApiError('forbidden', { message: 'Only humans delete, in the web UI.' })
    const item = await this.load(caller, ref, 'write')
    const view = viewOf(caller.project)
    const handle = handleOf(item, view)
    if (confirm !== handle) {
      throw invalid('confirm', `must equal the handle ${handle}`, {
        message: `Confirm with ?confirm=${handle}.`,
      })
    }
    const orphans = async (db: DbOrTx) => {
      const rows = await db
        .select({ id: edges.dstId })
        .from(edges)
        .where(
          and(
            eq(edges.srcId, item.id),
            eq(edges.kind, 'supersedes'),
            sql`NOT EXISTS (SELECT 1 FROM ${edges} o WHERE o.dst_id = ${edges.dstId}
                  AND o.kind = 'supersedes' AND o.src_id <> ${item.id})`,
          ),
        )
      return rows.map((r) => r.id).filter((x): x is string => x !== null)
    }
    const orphanIds = await orphans(this.db)
    const before = orphanIds.length ? await loadItems(this.db, inArray(items.id, orphanIds)) : []
    const preparedFor = new Map<string, PreparedChunks>()
    for (const o of before) if (o.status === 'superseded') preparedFor.set(o.id, await this.prepare(o))

    await withTx(this.db, async (tx) => {
      await allowPurge(tx)
      await lockProjectForWrite(tx, item.projectId)
      const locked = await loadItem(tx, item.id, true)
      if (!locked) throw new ApiError('not_found')
      const revert = await orphans(tx)
      await tx.delete(edges).where(and(eq(edges.dstId, item.id), ne(edges.kind, 'wikilink')))
      await tx.delete(items).where(eq(items.id, item.id))
      const settings = await this.projectSettings(item.projectId)
      for (const id of revert) {
        const o = await loadItem(tx, id, true)
        if (o?.status !== 'superseded') continue
        const row = await writeContent(tx, {
          item: o,
          expected: o.revision,
          fields: { ...contentOf(o), status: o.space === 'decisions' ? 'accepted' : 'active' },
          change: 'status',
          actor: actorOf(caller),
          provenance: o.provenance,
          observationDays: settings.cleanup.observation_days,
        })
        if (await this.index(tx, row, preparedFor.get(id) ?? (await this.prepare(row))))
          this.deps.ports.jobs.enqueue('embed-pending', { projectId: row.projectId })
      }
      await this.audit(tx, caller, 'item.delete', locked, `deleted ${handle} "${locked.title}"`, {
        revision: locked.revision,
        ...(revert.length ? { reverted_status: revert.length } : {}),
      })
    })
  }

  // ---- supersede (memories) ---------------------------------------------------------------------------

  /**
   * `POST …/items/:ref/supersede` and `spoor_supersede`: memories only, exactly one of `new` / `new_id`,
   * both ends inside the caller's project. One transaction: create or resolve the new item, add the edge,
   * mark the old one superseded (revision checked when given).
   */
  async supersede(caller: Caller, oldRef: string, req: SupersedeRequest) {
    assertWritable(caller)
    if ((req.new === undefined) === (req.new_id === undefined)) {
      throw invalid(req.new ? 'new_id' : 'new', 'give exactly one of new or new_id')
    }
    const old = await this.load(caller, oldRef, 'write')
    const view = viewOf(caller.project)
    if (old.space !== 'memories') {
      throw new ApiError('wrong_space', {
        message: `${handleOf(old, view)} is not a memory.`,
        hint:
          old.space === 'decisions'
            ? 'Put supersedes: ADR-NNNN in the new ADR file.'
            : old.space === 'library'
              ? 'Library pages are edited, not superseded.'
              : 'Docs are edited, not superseded.',
      })
    }
    let target: LoadedItem | null = null
    if (req.new_id !== undefined) {
      target = await this.load(caller, req.new_id, 'write')
      if (target.space !== 'memories')
        throw new ApiError('wrong_space', { message: `${handleOf(target, view)} is not a memory.` })
      if (target.id === old.id) throw invalid('new_id', 'an item cannot supersede itself')
    }
    const fields: ContentFields | null = req.new
      ? {
          title: cleanTitle(req.new.title, 'new.title'),
          body: cleanBody(req.new.body ?? ''),
          status: 'active',
          type: req.new.type ?? old.type,
          confidence: req.new.confidence ?? 'medium',
          tags: req.new.tags ? cleanTags(req.new.tags, 'new.tags') : old.tags,
          anchors: req.new.anchors ? cleanAnchors(req.new.anchors, 'new.anchors') : old.anchors,
          extras: {},
          decidedOn: null,
        }
      : null
    const newPrepared = fields
      ? await this.prepare({ projectId: caller.project.id, space: 'memories', ...fields })
      : null
    const oldPrepared = await this.prepare(old)
    const warnings: Warning[] = []
    let pending = false
    const result = await this.withConflictDetails(caller, old.id, () =>
      this.createTx(false, async (tx) => {
        let newer = target
        let obsDays: number
        if (fields) {
          const ins = await this.insertNew(tx, caller, {
            space: 'memories',
            fields,
            pinned: false,
            slug: { value: deriveSlug(fields.title), explicit: false },
          })
          newer = ins.row
          obsDays = ins.obsDays
          pending = await this.index(tx, newer, newPrepared as PreparedChunks)
          await this.audit(
            tx,
            caller,
            'item.create',
            newer,
            `created ${handleOf(newer, view)} "${newer.title}"`,
            {
              revision: 1,
            },
          )
        } else {
          // no number to allocate: take the project lock before the item locks of applySupersede
          await lockProjectForWrite(tx, caller.project.id)
          obsDays = (await this.projectSettings(caller.project.id)).cleanup.observation_days
        }
        const oldAfter = await this.applySupersede(tx, caller, newer as LoadedItem, old, {
          expected: req.revision,
          obsDays,
          prepared: oldPrepared,
        })
        return { newer: newer as LoadedItem, oldAfter }
      }),
    )
    this.pendingWarning(caller.project.id, pending, warnings)
    const newer = (await loadItem(this.db, result.newer.id)) as LoadedItem
    const oldNow = (await loadItem(this.db, old.id)) as LoadedItem
    return {
      new: await this.json(caller, newer),
      old: await this.json(caller, oldNow),
      warnings,
      created: fields !== null,
    }
  }

  // ---- edges ------------------------------------------------------------------------------------------

  /**
   * Add or remove a typed edge (`POST …/items/:ref/edges`, `spoor_relate`). `from` must be in the caller's
   * project; `to` may be shared (never the reverse, read_only_space). Adding bumps the target's
   * `last_used_at`. Idempotent: `changed=false` when nothing changed.
   */
  async relate(caller: Caller, fromRef: string, kind: TypedKind, toRef: string, remove = false) {
    assertWritable(caller)
    const from = await this.load(caller, fromRef, 'write')
    const to = await this.load(caller, toRef, 'read')
    if (from.id === to.id) throw invalid('to', 'an item cannot link to itself')
    const view = viewOf(caller.project)
    return withTx(this.db, async (tx) => {
      if (remove) {
        const deleted = await tx
          .delete(edges)
          .where(
            and(
              eq(edges.kind, kind),
              kind === 'conflicts_with'
                ? or(
                    and(eq(edges.srcId, from.id), eq(edges.dstId, to.id)),
                    and(eq(edges.srcId, to.id), eq(edges.dstId, from.id)),
                  )
                : and(eq(edges.srcId, from.id), eq(edges.dstId, to.id)),
            ),
          )
          .returning({ id: edges.id })
        if (deleted.length) {
          await this.audit(
            tx,
            caller,
            'edge.remove',
            from,
            `${handleOf(from, view)} ${kind} ${handleOf(to, view)} removed`,
            {
              kind,
              to: handleOf(to, view),
            },
          )
        }
        return { changed: deleted.length > 0, edge: null, from, to }
      }
      const r = await this.addRelation(tx, caller, from, kind, to)
      return { changed: r.changed, edge: await this.edgeJson(tx, caller, r.edgeId, from.id), from, to }
    })
  }

  /** `DELETE …/edges/:id`: typed kinds only (409 `edge_not_editable`); the edge must belong to the project. */
  async removeEdge(caller: Caller, edgeId: string): Promise<void> {
    assertWritable(caller)
    const [e] = await this.db
      .select()
      .from(edges)
      .where(and(eq(edges.id, edgeId), eq(edges.projectId, caller.project.id)))
      .limit(1)
    if (!e) throw new ApiError('not_found')
    // the edge belongs to its source: removing it is a write on the source (library right, item right)
    const source = await loadItem(this.db, e.srcId)
    if (!source) throw new ApiError('not_found')
    assertWritable(caller, source.space)
    if (!(TYPED_KINDS as readonly string[]).includes(e.kind)) {
      throw new ApiError('edge_not_editable', {
        message: `${e.kind} edges are maintained by the system.`,
        hint: e.kind === 'wikilink' ? 'Edit the body to remove the link.' : undefined,
      })
    }
    await withTx(this.db, async (tx) => {
      await tx.delete(edges).where(eq(edges.id, e.id))
      const src = (await loadItem(tx, e.srcId)) as LoadedItem
      await this.audit(
        tx,
        caller,
        'edge.remove',
        src,
        `${handleOf(src, viewOf(caller.project))} ${e.kind} removed`,
        {
          kind: e.kind,
          edge_id: e.id,
        },
      )
    })
  }

  private async edgeJson(db: DbOrTx, caller: Caller, edgeId: string, selfId: string) {
    const [e] = await db.select().from(edges).where(eq(edges.id, edgeId)).limit(1)
    if (!e) return null
    const otherId = e.srcId === selfId ? e.dstId : e.srcId
    const other = otherId ? await loadItem(db, otherId) : undefined
    return {
      id: e.id,
      kind: e.kind,
      editable: (TYPED_KINDS as readonly string[]).includes(e.kind),
      other: other ? summaryJson(other, viewOf(caller.project)) : null,
      ...(other ? {} : { dst_ref: e.dstRef }),
    }
  }

  /**
   * `GET …/items/:ref/edges`. On a shared item both directions are filtered to edges whose other end is in
   * `_shared` or in a project the caller belongs to (`memberProjects`; `null` = all, for IA).
   */
  async edges(caller: Caller, ref: string, memberProjects: string[] | null) {
    const item = await this.load(caller, ref, 'read')
    const view = viewOf(caller.project)
    const otherItems = alias(items, 'other_item')
    const otherProjects = alias(projects, 'other_project')
    const select = (otherCol: typeof edges.dstId | typeof edges.srcId) =>
      this.db
        .select({
          edge: edges,
          other: otherItems,
          otherSlug: otherProjects.slug,
          otherKind: otherProjects.kind,
        })
        .from(edges)
        .leftJoin(otherItems, eq(otherItems.id, otherCol))
        .leftJoin(otherProjects, eq(otherProjects.id, otherItems.projectId))
    const outRows = await select(edges.dstId)
      .where(eq(edges.srcId, item.id))
      .orderBy(asc(edges.createdAt), asc(edges.id))
    const inRows = await select(edges.srcId)
      .where(eq(edges.dstId, item.id))
      .orderBy(asc(edges.createdAt), asc(edges.id))
    const shared = item.projectKind === 'shared'
    const visible = (r: (typeof outRows)[number]) => {
      if (!shared || memberProjects === null) return true
      if (!r.other) return true // dangling wikilink of a shared item: its source is shared
      return r.otherKind === 'shared' || memberProjects.includes(r.other.projectId)
    }
    const toJson = (r: (typeof outRows)[number]) => ({
      id: r.edge.id,
      kind: r.edge.kind,
      editable: (TYPED_KINDS as readonly string[]).includes(r.edge.kind),
      other: r.other
        ? summaryJson(
            {
              ...r.other,
              projectSlug: r.otherSlug as string,
              projectKind: r.otherKind as 'project' | 'shared',
            },
            view,
          )
        : null,
      ...(r.other ? {} : { dst_ref: r.edge.dstRef }),
    })
    return { outgoing: outRows.filter(visible).map(toJson), incoming: inRows.filter(visible).map(toJson) }
  }

  /**
   * `GET …/graph` (ADR-0021): the whole project, or `focus`'s neighbourhood (resolved like `:ref`; 404 /
   * 409 `ambiguous_id`). `memberProjects` filters incoming edges into `_shared` as `edges` does.
   */
  async graph(caller: Caller, query: GraphQuery, memberProjects: string[] | null, cap?: number) {
    const focusId = query.focus ? (await this.load(caller, query.focus, 'read')).id : undefined
    return graph(this.db, { project: caller.project, query, memberProjects, focusId, cap })
  }

  /**
   * `GET …/items/:ref/related` (ADR-0022): unlinked items ranked by best-chunk cosine under the item's
   * project's active model, floor `relatedMinCos` of the item's project; `note` when no vector exists yet.
   */
  async related(caller: Caller, ref: string, limit: number): Promise<RelatedResponse> {
    const item = await this.load(caller, ref, 'read')
    return this.relatedByProbe(caller, { item }, limit)
  }

  /**
   * The same for an already loaded item, e.g. right after an MCP write: `chunks` (the write's prepared
   * chunks) replaces reading the stored ones; `excludeIds` are never suggested (linked in the same call).
   * Candidates: the item's project (+ `_shared` on the same model when the item is not shared itself).
   */
  async relatedByProbe(
    caller: Caller,
    probe: { item: LoadedItem; chunks?: PreparedChunk[]; excludeIds?: string[] },
    limit: number,
  ): Promise<RelatedResponse> {
    const { item } = probe
    const minCos = relatedMinCos(await this.projectSettings(item.projectId))
    const res = await this.deps.ports.search.relatedCandidates(this.db, {
      projectId: item.projectId,
      itemId: item.id,
      chunks: probe.chunks,
      includeShared: item.projectKind !== 'shared',
      excludeIds: probe.excludeIds,
      minCos,
      limit,
    })
    if (res.pending) return { items: [], note: RELATED_PENDING_NOTE }
    if (res.candidates.length === 0) return { items: [] }
    const rows = await loadItems(
      this.db,
      inArray(
        items.id,
        res.candidates.map((c) => c.id),
      ),
    )
    const byId = new Map(rows.map((r) => [r.id, r]))
    const view = viewOf(caller.project)
    return {
      items: res.candidates.flatMap((c) => {
        const row = byId.get(c.id)
        return row ? [{ item: summaryJson(row, view), cos: Math.round(c.cos * 1000) / 1000 }] : []
      }),
    }
  }

  /** Projects whose links a cookie user may see on a shared item (null = all, instance admin). */
  async memberProjectIds(userId: string, isAdmin: boolean): Promise<string[] | null> {
    if (isAdmin) return null
    const rows = await this.db
      .select({ id: memberships.projectId })
      .from(memberships)
      .where(eq(memberships.userId, userId))
    return rows.map((r) => r.id)
  }

  /**
   * `GET …/resolve?ref=&from=`: wikilink text resolved exactly like stored links (canonical ref, handle
   * forms, `shared:` prefix, slug precedence of `spaceRank` for a link written in a `from` item: library
   * first, then `from`'s own space, then docs → decisions → memories). `from` only sets the precedence.
   */
  async resolveText(caller: Caller, text: string, from: Space = 'docs') {
    const t = text.trim()
    const isShared = /^shared:/.test(t)
    const ref = canonicalRef(isShared ? t.slice('shared:'.length) : t)
    const link = { shared: isShared, ref, dstRef: isShared ? `shared:${ref}` : ref }
    const sharedId = await sharedProjectId(this.db)
    const map = await resolveWikilinks(
      this.db,
      { id: null, projectId: caller.project.id, space: from, shared: caller.project.kind === 'shared' },
      [link],
      sharedId,
    )
    const id = map.get(link.dstRef)
    const row = id ? await loadItem(this.db, id) : undefined
    if (!row)
      throw new ApiError('not_found', { message: `Nothing links as ${JSON.stringify(t.slice(0, 200))}.` })
    return { item: summaryJson(row, viewOf(caller.project)) }
  }

  // ---- revisions --------------------------------------------------------------------------------------

  async revisions(caller: Caller, ref: string, q: { limit: number; cursor?: string }) {
    const item = await this.load(caller, ref, 'read')
    const conds: (SQL | undefined)[] = [eq(itemRevisions.itemId, item.id)]
    if (q.cursor) {
      const [rev] = decodeTypedCursor(q.cursor, ['int'] as const)
      conds.push(sql`${itemRevisions.revision} < ${rev}`)
    }
    const rows = await this.db
      .select({
        revision: itemRevisions.revision,
        title: itemRevisions.title,
        status: itemRevisions.status,
        change: itemRevisions.change,
        actorUserId: itemRevisions.actorUserId,
        actorLabel: itemRevisions.actorLabel,
        via: itemRevisions.via,
        clientName: itemRevisions.clientName,
        createdAt: itemRevisions.createdAt,
      })
      .from(itemRevisions)
      .where(and(...conds))
      .orderBy(desc(itemRevisions.revision))
      .limit(q.limit + 1)
    const more = rows.length > q.limit
    const kept = more ? rows.slice(0, q.limit) : rows
    return {
      items: kept.map((r) => ({
        revision: r.revision,
        title: r.title,
        status: r.status,
        change: r.change,
        actor: { user_id: r.actorUserId, label: r.actorLabel, via: r.via, client_name: r.clientName },
        created_at: r.createdAt.toISOString(),
      })),
      next_cursor: more && kept.length ? encodeCursor([kept[kept.length - 1]?.revision ?? 0]) : null,
    }
  }

  async revision(caller: Caller, ref: string, n: number) {
    const item = await this.load(caller, ref, 'read')
    const [r] = await this.db
      .select()
      .from(itemRevisions)
      .where(and(eq(itemRevisions.itemId, item.id), eq(itemRevisions.revision, n)))
      .limit(1)
    if (!r) throw new ApiError('not_found', { message: `No revision ${n}.` })
    return {
      revision: r.revision,
      title: r.title,
      body: r.body,
      status: r.status,
      frontmatter: r.frontmatter,
      change: r.change,
      actor: { user_id: r.actorUserId, label: r.actorLabel, via: r.via, client_name: r.clientName },
      created_at: r.createdAt.toISOString(),
    }
  }
}
