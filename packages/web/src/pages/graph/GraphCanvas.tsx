/**
 * The map itself: an SVG of the laid-out view. Pan by dragging the background (or the arrow keys on the
 * focused canvas), zoom with the wheel around the pointer (or +, -, 0 and the buttons). Every node is a
 * focusable button (Enter or Space opens its card); edges are drawn for the eye only, their text lives in the
 * card and the list view. Panning and zooming only change the view box: the node and edge layers are memoised
 * and re-render only for a new layout, selection or highlight.
 */
import { Maximize2, Minus, Plus } from 'lucide-react'
import {
  type KeyboardEvent,
  memo,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { EdgeKind } from '../../api/types'
import {
  type Bounds,
  edgeSegment,
  type GraphView,
  type Layout,
  type Point,
  type ViewNode,
  wheelFactor,
  zoomBox,
} from '../../lib/graphLayout'
import { IconButton } from '../../ui'
import { handleText } from '../item/common'
import { describeNode, EDGE_STYLE, SPACE_STYLE, shapePath } from './graphStyle'

/** Labels are drawn for every node up to this many nodes; above it only for selected, focused and matching ones. */
const LABEL_LIMIT = 150

export function GraphCanvas({
  slug,
  view,
  layout,
  radius,
  selected,
  focusId,
  matches,
  onSelect,
}: {
  slug: string
  view: GraphView
  layout: Layout
  radius: (id: string) => number
  selected: string | null
  focusId: string | null
  /** Ids matching the text filter (empty: no filter, nothing dimmed). */
  matches: Set<string> | null
  onSelect: (id: string | null) => void
}) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const svgRef = useRef<SVGSVGElement>(null)
  const [box, setBox] = useState<Bounds>(layout.bounds)
  const boxRef = useRef(box)
  boxRef.current = box
  const drag = useRef<{ x: number; y: number; box: Bounds; moved: boolean } | null>(null)

  // a new layout (other data or filters) starts fitted
  useEffect(() => setBox(layout.bounds), [layout])

  const minW = Math.max(40, layout.bounds.width / 25)
  const maxW = layout.bounds.width * 4

  const scale = () => svgRef.current?.getScreenCTM?.()?.a || 1

  // the wheel needs a non-passive listener to keep the page from scrolling
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const ctm = svg.getScreenCTM?.()
      const b = boxRef.current
      const p = ctm ? new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse()) : centre(b)
      setBox(zoomBox(b, wheelFactor(e.deltaY, e.deltaMode), p, minW, maxW))
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [minW, maxW])

  const zoom = (factor: number) => setBox((b) => zoomBox(b, factor, centre(b), minW, maxW))
  /** A node got keyboard focus outside the visible box: centre the box on it. */
  const reveal = useCallback(
    (p: Point) =>
      setBox((b) =>
        p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
          ? b
          : { ...b, x: p.x - b.width / 2, y: p.y - b.height / 2 },
      ),
    [],
  )
  const pan = (fx: number, fy: number) =>
    setBox((b) => ({ ...b, x: b.x + b.width * fx, y: b.y + b.height * fy }))

  // on the whole svg, not a background rect: the view box keeps its aspect ratio, so the drawing does not
  // always fill the element and the letterbox must pan too; a press on a node is its own click
  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || (e.target as Element).closest('[data-node-id]')) return
    drag.current = { x: e.clientX, y: e.clientY, box, moved: false }
    svgRef.current?.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    const k = scale()
    setBox({ ...d.box, x: d.box.x - dx / k, y: d.box.y - dy / k })
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (d && !d.moved) onSelect(null)
  }

  // keys bubble up from the focused node or zoom button
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const keys: Record<string, () => void> = {
      ArrowLeft: () => pan(-0.1, 0),
      ArrowRight: () => pan(0.1, 0),
      ArrowUp: () => pan(0, -0.1),
      ArrowDown: () => pan(0, 0.1),
      '+': () => zoom(0.8),
      '=': () => zoom(0.8),
      '-': () => zoom(1.25),
      '0': () => setBox(layout.bounds),
    }
    const run = keys[e.key]
    if (run) {
      e.preventDefault()
      run()
    }
  }

  const kinds = useMemo(() => [...new Set(view.edges.map((e) => e.kind))], [view])
  const marker = useCallback((k: EdgeKind) => `${uid}-arrow-${k}`, [uid])

  return (
    <figure className="relative rounded-md border border-border bg-bg" onKeyDown={onKeyDown}>
      <figcaption className="sr-only">
        Map of {view.nodes.length} nodes and {view.edges.length} links. Tab to an item and press Enter for its
        details. Arrow keys pan, plus and minus zoom, 0 fits the map.
      </figcaption>
      <div className="absolute top-2 right-2 z-10 flex gap-1 rounded-md border border-border bg-surface p-0.5">
        <IconButton
          label="Zoom in"
          icon={<Plus className="size-4" aria-hidden="true" />}
          onClick={() => zoom(0.8)}
        />
        <IconButton
          label="Zoom out"
          icon={<Minus className="size-4" aria-hidden="true" />}
          onClick={() => zoom(1.25)}
        />
        <IconButton
          label="Fit to screen"
          icon={<Maximize2 className="size-4" aria-hidden="true" />}
          onClick={() => setBox(layout.bounds)}
        />
      </div>
      <svg
        ref={svgRef}
        viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
        className="block h-[65vh] min-h-80 w-full cursor-grab touch-none select-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null
        }}
      >
        <title>Project map</title>
        <defs>
          {kinds.map((k) => (
            <marker
              key={k}
              id={marker(k)}
              viewBox="0 0 10 10"
              refX="10"
              refY="5"
              markerUnits="userSpaceOnUse"
              markerWidth="8"
              markerHeight="8"
              orient="auto-start-reverse"
            >
              <path d="M0,0L10,5L0,10Z" fill={EDGE_STYLE[k].stroke} />
            </marker>
          ))}
        </defs>
        <EdgeLayer
          view={view}
          layout={layout}
          radius={radius}
          selected={selected}
          matches={matches}
          marker={marker}
        />
        <NodeLayer
          slug={slug}
          view={view}
          layout={layout}
          radius={radius}
          selected={selected}
          focusId={focusId}
          matches={matches}
          onSelect={onSelect}
          onFocus={reveal}
        />
      </svg>
    </figure>
  )
}

