/**
 * Edges (data-model.md section 3): wikilinks derived from the body on every content revision, dangling
 * links claimed by new items, typed edges, and the scope trigger's error mapped to an API error.
 *
 * Wikilink resolution inside the source's project: handle forms by number (`m42`, `d7`, `adr-7`), then the
 * slug with the precedence of `spaceRank` (a library page first, then the source's own space, then docs,
 * decisions, memories). `shared:` resolves in `_shared` only. A shared source resolves only inside `_shared`
 * (nothing points out of it). A link to the item itself is not stored.
 *
 * Library pages (ADR-0014): their outgoing links are a human choice at save time and may point anywhere,
 * but a later item never captures a library page's dangling link or takes over one it resolved (only a
 * new library page may claim a library page's dangling link). `conflicts_with` never joins a library page
 * and another item; `supersedes` and `drafted_from` never point at a library page.
 */
import {
  extractWikilinks,
  pickRefTarget,
  refHandle,
  refTarget,
  spaceRank,
  type Wikilink,
} from '@spoor/shared'
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { edges, items, projects } from '../../db/schema.js'
import type { DbOrTx, Tx } from '../../lib/db.js'
import { pgError } from '../../lib/db.js'
import { ApiError } from '../../lib/errors.js'
import type { Space } from '../../ports.js'
import type { LoadedItem } from './rows.js'
import { libraryGuardError } from './writes.js'

export const TYPED_KINDS = ['refines', 'supports', 'depends_on', 'conflicts_with'] as const
export type TypedKind = (typeof TYPED_KINDS)[number]

export interface EdgeActor {
  userId: string | null
  label: string
  clientName: string | null
}

export { spaceRank }

export async function sharedProjectId(db: DbOrTx): Promise<string | null> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.kind, 'shared'))
    .limit(1)
  return row?.id ?? null
}

interface Candidate {
  id: string
  projectId: string
  space: Space
  number: number
  adrNumber: number | null
  slug: string
}

/** The canonical refs a new item answers to: its slug and its handle form (`m42`, `d7`, `l3`, `adr-7`). */
export function refsOf(item: Pick<LoadedItem, 'space' | 'number' | 'adrNumber' | 'slug'>): string[] {
  return [item.slug, refHandle(item.space, item.number, item.adrNumber)]
}

function pick(cands: Candidate[], projectId: string, srcSpace: Space, ref: string): Candidate | null {
  return pickRefTarget(
    cands.filter((c) => c.projectId === projectId),
    srcSpace,
    ref,
  )
}

/** Resolve wikilinks of a source in one query. Returns dst_ref → target id (null = dangling). */
export async function resolveWikilinks(
  db: DbOrTx,
  src: { id: string | null; projectId: string; space: Space; shared: boolean },
  links: Wikilink[],
  sharedId: string | null,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  if (links.length === 0) return out
  const slugs = new Set<string>()
  const numbers = new Set<number>()
  const adrs = new Set<number>()
  for (const l of links) {
    const adr = /^adr-(\d+)$/.exec(l.ref)
    const md = /^[mdl](\d+)$/.exec(l.ref)
    if (adr) adrs.add(Number(adr[1]))
    else if (md) numbers.add(Number(md[1]))
    else slugs.add(l.ref)
  }
  const projectIds = [src.projectId, ...(sharedId && sharedId !== src.projectId ? [sharedId] : [])]
  const conds = []
  if (slugs.size) conds.push(inArray(items.slug, [...slugs]))
  if (numbers.size) conds.push(inArray(items.number, [...numbers]))
  if (adrs.size) conds.push(inArray(items.adrNumber, [...adrs]))
  const cands = (await db
    .select({
      id: items.id,
      projectId: items.projectId,
      space: items.space,
      number: items.number,
      adrNumber: items.adrNumber,
      slug: items.slug,
    })
    .from(items)
    .where(and(inArray(items.projectId, projectIds), or(...conds)))) as Candidate[]
  for (const l of links) {
    // a shared source never resolves outside `_shared`; `shared:` always means `_shared`
    const target = l.shared || src.shared ? sharedId : src.projectId
    const hit = target ? pick(cands, target, src.space, l.ref) : null
    out.set(l.dstRef, hit && hit.id !== src.id ? hit.id : null)
  }
  return out
}

