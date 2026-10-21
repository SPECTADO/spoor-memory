/**
 * The project graph (`GET …/graph`, ADR-0021): items as nodes, `edges` rows as edges, under the visibility
 * rules of `ItemService.edges`. Two modes: the whole project (core = items of the project matching the
 * filters) and a focus walk (breadth-first both ways from one item, `depth` hops, ghosts not expanded).
 * The filter predicate F and edge visibility are SQL; degree, truncation and ordering are done here on the
 * loaded rows (at most the project's edges). Id lists go to Postgres as one `uuid[]` parameter, so walks of
 * any size stay within its bind-parameter limit.
 */
import {
  GRAPH_NODE_CAP,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphNode,
  type GraphQuery,
  type GraphResponse,
  spaces as SPACE_ORDER,
} from '@spoor/shared'
import { and, asc, type Column, eq, inArray, isNull, notInArray, or, type SQL, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { edges, items, projects } from '../../db/schema.js'
import type { DbOrTx } from '../../lib/db.js'
import { TYPED_KINDS } from './links.js'
import { handleOf, type View } from './rows.js'

export interface GraphArgs {
  /** The viewed project. */
  project: { id: string; kind: 'project' | 'shared' }
  query: GraphQuery
  /** Projects whose edges into `_shared` the viewer may see (`null` = all, instance admin). */
  memberProjects: string[] | null
  /** The resolved `focus` item (neighbourhood mode). */
  focusId?: string
  /** Node cap (tests lower it). */
  cap?: number
}

const HIDDEN_STATUSES = ['superseded', 'deprecated']

/** `col = ANY($1::uuid[])`: one bind parameter however long `ids` is (false for an empty list). */
const anyId = (col: Column, ids: readonly string[]): SQL => sql`${col} = ANY(${sql.param(ids)}::uuid[])`

/** `items` or an alias of it. */
type ItemTable = Record<'projectId' | 'space' | 'lifecycle' | 'status', Column>

/** F(item): in the viewed project and inside the filters (NULL for a missing left-joined row). */
function filterOf(t: ItemTable, a: GraphArgs): SQL {
  const q = a.query
  return and(
    eq(t.projectId, a.project.id),
    inArray(t.space, q.spaces),
    inArray(t.lifecycle, q.lifecycle),
    q.include_superseded ? undefined : notInArray(t.status, HIDDEN_STATUSES),
  ) as SQL
}

interface EdgeRow {
  id: string
  kind: string
  srcId: string
  dstId: string | null
  dstRef: string
  srcCore: boolean
  dstCore: boolean
}

/** Visible edges of the selected kinds matching `where` (`s` / `d` are the src / dst items). */
async function edgeRows(
  db: DbOrTx,
  a: GraphArgs,
  where: (s: ItemTable, d: ItemTable) => SQL | undefined,
): Promise<EdgeRow[]> {
  const s = alias(items, 's')
  const d = alias(items, 'd')
  const p = a.project.id
  // edges.project_id is the project of src; edges never point from `_shared` into a project. A project view
  // also sees `_shared`'s own edges (both ends shared, so ghosts): they only survive with a core end, i.e.
  // around a shared focus item; between two ghosts they are dropped.
  const visible =
    a.project.kind === 'shared'
      ? or(
          eq(edges.projectId, p),
          and(
            eq(d.projectId, p),
            a.memberProjects === null ? undefined : anyId(edges.projectId, a.memberProjects),
          ),
        )
      : or(
          eq(edges.projectId, p),
          inArray(
            edges.projectId,
            db.select({ id: projects.id }).from(projects).where(eq(projects.kind, 'shared')),
          ),
        )
  return db
    .select({
      id: edges.id,
      kind: edges.kind,
      srcId: edges.srcId,
      dstId: edges.dstId,
      dstRef: edges.dstRef,
      srcCore: sql<boolean>`coalesce(${filterOf(s, a)}, false)`,
      dstCore: sql<boolean>`coalesce(${filterOf(d, a)}, false)`,
    })
    .from(edges)
    .innerJoin(s, eq(s.id, edges.srcId))
    .leftJoin(d, eq(d.id, edges.dstId))
    .where(and(visible, inArray(edges.kind, a.query.kinds), where(s, d)))
    .orderBy(asc(edges.createdAt), asc(edges.id))
}

const nodeColumns = {
  id: items.id,
  projectSlug: projects.slug,
  projectKind: projects.kind,
  space: items.space,
  number: items.number,
  adrNumber: items.adrNumber,
  title: items.title,
  type: items.type,
  status: items.status,
  lifecycle: items.lifecycle,
  confidence: items.confidence,
  pinned: items.pinned,
  provenance: items.provenance,
  tags: items.tags,
  updatedAt: items.updatedAt,
  lastVerifiedAt: items.lastVerifiedAt,
}

async function nodeRows(db: DbOrTx, where: SQL | undefined) {
  return db.select(nodeColumns).from(items).innerJoin(projects, eq(projects.id, items.projectId)).where(where)
}

type NodeRow = Awaited<ReturnType<typeof nodeRows>>[number]

/** Whole project: core = F; kept = visible edges with a core end (dangling: core src). */
async function wholeProject(db: DbOrTx, a: GraphArgs) {
  const kept = await edgeRows(db, a, (s, d) => or(filterOf(s, a), filterOf(d, a)))
  const core = await nodeRows(db, filterOf(items, a))
  const coreIds = new Set(core.map((r) => r.id))
  const ghostIds = new Set<string>()
  for (const e of kept) for (const id of [e.srcId, e.dstId]) if (id && !coreIds.has(id)) ghostIds.add(id)
  const ghosts = ghostIds.size ? await nodeRows(db, anyId(items.id, [...ghostIds])) : []
  return { kept, core, ghosts }
}

/** Focus walk: BFS both ways up to `depth`; reached items with F are core and expanded, others are ghosts. */
async function focusWalk(db: DbOrTx, a: GraphArgs, focusId: string) {
  const walked = new Map<string, boolean>([[focusId, true]]) // id → core
  let frontier = [focusId]
  for (let hop = 1; hop <= a.query.depth && frontier.length; hop++) {
    const ids = frontier
    const found = await edgeRows(db, a, () => or(anyId(edges.srcId, ids), anyId(edges.dstId, ids)))
    const next: string[] = []
    for (const e of found)
      for (const [id, core] of [
        [e.srcId, e.srcCore],
        [e.dstId, e.dstCore],
      ] as const) {
        if (!id || walked.has(id)) continue
        walked.set(id, core)
        if (core) next.push(id)
      }
    frontier = next
  }
  const ids = [...walked.keys()]
  const rows = await edgeRows(db, a, () =>
    and(anyId(edges.srcId, ids), or(isNull(edges.dstId), anyId(edges.dstId, ids))),
  )
  const isCore = (id: string | null) => (id ? walked.get(id) === true : false)
  const kept = rows.filter((e) => (e.dstId === null ? isCore(e.srcId) : isCore(e.srcId) || isCore(e.dstId)))
  const loaded = await nodeRows(db, anyId(items.id, ids))
  return {
    kept,
    core: loaded.filter((r) => isCore(r.id)),
    ghosts: loaded.filter((r) => !isCore(r.id)),
  }
}

const spaceRank = (s: string) => (SPACE_ORDER as readonly string[]).indexOf(s)

export async function graph(db: DbOrTx, a: GraphArgs): Promise<GraphResponse> {
  const cap = a.cap ?? GRAPH_NODE_CAP
  const { kept, core, ghosts } = a.focusId ? await focusWalk(db, a, a.focusId) : await wholeProject(db, a)

  const degIn = new Map<string, number>()
  const degOut = new Map<string, number>()
  const bump = (m: Map<string, number>, id: string) => m.set(id, (m.get(id) ?? 0) + 1)
  for (const e of kept) {
    bump(degOut, e.srcId)
    if (e.dstId) bump(degIn, e.dstId)
  }
  const degree = (id: string) => (degIn.get(id) ?? 0) + (degOut.get(id) ?? 0)
  const ghostSet = new Set(ghosts.map((r) => r.id))
  const all = [...core, ...ghosts]
  const unlinked = core.filter((r) => degree(r.id) === 0).length
  const dangling = new Set(kept.filter((e) => e.dstId === null).map((e) => e.dstRef)).size

  // `unlinked` (whole project only): just the degree-0 core nodes, picked over all kept edges before the cap;
  // meta still describes the full filtered graph
  const pool = a.query.unlinked ? core.filter((r) => degree(r.id) === 0) : all
  let nodes = pool
  let keptEdges = a.query.unlinked ? [] : kept
  // truncation: core before ghosts; pinned, degree, updated_at desc; id asc; the focus node always stays
  const truncated = pool.length > cap
  if (truncated) {
    const prio = (r: NodeRow) => [
      r.id === a.focusId ? 0 : 1,
      ghostSet.has(r.id) ? 1 : 0,
      r.pinned ? 0 : 1,
      -degree(r.id),
      -r.updatedAt.getTime(),
    ]
    const ranked = [...pool].sort((x, y) => {
      const px = prio(x)
      const py = prio(y)
      for (let i = 0; i < px.length; i++) if (px[i] !== py[i]) return (px[i] as number) - (py[i] as number)
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0
    })
    const keep = new Set(ranked.slice(0, cap).map((r) => r.id))
    keptEdges = keptEdges.filter((e) => keep.has(e.srcId) && (e.dstId === null || keep.has(e.dstId)))
    const touched = new Set(keptEdges.flatMap((e) => (e.dstId ? [e.srcId, e.dstId] : [e.srcId])))
    nodes = pool.filter((r) => keep.has(r.id) && (!ghostSet.has(r.id) || touched.has(r.id)))
  }

  const sorted = [...nodes].sort((x, y) => {
    const gx = ghostSet.has(x.id) ? 1 : 0
    const gy = ghostSet.has(y.id) ? 1 : 0
    if (gx !== gy) return gx - gy
    const sx = spaceRank(x.space)
    const sy = spaceRank(y.space)
    if (sx !== sy) return sx - sy
    if (x.number !== y.number) return x.number - y.number
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0
  })
  const view: View = { projectId: a.project.id, projectIsShared: a.project.kind === 'shared' }
  const typed = TYPED_KINDS as readonly string[]
  return {
    nodes: sorted.map(
      (r): GraphNode => ({
        id: r.id,
        handle: handleOf(r, view),
        project: r.projectSlug,
        space: r.space,
        title: r.title,
        type: r.type,
        status: r.status,
        lifecycle: r.lifecycle,
        confidence: r.confidence,
        pinned: r.pinned,
        provenance: r.provenance,
        tags: r.tags,
        updated_at: r.updatedAt.toISOString(),
        last_verified_at: r.lastVerifiedAt.toISOString(),
        degree_in: degIn.get(r.id) ?? 0,
        degree_out: degOut.get(r.id) ?? 0,
        ghost: ghostSet.has(r.id),
      }),
    ),
    edges: keptEdges.map(
      (e): GraphEdge => ({
        id: e.id,
        kind: e.kind as GraphEdgeKind,
        src: e.srcId,
        dst: e.dstId,
        ...(e.dstId === null ? { dst_ref: e.dstRef } : {}),
        editable: typed.includes(e.kind),
      }),
    ),
    meta: {
      truncated,
      node_cap: cap,
      total_nodes: all.length,
      unlinked_count: unlinked,
      dangling_count: dangling,
    },
  }
}
