import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode } from '../api/types'
import {
  buildView,
  danglingId,
  defaultTicks,
  edgeSegment,
  layoutGraph,
  matchesText,
  nodeRadius,
  wheelFactor,
  zoomBox,
} from './graphLayout'

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    handle: id,
    project: 'acme',
    space: 'memories',
    title: `Title of ${id}`,
    type: 'fact',
    status: 'active',
    lifecycle: 'active',
    confidence: null,
    pinned: false,
    provenance: 'human',
    tags: [],
    updated_at: '2026-10-20T00:00:00Z',
    last_verified_at: '2026-10-20T00:00:00Z',
    degree_in: 0,
    degree_out: 0,
    ghost: false,
    ...over,
  }
}
const edge = (id: string, src: string, dst: string | null, over: Partial<GraphEdge> = {}): GraphEdge => ({
  id,
  kind: 'refines',
  src,
  dst,
  editable: true,
  ...over,
})

describe('buildView', () => {
  it('adds one ghost per distinct dangling ref and keeps edges to it', () => {
    const view = buildView({
      nodes: [node('a', { degree_out: 3 }), node('b', { degree_out: 1 })],
      edges: [
        edge('e1', 'a', null, { kind: 'wikilink', dst_ref: 'auth-flow', editable: false }),
        edge('e2', 'b', null, { kind: 'wikilink', dst_ref: 'auth-flow', editable: false }),
        edge('e3', 'a', null, { kind: 'wikilink', dst_ref: 'other', editable: false }),
        edge('e4', 'a', 'b'),
      ],
    })
    expect(view.nodes.map((n) => n.id)).toEqual(['a', 'b', danglingId('auth-flow'), danglingId('other')])
    const ghost = view.nodes[2]
    expect(ghost).toMatchObject({ node: null, ref: 'auth-flow', ghost: true, degree: 2 })
    expect(view.edges.map((e) => [e.src, e.dst])).toEqual([
      ['a', 'ref:auth-flow'],
      ['b', 'ref:auth-flow'],
      ['a', 'ref:other'],
      ['a', 'b'],
    ])
    expect(view.nodes[0]?.degree).toBe(3)
  })

  it('drops edges whose end is not a node', () => {
    const view = buildView({ nodes: [node('a')], edges: [edge('e1', 'a', 'zz'), edge('e2', 'zz', 'a')] })
    expect(view.edges).toEqual([])
  })
})

describe('filters', () => {
  it('matches every word in handle, title, tags or the dangling ref, case-insensitively', () => {
    const [a] = buildView({
      nodes: [node('m12', { title: 'Tokens are hashed', tags: ['auth'] })],
      edges: [],
    }).nodes
    if (!a) throw new Error('no node')
    expect(matchesText(a, 'TOKENS')).toBe(true)
    expect(matchesText(a, 'm12 auth')).toBe(true)
    expect(matchesText(a, 'tokens redis')).toBe(false)
    expect(matchesText(a, '   ')).toBe(false)
    const ghost = { id: 'ref:x', node: null, ref: 'auth-flow', ghost: true, degree: 1 }
    expect(matchesText(ghost, 'flow')).toBe(true)
  })
})

describe('nodeRadius', () => {
  it('scales by the square root of the degree within 6..16', () => {
    expect(nodeRadius(0, 10)).toBe(6)
    expect(nodeRadius(3, 0)).toBe(6)
    expect(nodeRadius(10, 10)).toBe(16)
    expect(nodeRadius(50, 10)).toBe(16)
    const mid = nodeRadius(2, 8)
    expect(mid).toBeGreaterThan(6)
    expect(mid).toBeLessThan(16)
    expect(mid).toBe(11)
  })
})

