/**
 * `/projects/:slug/{memories,decisions,docs}` (and `/shared/…`): one component for the four spaces (the space
 * is the last path segment). Filters live in the URL (lib/listFilters.ts), cursor pagination through a "Load
 * more" button, quick actions for editors.
 */

import { isHumanOnlySpace } from '@spoor/shared'
import { Plus } from 'lucide-react'
import { useCallback } from 'react'
import { Link, useLocation } from 'react-router'
import { flattenPages, useItems } from '../api/hooks'
import type { Space } from '../api/types'
import { FilterBar } from '../components/browse/FilterBar'
import { ItemTable } from '../components/browse/ItemTable'
import { useCan } from '../components/RequireRole'
import { type ListFilters, parseFilters, toApiFilters, toSearchParams, withTag } from '../lib/listFilters'
import { isShared, projectPath, useProjectSlug } from '../lib/paths'
import { useSearchParamsState } from '../lib/useSearchParamsState'
import { Button, ButtonLink, EmptyState, ErrorState, NotFound, PageHeader, SkeletonRows } from '../ui'

const SPACES: Space[] = ['memories', 'decisions', 'docs', 'library']
const TITLES: Record<Space, string> = {
  memories: 'Memories',
  decisions: 'Decisions',
  docs: 'Docs',
  library: 'Library',
}
const NEW_LABEL: Record<Space, string> = {
  memories: 'New memory',
  decisions: 'New decision',
  docs: 'New doc',
  library: 'New page',
}
const HOW_ITEMS_GET_HERE: Record<Space, string> = {
  memories: 'Agents add memories with spoor_remember. You can add one yourself.',
  decisions: 'Decisions come from spoor_decide, ADR files in the repo, or here.',
  docs: 'Docs are pushed from the repo or written here.',
  library:
    'Write the guides agents must follow, such as a graphics guide, architecture guide or conventions. Agents see every page in their digest and can read it, never change it.',
}

const LIBRARY_SUBTITLE =
  'Guides and conventions that agents read and follow. Only people with the library right can change them.'

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
  const canWrite = useCan(isHumanOnlySpace(space) ? 'library' : 'editor').allowed

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
        description={space === 'library' ? LIBRARY_SUBTITLE : undefined}
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
        <EmptyState
          title={
            filtered
              ? 'No items match these filters'
              : space === 'library'
                ? 'No library pages yet'
                : `No ${space} yet`
          }
          action={
            !filtered && space === 'library' && canWrite ? (
              <ButtonLink variant="primary" to={projectPath(slug, 'library/new')}>
                <Plus className="size-4" aria-hidden="true" />
                {NEW_LABEL[space]}
              </ButtonLink>
            ) : undefined
          }
        >
          {filtered
            ? 'Change or clear the filters.'
            : space === 'library' && !canWrite
              ? 'A project admin or a library editor can add pages here.'
              : HOW_ITEMS_GET_HERE[space]}
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
      {space === 'library' && !isShared(slug) && (
        <p className="mt-6 text-sm text-muted">
          Org-wide library pages live in{' '}
          <Link to="/shared/library" className="text-accent underline">
            Shared → Library
          </Link>{' '}
          and appear to agents as S:L…
        </p>
      )}
    </section>
  )
}