/**
 * Map the edge scope trigger to an API error: P0002 (out of `_shared`, across projects) is
 * `read_only_space`, SPL01 (the library edge rule) is `wrong_space`; rethrow anything else.
 */
export function mapEdgeError(err: unknown): never {
  if (pgError(err)?.code === 'P0002') {
    throw new ApiError('read_only_space', {
      message: 'Links may point from a project into the shared space, never out of it.',
      hint: 'Shared items are edited by humans in the web UI.',
    })
  }
  throw libraryGuardError(err)
}

/**
 * The library edge rule (ADR-0014), checked before any typed or system edge is written: 400 `wrong_space`
 * for `conflicts_with` between a library page and any other item (it is stored once and read both ways,
 * so it would show on the library page as the page's own claim), and for `supersedes` or `drafted_from`
 * pointing at a library page. The DB backstop (SPL01) refuses the same.
 */
export function assertLibraryEdge(
  src: Pick<LoadedItem, 'space'>,
  kind: TypedKind | 'supersedes' | 'drafted_from',
  dst: Pick<LoadedItem, 'space'>,
): void {
  const srcLib = src.space === 'library'
  const dstLib = dst.space === 'library'
  if (srcLib === dstLib) return
  if (kind === 'conflicts_with') {
    throw new ApiError('wrong_space', {
      message: 'conflicts_with never joins a library page and another item.',
      hint: 'conflicts_with is symmetric; point at a library page with refines, supports or depends_on.',
    })
  }
  if (dstLib && (kind === 'supersedes' || kind === 'drafted_from')) {
    throw new ApiError('wrong_space', {
      message: `A library page cannot be the target of ${kind}.`,
      hint: 'Library pages are edited, not superseded; link to them with refines, supports or depends_on.',
    })
  }
}

/**
 * Rewrite the wikilink edges of `src` from its body (every content revision): links no longer in the
 * body are deleted, new ones inserted, existing ones re-resolved. Typed and system edges are untouched.
 *
 * A library page's re-save never re-resolves a slug link it already has (ADR-0014, "capture is blocked;
 * library links are never taken over"): a stored target is kept; a stored dangling link is filled only by
 * a library page (own project or `_shared`), otherwise it stays dangling. Refs new in this save and handle
 * forms (`d9`, `l3`, `adr-7`, which name one item for good) resolve normally. To repoint an existing link,
 * a human changes its ref text (for example to the target's handle).
 */
export async function rewriteWikilinks(
  tx: Tx,
  src: LoadedItem,
  sharedId: string | null,
  actor: EdgeActor,
): Promise<void> {
  const links = extractWikilinks(src.body)
  const shared = src.projectKind === 'shared'
  const resolved = await resolveWikilinks(
    tx,
    { id: src.id, projectId: src.projectId, space: src.space, shared },
    links,
    sharedId,
  )
  if (src.space === 'library') await keepLibraryTargets(tx, src.id, links, resolved)
  // a link to the item itself is not stored
  const wanted = [...resolved.entries()].filter(([ref]) => {
    const self = refsOf(src)
    return !(shared ? self.includes(ref.replace(/^shared:/, '')) : self.includes(ref))
  })
  const keep = wanted.map(([ref]) => ref)
  await tx
    .delete(edges)
    .where(
      and(
        eq(edges.srcId, src.id),
        eq(edges.kind, 'wikilink'),
        keep.length ? sql`${edges.dstRef} <> ALL(${sqlTextArray(keep)})` : undefined,
      ),
    )
  if (wanted.length === 0) return
  try {
    await tx
      .insert(edges)
      .values(
        wanted.map(([dstRef, dstId]) => ({
          projectId: src.projectId,
          srcId: src.id,
          kind: 'wikilink' as const,
          dstRef,
          dstId,
          createdBy: actor.userId,
          createdByLabel: actor.label,
          clientName: actor.clientName,
        })),
      )
      .onConflictDoUpdate({
        target: [edges.srcId, edges.kind, edges.dstRef],
        set: { dstId: sql`excluded.dst_id` },
      })
  } catch (err) {
    mapEdgeError(err)
  }
}

