/**
 * Map filters (all in the URL): spaces, link kinds, lifecycle, superseded, unlinked only (whole project only),
 * the text highlight, and in focus mode the depth and a way back to the whole project. Controlled like the list FilterBar: every
 * change is an update of the newest state, so two quick clicks keep both.
 */
import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { EDGE_KINDS, GRAPH_LIFECYCLES, type GraphLifecycle } from '../../api/types'
import { Button, Checkbox, Input, Select } from '../../ui'
import { SPACE_TITLE, SPACES, useDebounced } from '../item/common'
import { type GraphState, toggle } from './graphState'
import { KIND_LABEL } from './graphStyle'

const LIFECYCLE_TEXT: Record<GraphLifecycle, string> = {
  active: 'Active',
  stale: 'Stale',
  archived: 'Archived',
}

export function GraphFilters({
  state,
  onChange,
  onReset,
}: {
  state: GraphState
  onChange: (change: (s: GraphState) => GraphState) => void
  onReset?: () => void
}) {
  const set = (patch: Partial<GraphState>) => onChange((s) => ({ ...s, ...patch }))
  const [q, setQ] = useState(state.q)
  const debounced = useDebounced(q, 250)
  // the URL changed elsewhere (back button, reset): show it
  useEffect(() => setQ(state.q), [state.q])
  // biome-ignore lint/correctness/useExhaustiveDependencies: write only when the typed text settles
  useEffect(() => {
    if (debounced !== state.q) onChange((s) => ({ ...s, q: debounced }))
  }, [debounced])

  const group = <T extends string>(
    legend: string,
    all: readonly T[],
    picked: readonly T[],
    label: (v: T) => string,
    apply: (next: T[]) => void,
  ) => (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {all.map((v) => {
          const on = picked.includes(v)
          return (
            <Checkbox
              key={v}
              label={label(v)}
              checked={on}
              // at least one value stays selected
              disabled={on && picked.length === 1}
              onChange={() => apply(toggle(picked, v, all))}
            />
          )
        })}
      </div>
    </fieldset>
  )

  return (
    // biome-ignore lint/a11y/useSemanticElements: <search> is not in the JSX types; role="search" is equivalent
    <div
      role="search"
      aria-label="Filter the map"
      className="mb-4 space-y-3 rounded-md border border-border bg-surface p-3"
    >
      {state.focus && (
        <div className="flex flex-wrap items-end gap-3 border-b border-border pb-3">
          <p className="text-sm">
            Neighbourhood of <span className="font-mono">{state.focus}</span>
          </p>
          <Select
            label="Depth"
            className="w-32"
            value={String(state.depth)}
            onChange={(e) => set({ depth: e.target.value === '1' ? 1 : 2 })}
            options={[
              { value: '1', label: '1 hop' },
              { value: '2', label: '2 hops' },
            ]}
          />
          <Button size="sm" onClick={() => set({ focus: '', depth: 2 })}>
            Show whole project
          </Button>
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {group(
          'Spaces',
          SPACES,
          state.spaces,
          (s) => SPACE_TITLE[s],
          (spaces) => set({ spaces }),
        )}
        {group(
          'Lifecycle',
          GRAPH_LIFECYCLES,
          state.lifecycle,
          (l) => LIFECYCLE_TEXT[l],
          (lifecycle) => set({ lifecycle }),
        )}
      </div>
      {group(
        'Link kinds',
        EDGE_KINDS,
        state.kinds,
        (k) => KIND_LABEL[k],
        (kinds) => set({ kinds }),
      )}
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Input
          label="Highlight"
          type="search"
          placeholder="handle, title or tag"
          className="w-full sm:w-64"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Checkbox
          label="Unlinked only"
          // a neighbourhood is linked by definition; the server refuses unlinked with focus
          hint={state.focus ? 'Whole project only' : undefined}
          checked={state.unlinked && !state.focus}
          disabled={!!state.focus}
          onChange={(e) => set({ unlinked: e.target.checked })}
        />
        <Checkbox
          label="Include superseded and deprecated"
          checked={state.superseded}
          onChange={(e) => set({ superseded: e.target.checked })}
        />
        {onReset && (
          <Button
            size="sm"
            variant="ghost"
            icon={<X className="size-4" aria-hidden="true" />}
            onClick={onReset}
          >
            Reset filters
          </Button>
        )}
      </div>
    </div>
  )
}
