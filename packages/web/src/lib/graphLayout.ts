/**
 * Pure helpers of the project map (pages/graph): the drawable view of a `GraphResponse` (one ghost node per
 * dangling `dst_ref`), the text filter, node sizes, the d3-force layout and the zoom geometry. No React and
 * no DOM, so the layout runs synchronously and is unit-tested (jsdom has no layout engine). "Unlinked only" is
 * a server filter (`?unlinked=true`), so it stays correct on a truncated map.
 */
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'
import type { EdgeKind, GraphNode, GraphResponse } from '../api/types'

/** A node to draw: an item (`node`) or a dangling wikilink target (`ref`, client id `ref:<dst_ref>`). */
export interface ViewNode {
  id: string
  node: GraphNode | null
  ref: string | null
  ghost: boolean
  degree: number
}

export interface ViewEdge {
  id: string
  kind: EdgeKind
  src: string
  dst: string
  editable: boolean
}

export interface GraphView {
  nodes: ViewNode[]
  edges: ViewEdge[]
}

export const danglingId = (ref: string) => `ref:${ref}`

/** Items keep their order; one hollow ghost per distinct dangling `dst_ref` follows them. Edges with an end
 * missing from `nodes` (should not happen) are dropped. */
export function buildView(graph: Pick<GraphResponse, 'nodes' | 'edges'>): GraphView {
  const nodes: ViewNode[] = graph.nodes.map((n) => ({
    id: n.id,
    node: n,
    ref: null,
    ghost: n.ghost,
    degree: n.degree_in + n.degree_out,
  }))
  const ids = new Set(nodes.map((n) => n.id))
  const dangling = new Map<string, ViewNode>()
  const edges: ViewEdge[] = []
  for (const e of graph.edges) {
    let dst = e.dst
    if (dst === null) {
      const ref = e.dst_ref ?? ''
      dst = danglingId(ref)
      const ghost = dangling.get(dst) ?? { id: dst, node: null, ref, ghost: true, degree: 0 }
      ghost.degree += 1
      dangling.set(dst, ghost)
    } else if (!ids.has(dst)) continue
    if (!ids.has(e.src)) continue
    edges.push({ id: e.id, kind: e.kind, src: e.src, dst, editable: e.editable })
  }
  return { nodes: [...nodes, ...dangling.values()], edges }
}

/** Text filter (highlight): every whitespace-separated word must occur in the handle, title, a tag or the
 * dangling ref, case-insensitively. An empty query matches nothing (nothing is highlighted). */
export function matchesText(n: ViewNode, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return false
  const hay = (n.node ? [n.node.handle, n.node.title, ...n.node.tags] : [n.ref ?? '']).join(' ').toLowerCase()
  return words.every((w) => hay.includes(w))
}

export const RADIUS = { min: 6, max: 16 } as const

/** Node radius from its degree: square-root scale between 6 and 16 (16 for the best-linked node). */
export function nodeRadius(degree: number, maxDegree: number): number {
  if (maxDegree <= 0 || degree <= 0) return RADIUS.min
  const t = Math.sqrt(Math.min(degree, maxDegree) / maxDegree)
  return Math.round((RADIUS.min + t * (RADIUS.max - RADIUS.min)) * 10) / 10
}

export interface Point {
  x: number
  y: number
}
export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
export interface Layout {
  positions: Map<string, Point>
  /** Box around every node plus `padding`; never smaller than 200 x 200. */
  bounds: Bounds
}

export interface LayoutOptions {
  /** Simulation ticks; default scales down from 300 for big graphs. */
  ticks?: number
  /** Space around the outermost nodes (labels). Default 48. */
  padding?: number
  radius?: (id: string) => number
}

interface SimNode extends SimulationNodeDatum {
  id: string
}

/** Default number of ticks: 300 up to 200 nodes, then fewer (down to 60) so 1,500 nodes stay quick. */
export const defaultTicks = (n: number) => Math.max(60, Math.min(300, Math.round(60_000 / Math.max(1, n))))

/**
 * Force layout, run synchronously (`simulation.stop()` then a fixed number of `tick()`s). d3-force seeds its
 * own random source and places nodes on a phyllotaxis spiral in input order, so the same input gives the same
 * positions. Links pull connected nodes together, many-body pushes all apart, weak x/y forces keep unlinked
 * nodes and separate components near the centre, collide keeps circles from overlapping.
 */
