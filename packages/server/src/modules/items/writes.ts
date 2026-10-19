/**
 * The write primitives every item path uses (web, MCP, CLI push): who is writing, number and slug
 * allocation, the insert of a new item with revision 1, and the ONE content statement of data-model.md
 * section 3 (optimistic revision check, observation expiry, stale → active, revision snapshot).
 */
import {
  cleanLine,
  codePointLength,
  ITEM_LIMITS,
  isReservedSlugShape,
  itemSlug,
  SLUG_MAX,
  SLUG_RE,
  TAG_RE,
  uniqueSlug,
  utf8Length,
  validateAnchor,
} from '@spoor/shared'
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { edges, itemRevisions, items, projects, type VIAS } from '../../db/schema.js'
import { type AuthContext, actorLabel } from '../../lib/auth-context.js'
import { type DbOrTx, escapeLike, type Tx } from '../../lib/db.js'
import { ApiError, type ErrorExtra } from '../../lib/errors.js'
import type { Space } from '../../ports.js'
import type { EdgeActor } from './links.js'
import { canonicalFrontmatter } from './markdown.js'
import { handleOf, type LoadedItem, loadItem, type ProjectRef, type View } from './rows.js'

export type WriteVia = Exclude<(typeof VIAS)[number], 'import' | 'system'>

/** The caller of an item operation: who, through which surface, in which project. */
export interface Caller {
  ctx: AuthContext
  via: WriteVia
  project: ProjectRef
}

export interface Actor extends EdgeActor {
  tokenId: string | null
  via: WriteVia
}

export function actorOf(caller: Caller): Actor {
  return {
    userId: caller.ctx.user?.id ?? null,
    label: actorLabel(caller.ctx),
    tokenId: caller.ctx.tokenId ?? null,
    via: caller.via,
    clientName: caller.ctx.clientName ?? (caller.via === 'web' ? 'web' : null),
  }
}

/** `agent` after an MCP content write; `human` after a web write or a CLI push (a reviewed repo file). */
export const provenanceOf = (via: WriteVia): 'human' | 'agent' => (via === 'mcp' ? 'agent' : 'human')

export const readOnlySpace = () =>
  new ApiError('read_only_space', {
    message: 'The shared space is read-only here.',
    hint: 'Shared items are edited by humans in the web UI.',
  })

/**
 * Shared-space write rule (ADR-0005): only humans in the web UI with the instance-admin or shared-editor
 * right. Routes check the permission matrix first; this is the service-side backstop for every path.
 */
export function assertWritable(caller: Caller): void {
  if (caller.project.kind !== 'shared') return
  const u = caller.ctx.user
  if (caller.via !== 'web' || !u || !(u.isAdmin || u.sharedEditor)) throw readOnlySpace()
}

export function invalid(path: string, message: string, extra: ErrorExtra = {}): ApiError {
  return new ApiError('invalid_input', {
    message: extra.message ?? `Invalid ${path}: ${message}.`,
    hint: extra.hint,
    details: { issues: [{ path, message }] },
  })
}

// ---- field hygiene ------------------------------------------------------------------------------------

// the one copy of the limits (ITEM_LIMITS in @spoor/shared); lengths are code points, like the DB CHECKs
const { title: TITLE_MAX, body: BODY_MAX, extrasBytes: EXTRA_MAX_BYTES } = ITEM_LIMITS

export function cleanTitle(title: string, path = 'title'): string {
  const t = cleanLine(title)
  if (t === '') throw invalid(path, 'must not be empty')
  if (codePointLength(t) > TITLE_MAX) throw invalid(path, `at most ${TITLE_MAX} characters`)
  return t
}

/** 413 `too_large` (mcp.md section 7) for a body over the limit; never shorter than UTF-16 would say. */
export function cleanBody(body: string): string {
  if (body.length > BODY_MAX && codePointLength(body) > BODY_MAX) {
    throw new ApiError('too_large', {
      message: `The body is longer than ${BODY_MAX} characters.`,
      hint: `The limit is ${BODY_MAX} characters.`,
      details: { issues: [{ path: 'body', message: `at most ${BODY_MAX} characters` }], limit: BODY_MAX },
    })
  }
  return body
}