const centre = (b: Bounds): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

const dimmedBy = (matches: Set<string> | null, id: string) => matches !== null && !matches.has(id)

const EdgeLayer = memo(function EdgeLayer({
  view,
  layout,
  radius,
  selected,
  matches,
  marker,
}: {
  view: GraphView
  layout: Layout
  radius: (id: string) => number
  selected: string | null
  matches: Set<string> | null
  marker: (k: EdgeKind) => string
}) {
  return (
    <g>
      {view.edges.map((e) => {
        const a = layout.positions.get(e.src)
        const b = layout.positions.get(e.dst)
        if (!a || !b) return null
        const s = EDGE_STYLE[e.kind]
        const seg = edgeSegment(a, b, radius(e.src), radius(e.dst), { start: s.both ? 1 : 0, end: 1 })
        const near = selected !== null && (e.src === selected || e.dst === selected)
        const faint = matches !== null && dimmedBy(matches, e.src) && dimmedBy(matches, e.dst)
        return (
          <line
            key={e.id}
            data-edge-kind={e.kind}
            data-edge={`${e.src}>${e.dst}`}
            {...seg}
            stroke={s.stroke}
            strokeWidth={s.width + (near ? 1 : 0)}
            strokeDasharray={s.dash}
            strokeLinecap={e.kind === 'drafted_from' ? 'round' : undefined}
            opacity={faint ? 0.15 : (s.opacity ?? 0.9)}
            markerEnd={`url(#${marker(e.kind)})`}
            markerStart={s.both ? `url(#${marker(e.kind)})` : undefined}
          />
        )
      })}
    </g>
  )
})

