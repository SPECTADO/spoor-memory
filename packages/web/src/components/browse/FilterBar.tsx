import { type FormEvent, useEffect, useState } from 'react'
import type { Space } from '../../api/types'
import {
  activeFilterCount,
  LIFECYCLE_LABEL,
  LIFECYCLES,
  type LifecycleFilter,
  type ListFilters,
  MEMORY_TYPES,
  normalizeTag,
  SORTS,
  STATUSES,
  withoutTag,
  withTag,
} from '../../lib/listFilters'
import { Button, Checkbox, Input, Select } from '../../ui'

const opt = (values: readonly string[]) => values.map((v) => ({ value: v, label: v }))

/**
 * Filters of a space list (web-ui.md §4.3): type (memories), status, lifecycle, tags (chips, AND), pinned only,
 * anchor path, sort. Controlled: every change calls `onChange` with an update of the current filters, so the
 * owner can apply it to filters newer than the rendered `filters` (two quick changes keep both).
 */
export function FilterBar({
  space,
  filters,
  onChange,
}: {
  space: Space
  filters: ListFilters
  onChange: (change: (current: ListFilters) => ListFilters) => void
}) {
  const [tagDraft, setTagDraft] = useState('')
  const [tagError, setTagError] = useState<string | null>(null)
  const [anchorDraft, setAnchorDraft] = useState(filters.anchor)
  useEffect(() => setAnchorDraft(filters.anchor), [filters.anchor])
  const set = (patch: Partial<ListFilters>) => onChange((f) => ({ ...f, ...patch }))

  const addTag = (e: FormEvent) => {
    e.preventDefault()
    if (!tagDraft.trim()) return
    if (normalizeTag(tagDraft) === null) {
      setTagError('Tags are lower case letters, digits, "-", "_" or "/" (up to 40).')
      return
    }
    setTagError(null)
    const tag = tagDraft
    onChange((f) => withTag(f, tag))
    setTagDraft('')
  }
  const commitAnchor = (e?: FormEvent) => {
    e?.preventDefault()
    if (anchorDraft.trim() !== filters.anchor) set({ anchor: anchorDraft.trim() })
  }
  const count = activeFilterCount(filters)
  const statuses = STATUSES[space]

  return (
    // biome-ignore lint/a11y/useSemanticElements: <search> is not in the JSX types; role="search" is equivalent
    <div
      role="search"
      aria-label={`Filter ${space}`}
      className="mb-4 space-y-3 rounded-md border border-border bg-surface p-3"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {space === 'memories' && (
          <Select
            label="Type"
            value={filters.type}
            onChange={(e) => set({ type: e.target.value as ListFilters['type'] })}
            options={[{ value: '', label: 'Any type' }, ...opt(MEMORY_TYPES)]}
          />
        )}
        {statuses.length > 0 && (
          <Select
            label="Status"
            value={filters.status}
            onChange={(e) => set({ status: e.target.value })}
            options={[{ value: '', label: 'Any status' }, ...opt(statuses)]}
          />
        )}
        <Select
          label="Lifecycle"
          value={filters.lifecycle}
          onChange={(e) => set({ lifecycle: e.target.value as LifecycleFilter })}
          options={[
            { value: 'default', label: LIFECYCLE_LABEL.default },
            ...LIFECYCLES.map((l) => ({ value: l, label: LIFECYCLE_LABEL[l] })),
          ]}
        />
        <form onSubmit={commitAnchor}>
          <Input
            label="Anchor path"
            placeholder="src/auth/login.ts"
            value={anchorDraft}
            onChange={(e) => setAnchorDraft(e.target.value)}
            onBlur={() => commitAnchor()}
          />
        </form>
        <form onSubmit={addTag} className="flex items-end gap-2">
          <Input
            className="flex-1"
            label="Tag"
            hint="AND across tags"
            error={tagError ?? undefined}
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
          />
          <Button type="submit" className="mb-[1.375rem]">
            Add tag
          </Button>
        </form>
        <Select
          label="Sort by"
          value={filters.sort}
          onChange={(e) => set({ sort: e.target.value as ListFilters['sort'] })}
          options={SORTS.map((s) => ({
            value: s,
            label: { updated: 'Updated', created: 'Created', verified: 'Last verified', number: 'Number' }[s],
          }))}
        />
        <Select
          label="Order"
          value={filters.dir}
          onChange={(e) => set({ dir: e.target.value as ListFilters['dir'] })}
          options={[
            { value: 'desc', label: 'Newest first' },
            { value: 'asc', label: 'Oldest first' },
          ]}
        />
        <div className="flex items-end pb-2">
          <Checkbox
            label="Pinned only"
            checked={filters.pinned}
            onChange={(e) => set({ pinned: e.target.checked })}
          />
        </div>
      </div>
      {(filters.tags.length > 0 || count > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          <ul aria-label="Active tags" className="flex flex-wrap gap-1">
            {filters.tags.map((t) => (
              <li key={t}>
                <button
                  type="button"
                  aria-label={`Remove tag ${t}`}
                  onClick={() => onChange((f) => withoutTag(f, t))}
                  className="rounded bg-accent-soft px-2 py-0.5 text-xs text-accent hover:underline"
                >
                  {t} ×
                </button>
              </li>
            ))}
          </ul>
          {count > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                onChange((f) => ({
                  ...f,
                  type: '',
                  status: '',
                  lifecycle: 'default',
                  tags: [],
                  pinned: false,
                  anchor: '',
                }))
              }
            >
              Clear filters ({count})
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
