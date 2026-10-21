/**
 * `/projects/:slug/graph` and `/shared/graph`: the project map (ADR-0021). The whole project by default,
 * `?focus=<handle>&depth=1|2` for one item's neighbourhood. Filters, the text highlight, the selected view
 * (map or list) all live in the URL (graphState.ts); the layout is computed in the browser (lib/graphLayout.ts).
 * "Unlinked only" is a server filter (`unlinked=true`, whole project only). Clicking a node opens its side card;
 * the selection belongs to one project and is dropped when the slug changes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useGraph } from '../../api/hooks'
import { buildView, layoutGraph, matchesText, nodeRadius } from '../../lib/graphLayout'
import { useProjectSlug } from '../../lib/paths'
import { useSearchParamsState } from '../../lib/useSearchParamsState'
import { Alert, Button, cx, EmptyState, ErrorState, PageHeader, SkeletonRows } from '../../ui'
import { GraphCanvas } from './GraphCanvas'
import { GraphFilters } from './GraphFilters'
import { GraphLegend } from './GraphLegend'
import { GraphList } from './GraphList'
import {
  type GraphState,
  type GraphViewMode,
  isFiltered,
  parseGraphState,
  toGraphParams,
  toGraphSearchParams,
} from './graphState'
import { NodeCard } from './NodeCard'

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`

export function GraphPage() {
  const slug = useProjectSlug()
  const [params, updateParams] = useSearchParamsState()
  const state = parseGraphState(params)
  const graph = useGraph(slug, toGraphParams(state))
  const [selected, setSelected] = useState<string | null>(null)
  // another project: drop the card (adjusted during render, so no frame shows the old selection)
  const [selectedSlug, setSelectedSlug] = useState(slug)
  if (selectedSlug !== slug) {
    setSelectedSlug(slug)
    setSelected(null)
  }

  // changes apply to the newest URL state, not the rendered one (see useSearchParamsState)
  const apply = useCallback(
    (change: (s: GraphState) => GraphState) =>
      updateParams((prev) => toGraphSearchParams(change(parseGraphState(prev)))),
    [updateParams],
  )

  const view = useMemo(() => (graph.data ? buildView(graph.data) : null), [graph.data])
  const radius = useMemo(() => {
    const max = Math.max(0, ...(view?.nodes.map((n) => n.degree) ?? []))
    const r = new Map(view?.nodes.map((n) => [n.id, nodeRadius(n.degree, max)]))
    return (id: string) => r.get(id) ?? 6
  }, [view])
  const layout = useMemo(
    () => (view ? layoutGraph(view.nodes, view.edges, { radius }) : null),
    [view, radius],
  )
  const q = state.q.trim()
  const matches = useMemo(
    () => (view && q ? new Set(view.nodes.filter((n) => matchesText(n, q)).map((n) => n.id)) : null),
    [view, q],
  )
  const focusId = useMemo(() => {
    if (!state.focus || !view) return null
    const f = state.focus.toLowerCase()
    return (
      view.nodes.find((n) => n.node && (n.node.handle.toLowerCase() === f || n.node.id === state.focus))
        ?.id ?? null
    )
  }, [view, state.focus])

  // opening a neighbourhood opens the focused item's card
  useEffect(() => {
    if (focusId) setSelected(focusId)
  }, [focusId])

  const selectedNode = (selected && view?.nodes.find((n) => n.id === selected)) || null

  const close = () => {
    const id = selected
    setSelected(null)
    // back to the node the card belonged to
    requestAnimationFrame(() => {
      for (const el of document.querySelectorAll<SVGGElement>('[data-node-id]')) {
        if (el.dataset.nodeId === id) el.focus()
      }
    })
  }

  const setView = (mode: GraphViewMode) => apply((s) => ({ ...s, view: mode }))
  const filtered = isFiltered(state)
  const unlinkedMode = state.unlinked && !state.focus
  const itemCount = view?.nodes.filter((n) => n.node).length ?? 0
  const meta = graph.data?.meta

  return (
    <section>
      <PageHeader
        title="Map"
        description="Items and the links between them. Select an item for its links and suggested links."
        actions={
          // biome-ignore lint/a11y/useSemanticElements: a toggle pair, not a form fieldset
          <div role="group" aria-label="View" className="flex gap-1">
            {(['map', 'list'] as const).map((m) => (
              <Button
                key={m}
                size="sm"
                variant={state.view === m ? 'primary' : 'secondary'}
                aria-pressed={state.view === m}
                onClick={() => setView(m)}
              >
                {m === 'map' ? 'Map' : 'List'}
              </Button>
            ))}
          </div>
        }
      />
      <GraphFilters
        state={state}
        onChange={apply}
        onReset={
          filtered || q
            ? () =>
                apply((s) => ({
                  ...parseGraphState(new URLSearchParams()),
                  focus: s.focus,
                  depth: s.depth,
                  view: s.view,
                }))
            : undefined
        }
      />
      {graph.isPending ? (
        <SkeletonRows rows={6} label="Loading the map" />
      ) : graph.isError ? (
        <ErrorState error={graph.error} onRetry={() => graph.refetch()} />
      ) : !view || !layout ? null : (
        <>
          <p className="mb-2 text-sm text-muted">
            {plural(itemCount, 'item')} · {plural(view.edges.length, 'link')} ·{' '}
            {plural(meta?.unlinked_count ?? 0, 'item')} without links ·{' '}
            {plural(meta?.dangling_count ?? 0, 'dangling reference')}
            {matches && <> · {plural(matches.size, 'match', 'matches')}</>}
            {graph.isFetching && <> · updating…</>}
          </p>
          {meta?.truncated && (
            <Alert tone="warning" title="The map is cut short" className="mb-3">
              Showing {meta.node_cap.toLocaleString('en-GB')} of {meta.total_nodes.toLocaleString('en-GB')}{' '}
              items. Narrow the spaces, link kinds or lifecycle, or focus on one item to see the rest.
            </Alert>
          )}
          {view.nodes.length === 0 ? (
            <EmptyState
              title={
                // the server counts unlinked items before the cap; a cut-short reply proves nothing
                unlinkedMode && !meta?.truncated
                  ? 'No items without links'
                  : filtered
                    ? 'No items match these filters'
                    : 'Nothing to map yet'
              }
            >
              {unlinkedMode && !meta?.truncated
                ? 'Every item these filters keep has a link. Turn off "Unlinked only" to see the whole map.'
                : filtered
                  ? 'Change or reset the filters.'
                  : 'Items appear here once people or agents write them; links come from relations, supersedes, drafts and [[wikilinks]].'}
            </EmptyState>
          ) : (
            <div className={cx('grid gap-4', selectedNode && 'lg:grid-cols-[minmax(0,1fr)_20rem]')}>
              <div className="min-w-0">
                {state.view === 'map' ? (
                  <>
                    <button
                      type="button"
                      className="sr-only focus:not-sr-only focus:mb-2 focus:inline-block focus:text-sm focus:text-accent focus:underline"
                      onClick={() => setView('list')}
                    >
                      Show the map as a list
                    </button>
                    <GraphCanvas
                      slug={slug}
                      view={view}
                      layout={layout}
                      radius={radius}
                      selected={selectedNode?.id ?? null}
                      focusId={focusId}
                      matches={matches}
                      onSelect={setSelected}
                    />
                    <GraphLegend />
                  </>
                ) : (
                  <GraphList slug={slug} view={view} matches={matches} onSelect={setSelected} />
                )}
              </div>
              {selectedNode && (
                <NodeCard
                  slug={slug}
                  v={selectedNode}
                  view={view}
                  onClose={close}
                  onSelect={setSelected}
                  onFocus={(handle) => apply((s) => ({ ...s, focus: handle, depth: 2, unlinked: false }))}
                />
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
}