export function cleanTags(tags: readonly string[], path = 'tags'): string[] {
  const out: string[] = []
  tags.forEach((raw, i) => {
    const t = cleanLine(raw)
    if (!TAG_RE.test(t)) throw invalid(`${path}.${i}`, 'tags are lower-case: ^[a-z0-9][a-z0-9_/-]{0,39}$')
    if (!out.includes(t)) out.push(t)
  })
  if (out.length > ITEM_LIMITS.tags) throw invalid(path, `at most ${ITEM_LIMITS.tags} tags`)
  return out
}

export function cleanAnchors(anchors: readonly string[], path = 'anchors'): string[] {
  const out: string[] = []
  anchors.forEach((raw, i) => {
    const n = validateAnchor(raw)
    if (!n.ok) throw invalid(`${path}.${i}`, `anchor ${JSON.stringify(raw.slice(0, 80))}: ${n.reason}`)
    if (!out.includes(n.anchor)) out.push(n.anchor)
  })
  if (out.length > ITEM_LIMITS.anchors) throw invalid(path, `at most ${ITEM_LIMITS.anchors} anchors`)
  return out
}

export function cleanExtras(
  extra: Record<string, unknown>,
  known: Set<string>,
  path = 'extra',
): Record<string, unknown> {
  for (const k of Object.keys(extra)) {
    if (known.has(k)) throw invalid(`${path}.${k}`, 'is a known key; use the field instead')
  }
  if (utf8Length(JSON.stringify(extra)) > EXTRA_MAX_BYTES) {
    throw invalid(path, 'at most 8 KB of extra frontmatter')
  }
  return extra
}

export function validSlug(slug: string): string {
  const s = slug.trim()
  if (!SLUG_RE.test(s) || s.length > SLUG_MAX)
    throw invalid('slug', 'lower-case letters, digits and inner dashes, at most 80')
  if (isReservedSlugShape(s)) throw invalid('slug', 'would shadow a handle (m42, d7, adr-7, uuid)')
  return s
}

export const ITEM_SLUG_CONSTRAINT = 'items_project_space_slug_uq'

// ---- allocation ---------------------------------------------------------------------------------------

export interface Allocation {
  number: number
  adrNumber: number | null
  /** `{from, to}` when the requested ADR number was held by another item. */
  renumbered: { from: number; to: number } | null
  settings: unknown
}

/**
 * Take the next item number (and ADR number) under the project row lock. ADR numbers: an explicit free
 * number is used as is (the counter then becomes `greatest(next, n + 1)`); a held one is 409
 * `already_exists` (`onTaken: 'error'`) or moves to `greatest(next_adr_number, reserveAbove + 1)`
 * (`'renumber'`, import and push); no number takes the counter. Numbers are never reused.
 */
export async function allocate(
  tx: Tx,
  project: ProjectRef,
  space: Space,
  adr: { number?: number | null; onTaken: 'error' | 'renumber'; reserveAbove?: number | null } = {
    onTaken: 'error',
  },
  view?: View,
): Promise<Allocation> {
  const [row] = await tx
    .update(projects)
    .set({ nextItemNumber: sql`${projects.nextItemNumber} + 1` })
    .where(eq(projects.id, project.id))
    .returning({
      number: sql<number>`${projects.nextItemNumber} - 1`,
      nextAdr: projects.nextAdrNumber,
      settings: projects.settings,
    })
  if (!row) throw new ApiError('not_found', { message: 'No such project.' })
  if (space !== 'decisions')
    return { number: row.number, adrNumber: null, renumbered: null, settings: row.settings }

  let n: number
  let renumbered: Allocation['renumbered'] = null
  const wanted = adr.number ?? null
  if (wanted !== null) {
    const [holder] = await tx
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.projectId, project.id), eq(items.adrNumber, wanted)))
      .limit(1)
    if (!holder) n = wanted
    else if (adr.onTaken === 'error') {
      const h = await loadItem(tx, holder.id)
      throw new ApiError('already_exists', {
        message: `ADR number ${wanted} is taken.`,
        details: { handle: h && view ? handleOf(h, view) : `ADR-${String(wanted).padStart(4, '0')}` },
      })
    } else {
      n = Math.max(row.nextAdr, (adr.reserveAbove ?? 0) + 1)
      renumbered = { from: wanted, to: n }
    }
  } else {
    n = row.nextAdr
  }
  if (n > 99999) throw invalid('adr', 'ADR numbers go up to 99999')
  await tx
    .update(projects)
    .set({ nextAdrNumber: sql`greatest(${projects.nextAdrNumber}, ${n + 1})` })
    .where(eq(projects.id, project.id))
  return { number: row.number, adrNumber: n, renumbered, settings: row.settings }
}

