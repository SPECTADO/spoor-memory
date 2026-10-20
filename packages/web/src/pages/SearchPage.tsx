/**
 * `/projects/:slug/search?q=`: hybrid search (api.md §6). The query lives in the URL (250 ms debounce), previous
 * results stay visible while the next load. Filters: space, include inactive (archived, superseded, deprecated).
 * Stale and archived results carry a text badge; snippets are plain text.
 */
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useSearch } from '../api/hooks'
import type { SearchHit, Space } from '../api/types'
import { ItemBadges } from '../components/browse/ItemBadges'
import { useProjectSlug } from '../lib/paths'
import { useSearchParamsState } from '../lib/useSearchParamsState'
import {
  Alert,
  Badge,
  Checkbox,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Select,
  SkeletonRows,
} from '../ui'
import { summaryPath } from './item/common'

const SPACES: Space[] = ['memories', 'decisions', 'docs', 'library']
export const SEARCH_DEBOUNCE_MS = 250

export function SearchPage() {
  const slug = useProjectSlug()
  const [params, updateParams] = useSearchParamsState()
  const q = params.get('q') ?? ''
  const spaceParam = params.get('space') as Space | null
  const space = spaceParam && SPACES.includes(spaceParam) ? spaceParam : undefined
  const includeInactive = params.get('inactive') === '1'

  const [draft, setDraft] = useState(q)
  // follow the URL (the shell's search box navigates here with a new ?q=)
  useEffect(() => setDraft(q), [q])

  const update = useCallback(
    (patch: Record<string, string | null>) =>
      updateParams((prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(patch)) {
          if (v) next.set(k, v)
          else next.delete(k)
        }
        return next
      }),
    [updateParams],
  )

  useEffect(() => {
    const t = draft.trim()
    if (t === q.trim()) return
    const id = setTimeout(() => update({ q: t || null }), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [draft, q, update])

  const search = useSearch(slug, {
    q: q.trim(),
    ...(space ? { space } : {}),
    ...(includeInactive ? { include_inactive: true } : {}),
  })
  const hits = search.data?.items ?? []

  const submit = (e: FormEvent) => {
    e.preventDefault()
    update({ q: draft.trim() || null })
  }

  return (
    <section>
      <PageHeader
        title="Search"
        description="Keyword and meaning search across this project and shared knowledge."
      />
      <form onSubmit={submit} className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <Input
          className="flex-1"
          label="Query"
          type="search"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={500}
        />
        <Select
          label="Space"
          value={space ?? ''}
          onChange={(e) => update({ space: e.target.value || null })}
          options={[
            { value: '', label: 'All spaces' },
            { value: 'memories', label: 'Memories' },
            { value: 'decisions', label: 'Decisions' },
            { value: 'docs', label: 'Docs' },
            { value: 'library', label: 'Library' },
          ]}
        />
        <Checkbox
          className="pb-2"
          label="Include inactive"
          hint="Archived, superseded, deprecated"
          checked={includeInactive}
          onChange={(e) => update({ inactive: e.target.checked ? '1' : null })}
        />
      </form>

      {q.trim() === '' ? (
        <EmptyState>Type a query to search memories, decisions, docs and the library.</EmptyState>
      ) : search.isPending ? (
        <SkeletonRows rows={5} />
      ) : search.isError ? (
        <ErrorState error={search.error} onRetry={() => search.refetch()} />
      ) : (
        <>
          {search.data.notes.length > 0 && (
            <Alert tone="warning" className="mb-3">
              {search.data.notes.join(' ')}
            </Alert>
          )}
          {hits.length === 0 ? (
            <EmptyState title={`No results for "${q.trim()}"`}>
              {includeInactive ? 'Try other words.' : 'Try other words, or include inactive items.'}
            </EmptyState>
          ) : (
            <>
              <p className="mb-2 text-sm text-muted" aria-live="polite">
                {hits.length} {hits.length === 1 ? 'result' : 'results'}
              </p>
              <ol
                className="divide-y divide-border rounded-md border border-border"
                aria-label="Search results"
              >
                {hits.map((h) => (
                  <li key={h.item.id}>
                    <Hit hit={h} />
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </section>
  )
}

/** A hit links to the item in its own project: an `S:` hit opens under /shared. */
function Hit({ hit }: { hit: SearchHit }) {
  const { item } = hit
  return (
    <article className="px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-muted">{item.handle}</span>
        <Link to={summaryPath(item)} className="font-medium text-accent hover:underline">
          {item.title}
        </Link>
        <Badge>{item.space}</Badge>
        <ItemBadges item={item} />
      </div>
      {hit.snippet && <p className="mt-1 text-sm break-words text-muted">{hit.snippet}</p>}
    </article>
  )
}
