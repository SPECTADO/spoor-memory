/**
 * The map page's URL state (`?spaces=…&kinds=…&lifecycle=…&superseded=1&unlinked=1&q=…&focus=…&depth=…&view=list`)
 * and the API params derived from it. Defaults are left out of the URL and of the request, so the default map
 * has a clean URL and one cache key.
 */
import {
  EDGE_KINDS,
  type EdgeKind,
  GRAPH_LIFECYCLES,
  type GraphLifecycle,
  type GraphParams,
  type Space,
} from '../../api/types'
import { SPACES } from '../item/common'

export type GraphViewMode = 'map' | 'list'

export interface GraphState {
  spaces: Space[]
  kinds: EdgeKind[]
  lifecycle: GraphLifecycle[]
  superseded: boolean
  unlinked: boolean
  q: string
  focus: string
  depth: 1 | 2
  view: GraphViewMode
}

export const DEFAULT_LIFECYCLE: readonly GraphLifecycle[] = ['active', 'stale']

/** Values of a csv param in canonical order; unknown values dropped; empty or absent → `fallback`. */
function csv<T extends string>(raw: string | null, all: readonly T[], fallback: readonly T[]): T[] {
  if (raw === null) return [...fallback]
  const picked = new Set(raw.split(','))
  const out = all.filter((v) => picked.has(v))
  return out.length > 0 ? out : [...fallback]
}

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i])

export function parseGraphState(p: URLSearchParams): GraphState {
  return {
    spaces: csv(p.get('spaces'), SPACES, SPACES),
    kinds: csv(p.get('kinds'), EDGE_KINDS, EDGE_KINDS),
    lifecycle: csv(p.get('lifecycle'), GRAPH_LIFECYCLES, DEFAULT_LIFECYCLE),
    superseded: p.get('superseded') === '1',
    unlinked: p.get('unlinked') === '1',
    q: p.get('q') ?? '',
    focus: p.get('focus') ?? '',
    depth: p.get('depth') === '1' ? 1 : 2,
    view: p.get('view') === 'list' ? 'list' : 'map',
  }
}

export function toGraphSearchParams(s: GraphState): URLSearchParams {
  const p = new URLSearchParams()
  if (!same(s.spaces, SPACES)) p.set('spaces', s.spaces.join(','))
  if (!same(s.kinds, EDGE_KINDS)) p.set('kinds', s.kinds.join(','))
  if (!same(s.lifecycle, DEFAULT_LIFECYCLE)) p.set('lifecycle', s.lifecycle.join(','))
  if (s.superseded) p.set('superseded', '1')
  if (s.unlinked) p.set('unlinked', '1')
  if (s.q) p.set('q', s.q)
  if (s.focus) {
    p.set('focus', s.focus)
    if (s.depth !== 2) p.set('depth', String(s.depth))
  }
  if (s.view === 'list') p.set('view', 'list')
  return p
}

/**
 * What the request carries: only the non-default filters (text and view are client-side). "Unlinked only"
 * is a server filter of the whole-project map; the server refuses it with `focus`, so a neighbourhood drops it.
 */
export function toGraphParams(s: GraphState): GraphParams {
  const out: GraphParams = {}
  if (!same(s.spaces, SPACES)) out.spaces = s.spaces
  if (!same(s.kinds, EDGE_KINDS)) out.kinds = s.kinds
  if (!same(s.lifecycle, DEFAULT_LIFECYCLE)) out.lifecycle = s.lifecycle
  if (s.superseded) out.include_superseded = true
  if (s.unlinked && !s.focus) out.unlinked = true
  if (s.focus) {
    out.focus = s.focus
    out.depth = s.depth
  }
  return out
}

/** Toggle `value` in `list` keeping canonical order; the last remaining value cannot be removed. */
export function toggle<T extends string>(list: readonly T[], value: T, all: readonly T[]): T[] {
  if (list.includes(value)) return list.length > 1 ? list.filter((v) => v !== value) : [...list]
  return all.filter((v) => v === value || list.includes(v))
}

/** True when a server-side filter differs from the default (the empty state then says "change the filters"). */
export const isFiltered = (s: GraphState) =>
  Object.keys(toGraphParams(s)).some((k) => k !== 'focus' && k !== 'depth')
