/**
 * The one project-scoped id resolver (data-model.md section 0, review S2, deviation I42). Every lookup it
 * runs is limited to `$allowed`:
 * - `write` scope (write targets, sources, `old` / `new_id` positions): the caller's project only;
 * - `read` scope (read ids, edge-target positions): the caller's project plus `_shared`.
 * A uuid or slug of another project is `not_found`, exactly like one that does not exist.
 *
 * Accepted forms, in order: `S:` prefix (selects `_shared`), `m<n>` / `d<n>` / `L<n>` (number in that
 * space; `L` in either case), `ADR-<n>` (case-insensitive, adr_number), uuid, otherwise a slug searched
 * across the spaces (more than one hit is 409 `ambiguous_id` with `details.handles`). A read slug that
 * names one own item and also a `_shared` library page is `ambiguous_id` too, so a same-slug twin never
 * silently replaces a shared library page. Wikilink text resolution (`[[…]]`, `shared:` prefix, per-space
 * precedence) is the items module's, built on top of this.
 */
import { formatHandle, HANDLE_KIND_SPACE, parseHandle, SLUG_RE, SPACE_HANDLE_KIND } from '@spoor/shared'
import { and, eq, type SQL, sql } from 'drizzle-orm'
import { items, projects } from '../../db/schema.js'
import type { DbOrTx } from '../../lib/db.js'
import { ApiError } from '../../lib/errors.js'
import type { Space } from '../../ports.js'

export type ResolveMode = 'read' | 'write'

export interface ResolveScope {
  /** The caller's project (the path's project on cookie routes, the token's on bearer routes). */
  projectId: string
  /** `true` when the caller's project is `_shared` itself (web IA / SE): then both scopes are `_shared`. */
  projectIsShared: boolean
  mode: ResolveMode
}

