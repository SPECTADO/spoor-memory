/**
 * `/projects/:slug/{memories,decisions,docs}` (and `/shared/…`): one component for the three spaces (the space
 * is the last path segment). Filters live in the URL (lib/listFilters.ts), cursor pagination through a "Load
 * more" button, quick actions for editors.
 */
import { Plus } from 'lucide-react'
import { useCallback } from 'react'
import { useLocation } from 'react-router'
import { flattenPages, useItems } from '../api/hooks'
import type { Space } from '../api/types'
import { FilterBar } from '../components/browse/FilterBar'
import { ItemTable } from '../components/browse/ItemTable'
import { useCan } from '../components/RequireRole'
import { type ListFilters, parseFilters, toApiFilters, toSearchParams, withTag } from '../lib/listFilters'
import { projectPath, useProjectSlug } from '../lib/paths'
import { useSearchParamsState } from '../lib/useSearchParamsState'
import { Button, ButtonLink, EmptyState, ErrorState, NotFound, PageHeader, SkeletonRows } from '../ui'

const SPACES: Space[] = ['memories', 'decisions', 'docs']
const TITLES: Record<Space, string> = { memories: 'Memories', decisions: 'Decisions', docs: 'Docs' }
const NEW_LABEL: Record<Space, string> = {
  memories: 'New memory',
  decisions: 'New decision',
  docs: 'New doc',
}
const HOW_ITEMS_GET_HERE: Record<Space, string> = {
  memories: 'Agents add memories with spoor_remember. You can add one yourself.',
  decisions: 'Decisions come from spoor_decide, ADR files in the repo, or here.',
  docs: 'Docs are pushed from the repo or written here.',
}

export function SpaceListPage() {
  const { pathname } = useLocation()
  const last = pathname.replace(/\/+$/, '').split('/').pop() as Space
  if (!SPACES.includes(last)) return <NotFound />
  return <SpaceList key={last} space={last} />
}

function SpaceList({ space }: { space: Space }) {
  const slug = useProjectSlug()
  const [params, updateParams] = useSearchParamsState()
  const filters = parseFilters(space, params)
  const items = useItems(slug, space, toApiFilters(filters))
  const canWrite = useCan('editor').allowed

  // changes are applied to the newest filters, not the rendered ones (see useSearchParamsState)
  const apply = useCallback(
    (change: (current: ListFilters) => ListFilters) =>
      updateParams((prev) => toSearchParams(change(parseFilters(space, prev)))),
    [space, updateParams],
  )

  const rows = flattenPages(items.data)
  const filtered = params.size > 0

  return (
    <section>
      <PageHeader
        title={TITLES[space]}
        actions={
          canWrite && (
            <ButtonLink variant="primary" to={projectPath(slug, `${space}/new`)}>
              <Plus className="size-4" aria-hidden="true" />
              {NEW_LABEL[space]}
            </ButtonLink>
          )
        }
      />
      <FilterBar space={space} filters={filters} onChange={apply} />
      {items.isPending ? (
        <SkeletonRows rows={6} />
      ) : items.isError ? (
        <ErrorState error={items.error} onRetry={() => items.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title={filtered ? 'No items match these filters' : `No ${space} yet`}>
          {filtered ? 'Change or clear the filters.' : HOW_ITEMS_GET_HERE[space]}
        </EmptyState>
      ) : (
        <>
          <ItemTable
            slug={slug}
            space={space}
            items={rows}
            canWrite={canWrite}
            onTagClick={(t) => apply((f) => withTag(f, t))}
          />
          {items.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button loading={items.isFetchingNextPage} onClick={() => items.fetchNextPage()}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