const NodeLayer = memo(function NodeLayer({
  slug,
  view,
  layout,
  radius,
  selected,
  focusId,
  matches,
  onSelect,
  onFocus,
}: {
  slug: string
  view: GraphView
  layout: Layout
  radius: (id: string) => number
  selected: string | null
  focusId: string | null
  matches: Set<string> | null
  onSelect: (id: string) => void
  onFocus: (p: Point) => void
}) {
  const showAllLabels = view.nodes.length <= LABEL_LIMIT
  return (
    <g>
      {view.nodes.map((n) => {
        const p = layout.positions.get(n.id)
        if (!p) return null
        const match = matches?.has(n.id) ?? false
        return (
          <NodeMark
            key={n.id}
            slug={slug}
            v={n}
            p={p}
            r={radius(n.id)}
            selected={n.id === selected}
            focus={n.id === focusId}
            match={match}
            dim={dimmedBy(matches, n.id)}
            label={showAllLabels || n.id === selected || n.id === focusId || match}
            onSelect={onSelect}
            onFocus={onFocus}
          />
        )
      })}
    </g>
  )
})

const short = (n: ViewNode) => (n.node ? handleText(n.node) : `[[${n.ref}]]`)

function NodeMark({
  slug,
  v,
  p,
  r,
  selected,
  focus,
  match,
  dim,
  label,
  onSelect,
  onFocus,
}: {
  slug: string
  v: ViewNode
  p: Point
  r: number
  selected: boolean
  focus: boolean
  match: boolean
  dim: boolean
  label: boolean
  onSelect: (id: string) => void
  onFocus: (p: Point) => void
}) {
  const n = v.node
  const style = n ? SPACE_STYLE[n.space] : null
  const life = n?.lifecycle ?? 'active'
  const opacity = dim ? 0.25 : life === 'archived' ? 0.45 : life === 'stale' ? 0.65 : 1
  const text = short(v)
  const desc = [describeNode(v, slug), focus && 'focus', match && 'matches the text filter']
    .filter(Boolean)
    .join(', ')
  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
    <g
      role="button"
      tabIndex={0}
      aria-label={desc}
      aria-pressed={selected}
      data-node-id={v.id}
      transform={`translate(${p.x},${p.y})`}
      opacity={opacity}
      className="cursor-pointer focus:outline-none [&:focus-visible>.ring]:stroke-[var(--c-focus)]"
      onClick={() => onSelect(v.id)}
      onFocus={() => onFocus(p)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(v.id)
        }
      }}
    >
      <title>{desc}</title>
      <circle
        className="ring"
        r={r + 4}
        fill="none"
        stroke={selected || focus ? 'var(--c-focus)' : 'transparent'}
        strokeWidth={2}
      />
      {n?.pinned && <circle r={r + 2} fill="none" stroke="var(--c-accent)" strokeWidth={1.5} />}
      {style ? (
        <path
          d={shapePath(style.shape, r)}
          fill={v.ghost ? 'var(--c-bg)' : style.fill}
          stroke={match ? 'var(--c-fg)' : style.stroke}
          strokeWidth={match ? 2.5 : 1.5}
          strokeDasharray={v.ghost ? '3 2' : undefined}
        />
      ) : (
        <path
          d={shapePath('circle', r)}
          fill="var(--c-bg)"
          stroke={match ? 'var(--c-fg)' : 'var(--c-muted)'}
          strokeWidth={match ? 2.5 : 1.25}
          strokeDasharray="2 2"
        />
      )}
      {label && (
        <text
          x={r + 4}
          y={3.5}
          fontSize={10}
          fontWeight={selected || focus || match ? 600 : 400}
          fill={v.node ? 'var(--c-fg)' : 'var(--c-muted)'}
          stroke="var(--c-bg)"
          strokeWidth={3}
          paintOrder="stroke"
          className="pointer-events-none"
        >
          {text}
        </text>
      )}
    </g>
  )
}