/**
 * The slug of a new item: an explicit one must be free (409 `slug_taken` with the holder's handle and
 * revision); a derived one gets `-2`, `-3`, … on collision. Slugs never change afterwards.
 */
export async function pickSlug(
  tx: DbOrTx,
  project: ProjectRef,
  space: Space,
  base: string,
  explicit: boolean,
  view: View,
): Promise<string> {
  if (explicit) {
    const [holder] = await tx
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.projectId, project.id), eq(items.space, space), eq(items.slug, base)))
      .limit(1)
    if (holder) throw await slugTaken(tx, holder.id, view)
    return base
  }
  const taken = await tx
    .select({ slug: items.slug })
    .from(items)
    .where(
      and(
        eq(items.projectId, project.id),
        eq(items.space, space),
        or(eq(items.slug, base), sql`${items.slug} LIKE ${`${escapeLike(base.slice(0, SLUG_MAX - 4))}-%`}`),
      ),
    )
  return uniqueSlug(base, new Set(taken.map((t) => t.slug)))
}

export async function slugTaken(db: DbOrTx, holderId: string, view: View): Promise<ApiError> {
  const h = await loadItem(db, holderId)
  return new ApiError('slug_taken', {
    message: 'An item with this slug already exists in this space.',
    hint: h ? `Update ${handleOf(h, view)} (revision ${h.revision}) instead.` : undefined,
    details: h ? { handle: handleOf(h, view), revision: h.revision } : {},
  })
}

export const deriveSlug = (title: string) => itemSlug(title)

// ---- content -----------------------------------------------------------------------------------------

export interface ContentFields {
  title: string
  body: string
  status: string
  type: string | null
  confidence: string | null
  tags: string[]
  anchors: string[]
  extras: Record<string, unknown>
  decidedOn: string | null
}

export const contentOf = (i: LoadedItem): ContentFields => ({
  title: i.title,
  body: i.body,
  status: i.status,
  type: i.type,
  confidence: i.confidence,
  tags: i.tags,
  anchors: i.anchors,
  extras: i.frontmatter,
  decidedOn: i.decidedOn,
})

const sameArray = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i])

/** Stable JSON for comparing extras (key order does not matter). */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

export function sameContent(a: ContentFields, b: ContentFields): boolean {
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.status === b.status &&
    a.type === b.type &&
    a.confidence === b.confidence &&
    sameArray(a.tags, b.tags) &&
    sameArray(a.anchors, b.anchors) &&
    (a.decidedOn ?? null) === (b.decidedOn ?? null) &&
    stableJson(a.extras) === stableJson(b.extras)
  )
}

export type RevisionChange = 'create' | 'update' | 'status' | 'supersede' | 'push'

export function snapshotOf(item: Pick<LoadedItem, 'id' | 'space' | 'adrNumber'>, f: ContentFields) {
  return canonicalFrontmatter({
    id: item.id,
    space: item.space,
    title: f.title,
    tags: f.tags,
    anchors: f.anchors,
    type: f.type,
    confidence: f.confidence,
    status: f.status,
    adrNumber: item.adrNumber,
    decidedOn: f.decidedOn,
    extras: f.extras,
  })
}

