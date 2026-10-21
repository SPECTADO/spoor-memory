/**
 * How the map draws things: per-space node shape and colours, per-kind edge style, and the text labels that
 * go with them (legend, filters, side card). Colours are CSS variables of src/index.css only; every colour
 * has a non-colour twin (shape, dash pattern, arrowheads, text) so nothing is told by colour alone.
 */
import type { EdgeKind, GraphNode, Space } from '../../api/types'
import { SHARED_SLUG } from '../../lib/paths'
import { handleText, SPACE_LABEL } from '../item/common'

export const KIND_LABEL: Record<EdgeKind, string> = {
  refines: 'refines',
  supports: 'supports',
  depends_on: 'depends on',
  conflicts_with: 'conflicts with',
  supersedes: 'supersedes',
  drafted_from: 'drafted from',
  wikilink: 'wikilink',
}

/** Section titles in the side card, as on the item page's Links panel. */
export const OUT_LABEL: Record<EdgeKind, string> = {
  refines: 'Refines',
  supports: 'Supports',
  depends_on: 'Depends on',
  conflicts_with: 'Conflicts with',
  supersedes: 'Supersedes',
  drafted_from: 'Drafted from',
  wikilink: 'Links to',
}
export const IN_LABEL: Record<EdgeKind, string> = {
  refines: 'Refined by',
  supports: 'Supported by',
  depends_on: 'Needed by',
  conflicts_with: 'Conflicts with',
  supersedes: 'Superseded by',
  drafted_from: 'Drafted into',
  wikilink: 'Linked from',
}
export const KIND_ORDER: EdgeKind[] = [
  'supersedes',
  'conflicts_with',
  'refines',
  'supports',
  'depends_on',
  'drafted_from',
  'wikilink',
]

export interface EdgeStyle {
  stroke: string
  width: number
  dash?: string
  /** Arrowheads at both ends (symmetric kind). */
  both?: boolean
  opacity?: number
  /** Legend text for the line style. */
  pattern: string
}

export const EDGE_STYLE: Record<EdgeKind, EdgeStyle> = {
  refines: { stroke: 'var(--c-accent)', width: 1.5, pattern: 'solid line, arrow' },
  supports: { stroke: 'var(--c-success)', width: 1.5, pattern: 'solid line, arrow' },
  depends_on: { stroke: 'var(--c-warning)', width: 1.5, pattern: 'solid line, arrow' },
  conflicts_with: {
    stroke: 'var(--c-danger)',
    width: 2,
    both: true,
    pattern: 'solid line, arrows at both ends',
  },
  supersedes: { stroke: 'var(--c-fg)', width: 1.25, dash: '6 4', pattern: 'dashed line, arrow' },
  drafted_from: { stroke: 'var(--c-fg)', width: 1.25, dash: '1.5 3', pattern: 'dotted line, arrow' },
  wikilink: { stroke: 'var(--c-muted)', width: 1, opacity: 0.75, pattern: 'thin line, arrow' },
}

export type NodeShape = 'circle' | 'diamond' | 'square' | 'hexagon'

export const SPACE_STYLE: Record<Space, { fill: string; stroke: string; shape: NodeShape }> = {
  memories: { fill: 'var(--c-accent-soft)', stroke: 'var(--c-accent)', shape: 'circle' },
  decisions: { fill: 'var(--c-success-soft)', stroke: 'var(--c-success)', shape: 'diamond' },
  docs: { fill: 'var(--c-warning-soft)', stroke: 'var(--c-warning)', shape: 'square' },
  library: { fill: 'var(--c-surface-2)', stroke: 'var(--c-fg)', shape: 'hexagon' },
}

const f = (v: number) => Math.round(v * 100) / 100

/** SVG path of `shape` with outer radius `r` around (0, 0); the polygons are scaled to look as big as a circle. */
export function shapePath(shape: NodeShape, r: number): string {
  switch (shape) {
    case 'circle':
      return `M${f(-r)},0a${f(r)},${f(r)} 0 1,0 ${f(2 * r)},0a${f(r)},${f(r)} 0 1,0 ${f(-2 * r)},0Z`
    case 'diamond': {
      const d = r * 1.25
      return `M0,${f(-d)}L${f(d)},0L0,${f(d)}L${f(-d)},0Z`
    }
    case 'square': {
      const s = r * 0.9
      return `M${f(-s)},${f(-s)}H${f(s)}V${f(s)}H${f(-s)}Z`
    }
    case 'hexagon': {
      const h = r * 1.08
      const pts = [0, 1, 2, 3, 4, 5].map((i) => {
        const a = (Math.PI / 3) * i
        return `${f(h * Math.cos(a))},${f(h * Math.sin(a))}`
      })
      return `M${pts.join('L')}Z`
    }
  }
}

type ViewNodeLike = { node: GraphNodeLike | null; ref: string | null; ghost: boolean; degree: number }

/** Where a ghost lives: `outside the filters`, `in the shared space`, `in project x`; null for a core node. */
export function nodePlace(v: ViewNodeLike, slug: string): string | null {
  const n = v.node
  if (!n || !v.ghost) return null
  if (n.project === slug) return 'outside the filters'
  return n.project === SHARED_SLUG ? 'in the shared space' : `in project ${n.project}`
}

/** Where a node lives and its state as words: `in the shared space`, `pinned`, `stale`, `superseded`. */
export function nodeState(v: ViewNodeLike, slug: string): string[] {
  if (!v.node) return ['no such item']
  const n = v.node
  const out: string[] = []
  const place = nodePlace(v, slug)
  if (place) out.push(place)
  if (n.pinned) out.push('pinned')
  if (n.lifecycle !== 'active') out.push(n.lifecycle)
  if (n.status === 'superseded' || n.status === 'deprecated') out.push(n.status)
  return out
}

/** One line for screen readers and tooltips: handle (with `~`), title, space, state and link count, e.g.
 * `m12~ Tokens are hashed, memory, pinned, stale, 3 links`. */
export function describeNode(v: ViewNodeLike, slug: string): string {
  const links = `${v.degree} ${v.degree === 1 ? 'link' : 'links'}`
  const name = v.node
    ? [`${handleText(v.node)} ${v.node.title}`, SPACE_LABEL[v.node.space]]
    : [`[[${v.ref ?? ''}]]`]
  return [...name, ...nodeState(v, slug), links].join(', ')
}

type GraphNodeLike = Pick<
  GraphNode,
  'handle' | 'provenance' | 'title' | 'space' | 'project' | 'pinned' | 'lifecycle' | 'status'
>
