/** What the shapes, outlines and line styles of the map mean (each entry is text plus a drawn sample). */
import type { ReactNode } from 'react'
import { EDGE_KINDS, type Space } from '../../api/types'
import { SPACE_TITLE, SPACES } from '../item/common'
import { EDGE_STYLE, KIND_LABEL, SPACE_STYLE, shapePath } from './graphStyle'

const SHAPE_TEXT: Record<Space, string> = {
  memories: 'circle',
  decisions: 'diamond',
  docs: 'square',
  library: 'hexagon',
}

function Swatch({ children }: { children: ReactNode }) {
  return (
    <svg width="28" height="16" viewBox="-14 -8 28 16" aria-hidden="true" className="shrink-0">
      {children}
    </svg>
  )
}

export function GraphLegend() {
  const item = (key: string, sample: ReactNode, text: string) => (
    <li key={key} className="flex items-center gap-2">
      <Swatch>{sample}</Swatch>
      <span>{text}</span>
    </li>
  )
  return (
    <details className="mt-3 rounded-md border border-border p-3 text-sm" open>
      <summary className="cursor-pointer font-medium">Legend</summary>
      <div className="mt-2 grid gap-4 sm:grid-cols-3">
        <div>
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Items</h3>
          <ul className="mt-1 space-y-1">
            {SPACES.map((s) =>
              item(
                s,
                <path
                  d={shapePath(SPACE_STYLE[s].shape, 6)}
                  fill={SPACE_STYLE[s].fill}
                  stroke={SPACE_STYLE[s].stroke}
                  strokeWidth={1.5}
                />,
                `${SPACE_TITLE[s]} (${SHAPE_TEXT[s]})`,
              ),
            )}
          </ul>
        </div>
        <div>
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Links</h3>
          <ul className="mt-1 space-y-1">
            {EDGE_KINDS.map((k) => {
              const s = EDGE_STYLE[k]
              return item(
                k,
                <line
                  x1={-12}
                  y1={0}
                  x2={12}
                  y2={0}
                  stroke={s.stroke}
                  strokeWidth={s.width + 0.5}
                  strokeDasharray={s.dash}
                  opacity={s.opacity}
                />,
                `${KIND_LABEL[k]}: ${s.pattern}`,
              )
            })}
          </ul>
        </div>
        <div>
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">States</h3>
          <ul className="mt-1 space-y-1">
            {item(
              'ghost',
              <path
                d={shapePath('circle', 6)}
                fill="var(--c-bg)"
                stroke="var(--c-accent)"
                strokeDasharray="3 2"
              />,
              'Dashed outline: outside the filters or another space (shared)',
            )}
            {item(
              'dangling',
              <path
                d={shapePath('circle', 6)}
                fill="var(--c-bg)"
                stroke="var(--c-muted)"
                strokeDasharray="2 2"
              />,
              'Hollow, labelled [[ref]]: wikilink to an item that does not exist',
            )}
            {item(
              'pinned',
              <>
                <circle r={7} fill="none" stroke="var(--c-accent)" strokeWidth={1.5} />
                <circle r={5} fill="var(--c-accent-soft)" stroke="var(--c-accent)" />
              </>,
              'Outer ring: pinned',
            )}
            {item(
              'faded',
              <circle r={5} fill="var(--c-accent-soft)" stroke="var(--c-accent)" opacity={0.5} />,
              'Faded: stale or archived',
            )}
            {item(
              'agent',
              <text x={0} y={4} textAnchor="middle" fontSize={11} fill="var(--c-fg)">
                m1~
              </text>,
              '~ after the handle: written by an agent, not yet reviewed',
            )}
            {item(
              'size',
              <>
                <circle cx={-6} r={3} fill="var(--c-surface-2)" stroke="var(--c-fg)" />
                <circle cx={5} r={6} fill="var(--c-surface-2)" stroke="var(--c-fg)" />
              </>,
              'Bigger: more links',
            )}
          </ul>
        </div>
      </div>
    </details>
  )
}