export interface ResolvedItem {
  id: string
  projectId: string
  /** The item lives in `_shared`. */
  shared: boolean
  space: Space
  number: number
  adrNumber: number | null
  slug: string
  title: string
  /** `m42`, `d7`, `ADR-0007`; `S:`-prefixed for a shared item seen from a regular project. */
  handle: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REF_MAX = 200

/**
 * The handle of an item (`m42`, `d7`, `L3`, `ADR-0007`); `shared` adds the `S:` prefix (use it for shared
 * items outside `_shared`).
 */
export function itemHandle(
  item: { space: Space; number: number; adrNumber: number | null },
  shared = false,
): string {
  const kind = SPACE_HANDLE_KIND[item.space]
  return formatHandle(kind, kind === 'decision' ? (item.adrNumber ?? item.number) : item.number, shared)
}

const notFound = (ref: string) =>
  new ApiError('not_found', { message: `No item ${JSON.stringify(ref.slice(0, REF_MAX))} in this project.` })

const sharedProjectId = sql`(SELECT ${projects.id} FROM ${projects} WHERE ${projects.kind} = 'shared')`

const columns = {
  id: items.id,
  projectId: items.projectId,
  space: items.space,
  number: items.number,
  adrNumber: items.adrNumber,
  slug: items.slug,
  title: items.title,
  inShared: sql<boolean>`${items.projectId} = ${sharedProjectId}`,
}

interface Row {
  id: string
  projectId: string
  space: Space
  number: number
  adrNumber: number | null
  slug: string
  title: string
  inShared: boolean
}

function toResolved(row: Row, scope: ResolveScope): ResolvedItem {
  const shared = row.inShared === true
  return {
    id: row.id,
    projectId: row.projectId,
    shared,
    space: row.space,
    number: row.number,
    adrNumber: row.adrNumber,
    slug: row.slug,
    title: row.title,
    // inside `_shared` handles carry no prefix (the path already says which space)
    handle: itemHandle(row, shared && !scope.projectIsShared),
  }
}

async function find(db: DbOrTx, where: SQL | undefined, limit = 2): Promise<Row[]> {
  return db.select(columns).from(items).where(where).orderBy(items.number).limit(limit)
}

/** The project condition for one lookup: the caller's project, `_shared`, or either. */
function inProjects(scope: ResolveScope, which: 'own' | 'shared' | 'allowed'): SQL {
  if (which === 'own' || (which === 'allowed' && (scope.mode === 'write' || scope.projectIsShared))) {
    return eq(items.projectId, scope.projectId)
  }
  if (which === 'shared') return sql`${items.projectId} = ${sharedProjectId}`
  return sql`(${items.projectId} = ${scope.projectId} OR ${items.projectId} = ${sharedProjectId})`
}

/**
 * Resolve `ref` inside `scope`, or throw 404 `not_found`, 409 `ambiguous_id`, or 403 `read_only_space`
 * (an explicit `S:` ref in a write position of a regular project).
 */
export async function resolveItemRef(db: DbOrTx, scope: ResolveScope, ref: string): Promise<ResolvedItem> {
  const text = ref.trim()
  if (text === '' || text.length > REF_MAX) throw notFound(ref)

  // 1. `S:` selects the shared project; inside `_shared` it is a no-op
  let body = text
  let target: 'own' | 'shared' | 'allowed' = 'allowed'
  if (text.startsWith('S:')) {
    body = text.slice(2)
    if (!scope.projectIsShared) {
      if (scope.mode === 'write') {
        throw new ApiError('read_only_space', {
          message: `${text} is in the shared space, which is read-only here.`,
          hint: 'Shared items are edited by humans in the web UI.',
        })
      }
      target = 'shared'
    } else {
      target = 'own'
    }
  }

  // 2. handles: m<n>, d<n>, L<n>, ADR-<n>, in the project the prefix names (no prefix: the caller's project)
  const handle = parseHandle(body)
  if (handle && !handle.shared) {
    const project = inProjects(scope, target === 'allowed' ? 'own' : target)
    const cond =
      handle.kind === 'decision'
        ? eq(items.adrNumber, handle.number)
        : and(eq(items.space, HANDLE_KIND_SPACE[handle.kind]), eq(items.number, handle.number))
    const [row] = await find(db, and(project, cond), 1)
    if (!row) throw notFound(text)
    return toResolved(row, scope)
  }
  if (handle) throw notFound(text) // `S:S:m1`

  // 3. uuid: looked up in $allowed
  if (UUID_RE.test(body)) {
    const [row] = await find(db, and(inProjects(scope, target), eq(items.id, body.toLowerCase())), 1)
    if (!row) throw notFound(text)
    return toResolved(row, scope)
  }

  // 4. slug across the spaces: the caller's project first, then `_shared` (read scope only)
  const slug = body.toLowerCase()
  if (!SLUG_RE.test(slug) || slug.length > 80) throw notFound(text)
  const order: ('own' | 'shared')[] =
    target === 'shared'
      ? ['shared']
      : target === 'own' || scope.mode === 'write' || scope.projectIsShared
        ? ['own']
        : ['own', 'shared']
  for (const which of order) {
    const rows = await find(db, and(inProjects(scope, which), eq(items.slug, slug)), 3)
    if (rows.length === 1) {
      const own = rows[0] as Row
      // an own non-library item with the slug of a `_shared` library page: name both (ADR-0014)
      if (which === 'own' && order.includes('shared') && own.space !== 'library') {
        const [lib] = await find(
          db,
          and(inProjects(scope, 'shared'), eq(items.space, 'library'), eq(items.slug, slug)),
          1,
        )
        if (lib) throw ambiguous(slug, [own, lib], scope)
      }
      return toResolved(own, scope)
    }
    if (rows.length > 1) throw ambiguous(slug, rows, scope)
  }
  throw notFound(text)
}

function ambiguous(slug: string, rows: Row[], scope: ResolveScope): ApiError {
  const handles = rows.map((r) => toResolved(r, scope).handle)
  return new ApiError('ambiguous_id', {
    message: `${JSON.stringify(slug)} names more than one item.`,
    hint: `Use a handle: ${handles.join(', ')}.`,
    details: { handles },
  })
}