describe('layoutGraph', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }))
  const edges = [
    { src: 'a', dst: 'b' },
    { src: 'b', dst: 'c' },
    { src: 'a', dst: 'missing' },
  ]

  it('is deterministic for the same input', () => {
    const one = layoutGraph(nodes, edges)
    const two = layoutGraph(nodes, edges)
    expect([...one.positions]).toEqual([...two.positions])
    expect(one.bounds).toEqual(two.bounds)
  })

  it('places every node at a finite point inside the bounds', () => {
    const { positions, bounds } = layoutGraph(nodes, edges, { padding: 10 })
    expect(positions.size).toBe(5)
    for (const p of positions.values()) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
      expect(p.x).toBeGreaterThanOrEqual(bounds.x)
      expect(p.x).toBeLessThanOrEqual(bounds.x + bounds.width)
      expect(p.y).toBeGreaterThanOrEqual(bounds.y)
      expect(p.y).toBeLessThanOrEqual(bounds.y + bounds.height)
    }
  })

  it('keeps linked nodes closer than unlinked ones', () => {
    const { positions } = layoutGraph(nodes, edges)
    const d = (x: string, y: string) => {
      const p = positions.get(x)
      const q = positions.get(y)
      if (!p || !q) throw new Error('missing')
      return Math.hypot(p.x - q.x, p.y - q.y)
    }
    // d and e have no link: the charge pushes them apart, the links hold a-b and b-c together
    expect(d('a', 'b')).toBeLessThan(d('d', 'e'))
    expect(d('b', 'c')).toBeLessThan(d('d', 'e'))
    expect(d('a', 'b')).toBeLessThan(120)
  })

  it('handles an empty graph and one node with a minimum box', () => {
    expect(layoutGraph([], []).bounds).toEqual({ x: -100, y: -100, width: 200, height: 200 })
    const one = layoutGraph([{ id: 'a' }], [])
    expect(one.positions.get('a')).toEqual({ x: 0, y: 0 })
    expect(one.bounds.width).toBe(200)
  })

  it('uses fewer ticks for big graphs', () => {
    expect(defaultTicks(10)).toBe(300)
    expect(defaultTicks(1500)).toBe(60)
    expect(defaultTicks(400)).toBe(150)
  })
})

describe('geometry', () => {
  it('trims an edge to the rims plus the arrow gap', () => {
    expect(edgeSegment({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 6, { end: 2 })).toEqual({
      x1: 10,
      y1: 0,
      x2: 92,
      y2: 0,
    })
    expect(edgeSegment({ x: 5, y: 5 }, { x: 5, y: 5 }, 10, 10)).toEqual({ x1: 5, y1: 5, x2: 5, y2: 5 })
  })

  it('zooms around a fixed point and clamps the width', () => {
    const box = { x: 0, y: 0, width: 100, height: 50 }
    expect(zoomBox(box, 0.5, { x: 50, y: 25 }, 10, 400)).toEqual({ x: 25, y: 12.5, width: 50, height: 25 })
    expect(zoomBox(box, 100, { x: 0, y: 0 }, 10, 400).width).toBe(400)
    expect(zoomBox(box, 0.001, { x: 0, y: 0 }, 10, 400).width).toBe(10)
  })

  it('normalises the wheel delta mode and clamps the zoom of one event', () => {
    expect(wheelFactor(0, 0)).toBe(1)
    expect(wheelFactor(100, 0)).toBeCloseTo(Math.exp(0.15))
    // Firefox line mode: 3 lines = 48 px, not 3 px
    expect(wheelFactor(3, 1)).toBeCloseTo(wheelFactor(48, 0))
    expect(wheelFactor(-3, 1)).toBeCloseTo(1 / wheelFactor(48, 0))
    // page mode: one page = 400 px; more than that and fast flicks stop at x2 / x0.5
    expect(wheelFactor(1, 2)).toBeCloseTo(Math.exp(0.6))
    expect(wheelFactor(3, 2)).toBe(2)
    expect(wheelFactor(-3, 2)).toBe(0.5)
    expect(wheelFactor(5000, 0)).toBe(2)
    expect(wheelFactor(-5000, 0)).toBe(0.5)
  })
})
