/**
 * Item rows as the items module loads them (with their project's slug and kind) and their JSON shapes
 * (api.md section 0.6: `ItemSummary`, `Item`, `Actor`). Handles are relative to the caller's project: a
 * shared item seen from a regular project carries the `S:` prefix.
 */
import type { ItemSummary } from '@spoor/shared'
import { and, desc, eq, sql } from 'drizzle-orm'
import { edges, items, projects } from '../../db/schema.js'
import type { DbOrTx } from '../../lib/db.js'
import type { Space } from '../../ports.js'
import { itemHandle } from './resolve.js'

export type ItemRow = typeof items.$inferSelect
export type LoadedItem = ItemRow & { projectSlug: string; projectKind: 'project' | 'shared' }

/** The project a request acts in (the path's project on cookie routes, the token's on bearer routes). */
export interface ProjectRef {
  id: string
  slug: string
  kind: 'project' | 'shared'
}

/** Whose eyes a handle is formatted for. */
export interface View {
  projectId: string
  projectIsShared: boolean
}

export const viewOf = (p: ProjectRef): View => ({ projectId: p.id, projectIsShared: p.kind === 'shared' })

export const loadedColumns = {
  item: items,
  projectSlug: projects.slug,
  projectKind: projects.kind,
}

/** A `loadedColumns` row as a `LoadedItem`. */
export const flatten = (r: {
  item: ItemRow
  projectSlug: string
  projectKind: 'project' | 'shared'
}): LoadedItem => ({
  ...r.item,
  projectSlug: r.projectSlug,
  projectKind: r.projectKind,
})

/** One item by id (no scope check: callers resolve refs with `resolveItemRef` first). */
export async function loadItem(db: DbOrTx, id: string, lock = false): Promise<LoadedItem | undefined> {
  const q = db
    .select(loadedColumns)
    .from(items)
    .innerJoin(projects, eq(projects.id, items.projectId))
    .where(eq(items.id, id))
    .limit(1)
  const [row] = lock ? await q.for('update', { of: items }) : await q
  return row ? flatten(row) : undefined
}

export async function loadItems(db: DbOrTx, where: ReturnType<typeof and>): Promise<LoadedItem[]> {
  const rows = await db
    .select(loadedColumns)
    .from(items)
    .innerJoin(projects, eq(projects.id, items.projectId))
    .where(where)
  return rows.map(flatten)
}

export function handleOf(
  row: Pick<LoadedItem, 'space' | 'number' | 'adrNumber' | 'projectKind'>,
  view: View,
): string {
  return itemHandle(
    row as { space: Space; number: number; adrNumber: number | null },
    row.projectKind === 'shared' && !view.projectIsShared,
  )
}

/**
 * The handle as agents read it in the digest, search results and `spoor_get`: `m42~` when the content was
 * last written by an agent and no human has edited, verified or pinned it since (auth-and-security.md 13).
 */
export function markedHandle(
  row: Pick<LoadedItem, 'space' | 'number' | 'adrNumber' | 'projectKind' | 'provenance'>,
  view: View,
): string {
  return `${handleOf(row, view)}${row.provenance === 'agent' ? '~' : ''}`
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

/** The ONE `ItemSummary` serializer (lists, search, review, digest all call it). */
export function summaryJson(row: LoadedItem, view: View): ItemSummary {
  return {
    id: row.id,
    handle: handleOf(row, view),
    project: row.projectSlug,
    space: row.space,
    number: row.number,
    adr_number: row.adrNumber,
    slug: row.slug,
    title: row.title,
    type: row.type,
    status: row.status,
    lifecycle: row.lifecycle,
    confidence: row.confidence,
    tags: row.tags,
    anchors: row.anchors,
    pinned: row.pinned,
    revision: row.revision,
    provenance: row.provenance,
    decided_on: row.decidedOn,
    source_path: row.sourcePath,
    push_conflict_at: iso(row.pushConflictAt),
    last_verified_at: row.lastVerifiedAt.toISOString(),
    last_used_at: iso(row.lastUsedAt),
    expires_at: iso(row.expiresAt),
    stale_since: iso(row.staleSince),
    archived_at: iso(row.archivedAt),
    archive_reason: row.archiveReason,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    updated_by: row.updatedByLabel,
    client_name: row.clientName,
  }
}

export type ItemSummaryJson = ItemSummary

export type ItemJson = ItemSummaryJson & {
  body: string
  extra: Record<string, unknown>
  created_by: { id: string | null; label: string }
  superseded_by: string | null
}

/**
 * The newest live item that supersedes `id` (a superseded superseder ranks last). Only a superseder of the
 * item's own project counts: supersedes never crosses projects, and a foreign one would show another
 * project's item on a shared item's page (review S2, defence in depth).
 */
export async function supersededBy(db: DbOrTx, id: string, view: View): Promise<string | null> {
  const [row] = await db
    .select(loadedColumns)
    .from(edges)
    .innerJoin(items, eq(items.id, edges.srcId))
    .innerJoin(projects, eq(projects.id, items.projectId))
    .where(
      and(
        eq(edges.dstId, id),
        eq(edges.kind, 'supersedes'),
        sql`${items.projectId} = (SELECT d.project_id FROM items d WHERE d.id = ${id})`,
      ),
    )
    .orderBy(sql`${items.status} IN ('superseded','deprecated')`, desc(edges.createdAt))
    .limit(1)
  return row ? handleOf(flatten(row), view) : null
}

export async function itemJson(db: DbOrTx, row: LoadedItem, view: View): Promise<ItemJson> {
  return {
    ...summaryJson(row, view),
    body: row.body,
    extra: row.frontmatter,
    created_by: { id: row.createdBy, label: row.createdByLabel },
    superseded_by: await supersededBy(db, row.id, view),
  }
}

export interface ActorJson {
  user_id: string | null
  label: string
  via: string
  client_name: string | null
}