export function layoutGraph(
  nodes: readonly { id: string }[],
  edges: readonly { src: string; dst: string }[],
  opts: LayoutOptions = {},
): Layout {
  const radius = opts.radius ?? (() => RADIUS.min)
  const padding = opts.padding ?? 48
  const sim: SimNode[] = nodes.map((n) => ({ id: n.id }))
  const known = new Set(sim.map((n) => n.id))
  const links: SimulationLinkDatum<SimNode>[] = edges
    .filter((e) => e.src !== e.dst && known.has(e.src) && known.has(e.dst))
    .map((e) => ({ source: e.src, target: e.dst }))

  const simulation = forceSimulation<SimNode>(sim)
    .force(
      'link',
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(links)
        .id((d) => d.id)
        .distance(60),
    )
    .force('charge', forceManyBody<SimNode>().strength(-120).distanceMax(400))
    .force('x', forceX<SimNode>(0).strength(0.06))
    .force('y', forceY<SimNode>(0).strength(0.06))
    .force(
      'collide',
      forceCollide<SimNode>((d) => radius(d.id) + 4),
    )
    .force('center', forceCenter(0, 0))
    .stop()
  const ticks = opts.ticks ?? defaultTicks(sim.length)
  for (let i = 0; i < ticks; i++) simulation.tick()

  const positions = new Map<string, Point>()
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const n of sim) {
    const x = Math.round((n.x ?? 0) * 10) / 10 || 0
    const y = Math.round((n.y ?? 0) * 10) / 10 || 0
    positions.set(n.id, { x, y })
    const r = radius(n.id)
    minX = Math.min(minX, x - r)
    minY = Math.min(minY, y - r)
    maxX = Math.max(maxX, x + r)
    maxY = Math.max(maxY, y + r)
  }
  if (sim.length === 0) minX = minY = maxX = maxY = 0
  let width = maxX - minX + 2 * padding
  let height = maxY - minY + 2 * padding
  let x = minX - padding
  let y = minY - padding
  if (width < 200) {
    x -= (200 - width) / 2
    width = 200
  }
  if (height < 200) {
    y -= (200 - height) / 2
    height = 200
  }
  return { positions, bounds: { x, y, width, height } }
}

/**
 * The visible part of an edge between two circles: from the rim of `a` (when `startGap`) to the rim of `b`
 * plus `endGap` (room for the arrowhead). A zero-length edge stays where it is.
 */
export function edgeSegment(
  a: Point,
  b: Point,
  ra: number,
  rb: number,
  gaps: { start?: number; end?: number } = {},
): { x1: number; y1: number; x2: number; y2: number } {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
  const ux = dx / len
  const uy = dy / len
  const s = Math.min(ra + (gaps.start ?? 0), len / 2)
  const e = Math.min(rb + (gaps.end ?? 0), len / 2)
  const r = (v: number) => Math.round(v * 10) / 10
  return { x1: r(a.x + ux * s), y1: r(a.y + uy * s), x2: r(b.x - ux * e), y2: r(b.y - uy * e) }
}

/** Zoom a view box by `factor` (>1 zooms out) around `p`, keeping `p` fixed; width clamped to [min, max]. */
export function zoomBox(box: Bounds, factor: number, p: Point, min: number, max: number): Bounds {
  const width = Math.min(max, Math.max(min, box.width * factor))
  const k = width / box.width
  return {
    x: p.x - (p.x - box.x) * k,
    y: p.y - (p.y - box.y) * k,
    width,
    height: box.height * k,
  }
}

/** Pixels per wheel `deltaMode` unit: pixels, lines (Firefox) and pages. */
const WHEEL_UNIT = [1, 16, 400] as const

/**
 * The zoom factor of one wheel event (>1 zooms out): `deltaY` normalised to pixels by `deltaMode`, then
 * clamped to [0.5, 2] so one fast flick or a page-mode delta cannot jump to the zoom limits.
 */
export function wheelFactor(deltaY: number, deltaMode: number): number {
  const px = deltaY * (WHEEL_UNIT[deltaMode as 0 | 1 | 2] ?? 1)
  return Math.min(2, Math.max(0.5, Math.exp(px * 0.0015)))
}