/** The library re-save rule of `rewriteWikilinks`: overwrite `resolved` for slug refs the page already links. */
async function keepLibraryTargets(
  tx: Tx,
  srcId: string,
  links: Wikilink[],
  resolved: Map<string, string | null>,
): Promise<void> {
  const slugRefs = links.filter((l) => refTarget(l.ref).kind === 'slug').map((l) => l.dstRef)
  if (slugRefs.length === 0) return
  const existing = await tx
    .select({ dstRef: edges.dstRef, dstId: edges.dstId })
    .from(edges)
    .where(and(eq(edges.srcId, srcId), eq(edges.kind, 'wikilink'), inArray(edges.dstRef, slugRefs)))
  if (existing.length === 0) return
  // candidates for a stored dangling link: only a library page may fill it
  const fill = existing
    .filter((e) => e.dstId === null)
    .map((e) => resolved.get(e.dstRef))
    .filter((id): id is string => typeof id === 'string')
  const libraryIds = new Set(
    fill.length
      ? (
          await tx
            .select({ id: items.id })
            .from(items)
            .where(and(inArray(items.id, fill), eq(items.space, 'library')))
        ).map((r) => r.id)
      : [],
  )
  for (const e of existing) {
    if (e.dstId !== null) resolved.set(e.dstRef, e.dstId)
    else {
      const id = resolved.get(e.dstRef) ?? null
      resolved.set(e.dstRef, id && libraryIds.has(id) ? id : null)
    }
  }
}