/**
 * The complete content statement (data-model.md section 3), run inside the caller's transaction:
 * optimistic check on `expected`, observation expiry (`now() + observation_days` when the type becomes
 * `observation`, kept while it stays one, cleared otherwise), a stale item becomes active, `updated_at`
 * and the revision advance, and the full snapshot goes into `item_revisions`. 0 rows → `not_found` or
 * 409 `revision_conflict` with the current revision. Callers re-index chunks and wikilinks afterwards.
 */
export async function writeContent(
  tx: Tx,
  args: {
    item: LoadedItem
    expected: number
    fields: ContentFields
    change: RevisionChange
    actor: Actor
    provenance: 'human' | 'agent'
    observationDays: number
    extraSet?: Partial<typeof items.$inferInsert>
  },
): Promise<LoadedItem> {
  const { item, fields: f, actor } = args
  const updated = await tx
    .update(items)
    .set({
      title: f.title,
      body: f.body,
      status: f.status,
      type: f.type as LoadedItem['type'],
      confidence: f.confidence as LoadedItem['confidence'],
      tags: f.tags,
      anchors: f.anchors,
      frontmatter: f.extras,
      decidedOn: f.decidedOn,
      provenance: args.provenance,
      expiresAt:
        f.type === 'observation'
          ? sql`CASE WHEN ${items.type} = 'observation' THEN ${items.expiresAt}
                     ELSE now() + make_interval(days => ${args.observationDays}::int) END`
          : null,
      statusChangedAt: sql`CASE WHEN ${items.status} IS DISTINCT FROM ${f.status} THEN now() ELSE ${items.statusChangedAt} END`,
      lifecycle: sql`CASE WHEN ${items.lifecycle} = 'stale' THEN 'active' ELSE ${items.lifecycle} END`,
      staleSince: sql`CASE WHEN ${items.lifecycle} = 'stale' THEN NULL ELSE ${items.staleSince} END`,
      revision: sql`${items.revision} + 1`,
      updatedAt: sql`now()`,
      updatedBy: actor.userId,
      updatedByLabel: actor.label,
      clientName: actor.clientName,
      ...args.extraSet,
    })
    .where(and(eq(items.id, item.id), eq(items.revision, args.expected)))
    .returning({ id: items.id, revision: items.revision })
  const row = updated[0]
  if (!row) {
    const current = await loadItem(tx, item.id)
    if (!current) throw new ApiError('not_found')
    throw new ApiError('revision_conflict', {
      message: `Item is at revision ${current.revision}, the request was based on ${args.expected}.`,
      hint: 'Re-read the item and re-apply your change.',
      details: { current_revision: current.revision },
    })
  }
  await tx.insert(itemRevisions).values({
    itemId: item.id,
    revision: row.revision,
    title: f.title,
    body: f.body,
    status: f.status,
    frontmatter: snapshotOf(item, f),
    change: args.change,
    actorUserId: actor.userId,
    actorLabel: actor.label,
    tokenId: actor.tokenId,
    via: actor.via,
    clientName: actor.clientName,
  })
  return (await loadItem(tx, item.id)) as LoadedItem
}

/**
 * `superseded` is sticky: while a live (non-superseded) item supersedes this one, a write that asks for
 * another status keeps `superseded` (warning `status_kept_superseded`).
 */
export async function stickyStatus(
  db: DbOrTx,
  item: LoadedItem,
  requested: string,
): Promise<{ status: string; kept: boolean }> {
  if (item.status !== 'superseded' || requested === 'superseded') return { status: requested, kept: false }
  const [live] = await db
    .select({ id: edges.id })
    .from(edges)
    .innerJoin(items, eq(items.id, edges.srcId))
    .where(and(eq(edges.dstId, item.id), eq(edges.kind, 'supersedes'), ne(items.status, 'superseded')))
    .limit(1)
  return live ? { status: 'superseded', kept: true } : { status: requested, kept: false }
}

/** `last_used_at` bump (cleanup-and-jobs.md section 3): at most once an hour, no revision, no audit. */
export async function touchUsed(db: DbOrTx, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await db
    .update(items)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        inArray(items.id, ids),
        sql`(${items.lastUsedAt} IS NULL OR ${items.lastUsedAt} < now() - interval '1 hour')`,
      ),
    )
}