export function sqlTextArray(values: readonly string[]) {
  if (values.length === 0) return sql`'{}'::text[]`
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`
}

/**
 * A new item claims (data-model.md section 3): (1) dangling wikilinks naming its slug or handle, and (2)
 * wikilinks whose slug currently resolves to a lower-precedence item. Scope: its own project; for a shared
 * item every project (links written `shared:<ref>`) plus `_shared` itself. A library page's links are the
 * human's choice at save time (ADR-0014): only a new library page claims one of its dangling links, and none
 * of its resolved links is ever taken over.
 */
export async function claimWikilinks(tx: Tx, item: LoadedItem): Promise<void> {
  try {
    await claim(tx, item)
  } catch (err) {
    mapEdgeError(err)
  }
}

async function claim(tx: Tx, item: LoadedItem): Promise<void> {
  const refs = refsOf(item)
  const shared = item.projectKind === 'shared'
  const scope = shared
    ? or(
        and(
          eq(edges.projectId, item.projectId),
          sql`${edges.dstRef} = ANY(${sqlTextArray([...refs, ...refs.map((r) => `shared:${r}`)])})`,
        ),
        and(
          ne(edges.projectId, item.projectId),
          sql`${edges.dstRef} = ANY(${sqlTextArray(refs.map((r) => `shared:${r}`))})`,
        ),
      )
    : and(eq(edges.projectId, item.projectId), sql`${edges.dstRef} = ANY(${sqlTextArray(refs)})`)
  // 1. dangling links; a library page's only by a new library page
  const fromLibrary = sql`EXISTS (SELECT 1 FROM ${items} s WHERE s.id = ${edges.srcId} AND s.space = 'library')`
  await tx
    .update(edges)
    .set({ dstId: item.id })
    .where(
      and(
        isNull(edges.dstId),
        eq(edges.kind, 'wikilink'),
        ne(edges.srcId, item.id),
        scope,
        item.space === 'library' ? undefined : sql`NOT ${fromLibrary}`,
      ),
    )

  // 2. slug links resolved to a lower-precedence item of the same project (never a library page's)
  const slugRefs = shared ? [item.slug, `shared:${item.slug}`] : [item.slug]
  const rows = await tx.execute<{ id: string; src_space: Space; dst_space: string }>(sql`
    SELECT e.id, s.space AS src_space, d.space AS dst_space
    FROM ${edges} e
    JOIN ${items} s ON s.id = e.src_id
    JOIN ${items} d ON d.id = e.dst_id
    WHERE e.kind = 'wikilink' AND e.dst_id <> ${item.id} AND e.src_id <> ${item.id}
      AND e.dst_ref = ANY(${sqlTextArray(slugRefs)})
      AND s.space <> 'library'
      AND d.project_id = ${item.projectId}
      AND ${shared ? sql`TRUE` : sql`e.project_id = ${item.projectId}`}`)
  const takeOver = rows.rows
    .filter((r) => spaceRank(r.src_space, item.space) < spaceRank(r.src_space, r.dst_space as Space))
    .map((r) => r.id)
  if (takeOver.length) await tx.update(edges).set({ dstId: item.id }).where(inArray(edges.id, takeOver))
}

/** What `edges.dst_ref` of a typed / system edge stores: the target uuid, or `shared:<space>/<slug>`. */
export function typedDstRef(src: { projectKind: string }, dst: LoadedItem): string {
  return dst.projectKind === 'shared' && src.projectKind !== 'shared'
    ? `shared:${dst.space}/${dst.slug}`
    : dst.id
}

/**
 * Insert a typed or system edge; `false` when it already existed (`conflicts_with` counts in both
 * directions). The library edge rule is `wrong_space`; the scope trigger's refusal becomes
 * `read_only_space`.
 */
export async function addEdge(
  tx: Tx,
  src: LoadedItem,
  kind: TypedKind | 'supersedes' | 'drafted_from',
  dst: LoadedItem,
  actor: EdgeActor,
): Promise<{ created: boolean; id: string }> {
  if (src.id === dst.id) {
    throw new ApiError('invalid_input', {
      message: 'An item cannot link to itself.',
      details: { issues: [{ path: 'to', message: 'same item' }] },
    })
  }
  assertLibraryEdge(src, kind, dst)
  if (kind === 'conflicts_with') {
    // stored once for both directions: serialise the check-then-insert of this pair, so concurrent
    // relate(a, b) and relate(b, a) cannot both insert (review D-conflicts)
    const [lo, hi] = src.id < dst.id ? [src.id, dst.id] : [dst.id, src.id]
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`spoor.conflicts:${lo}:${hi}`}))`)
    const [rev] = await tx
      .select({ id: edges.id })
      .from(edges)
      .where(and(eq(edges.srcId, dst.id), eq(edges.dstId, src.id), eq(edges.kind, 'conflicts_with')))
      .limit(1)
    if (rev) return { created: false, id: rev.id }
  }
  const dstRef = typedDstRef(src, dst)
  try {
    const inserted = await tx
      .insert(edges)
      .values({
        projectId: src.projectId,
        srcId: src.id,
        kind,
        dstRef,
        dstId: dst.id,
        createdBy: actor.userId,
        createdByLabel: actor.label,
        clientName: actor.clientName,
      })
      .onConflictDoNothing()
      .returning({ id: edges.id })
    if (inserted[0]) return { created: true, id: inserted[0].id }
  } catch (err) {
    mapEdgeError(err)
  }
  const [existing] = await tx
    .select({ id: edges.id })
    .from(edges)
    .where(and(eq(edges.srcId, src.id), eq(edges.kind, kind), eq(edges.dstRef, dstRef)))
    .limit(1)
  return { created: false, id: existing?.id ?? '' }
}
