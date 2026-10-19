/**
 * Space list filters (web-ui.md §4.3). The filters live in the URL query so a list can be bookmarked and the
 * back button works; this module is the only place that maps between the URL, the form state and the
 * `GET …/spaces/:space/items` query. Unknown or invalid URL values are dropped, never sent to the server.
 */
import { TAG_RE } from '@spoor/shared'
import type { ItemListFilters, MemoryType, Space } from '../api/types'

export const MEMORY_TYPES: readonly MemoryType[] = ['decision', 'fact', 'procedure', 'observation']
export const LIFECYCLES = ['active', 'stale', 'archived', 'all'] as const
export type LifecycleFilter = (typeof LIFECYCLES)[number] | 'default'
export const SORTS = ['updated', 'created', 'verified', 'number'] as const
export type Sort = (typeof SORTS)[number]

/** Statuses a space can be filtered by (docs have no fixed vocabulary). */
export const STATUSES: Record<Space, readonly string[]> = {
  memories: ['active', 'superseded'],
  decisions: ['proposed', 'accepted', 'superseded', 'deprecated'],
  docs: [],
}

export interface ListFilters {
  type: MemoryType | ''
  status: string
  /** `default` = the server default "Active and stale". */
  lifecycle: LifecycleFilter
  tags: string[]
  pinned: boolean
  anchor: string
  sort: Sort
  dir: 'asc' | 'desc'
}

export const DEFAULT_FILTERS: ListFilters = {
  type: '',
  status: '',
  lifecycle: 'default',
  tags: [],
  pinned: false,
  anchor: '',
  sort: 'updated',
  dir: 'desc',
}

const MAX_TAGS = 5

/** Normalise what a user typed into a tag chip: trimmed, lower case, no leading `#`; null when invalid. */
export function normalizeTag(raw: string): string | null {
  const t = raw.trim().replace(/^#/, '').toLowerCase()
  return TAG_RE.test(t) ? t : null
}

export function parseFilters(space: Space, params: URLSearchParams): ListFilters {
  const type = params.get('type') as MemoryType | null
  const status = params.get('status') ?? ''
  const lifecycle = params.get('lifecycle')
  const sort = params.get('sort')
  const dir = params.get('dir')
  const tags = [
    ...new Set(
      params
        .getAll('tag')
        .map(normalizeTag)
        .filter((t): t is string => t !== null),
    ),
  ].slice(0, MAX_TAGS)
  return {
    type: space === 'memories' && type && MEMORY_TYPES.includes(type) ? type : '',
    status: STATUSES[space].includes(status) ? status : '',
    lifecycle: (LIFECYCLES as readonly string[]).includes(lifecycle ?? '')
      ? (lifecycle as LifecycleFilter)
      : 'default',
    tags,
    pinned: params.get('pinned') === '1',
    anchor: (params.get('anchor') ?? '').trim(),
    // `number` only makes sense for decisions (ADR numbers) and memories/docs have item numbers too
    sort: (SORTS as readonly string[]).includes(sort ?? '') ? (sort as Sort) : DEFAULT_FILTERS.sort,
    dir: dir === 'asc' ? 'asc' : 'desc',
  }
}

/** The URL form of `filters`: defaults are omitted so an unfiltered list has a clean URL. */
export function toSearchParams(filters: ListFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (filters.type) p.set('type', filters.type)
  if (filters.status) p.set('status', filters.status)
  if (filters.lifecycle !== 'default') p.set('lifecycle', filters.lifecycle)
  for (const t of filters.tags) p.append('tag', t)
  if (filters.pinned) p.set('pinned', '1')
  if (filters.anchor) p.set('anchor', filters.anchor)
  if (filters.sort !== DEFAULT_FILTERS.sort) p.set('sort', filters.sort)
  if (filters.dir !== DEFAULT_FILTERS.dir) p.set('dir', filters.dir)
  return p
}

/** The API query for `filters` (no cursor). */
export function toApiFilters(filters: ListFilters): Omit<ItemListFilters, 'cursor'> {
  const out: Omit<ItemListFilters, 'cursor'> = { sort: filters.sort, dir: filters.dir }
  if (filters.type) out.type = [filters.type]
  if (filters.status) out.status = [filters.status]
  if (filters.lifecycle !== 'default') out.lifecycle = [filters.lifecycle]
  if (filters.tags.length > 0) out.tag = filters.tags
  if (filters.pinned) out.pinned = true
  if (filters.anchor) out.anchor = filters.anchor
  return out
}

/** How many filters differ from the defaults (sort and direction are not filters). */
export function activeFilterCount(filters: ListFilters): number {
  return (
    (filters.type ? 1 : 0) +
    (filters.status ? 1 : 0) +
    (filters.lifecycle !== 'default' ? 1 : 0) +
    filters.tags.length +
    (filters.pinned ? 1 : 0) +
    (filters.anchor ? 1 : 0)
  )
}

export const withTag = (filters: ListFilters, tag: string): ListFilters => {
  const t = normalizeTag(tag)
  if (!t || filters.tags.includes(t) || filters.tags.length >= MAX_TAGS) return filters
  return { ...filters, tags: [...filters.tags, t] }
}
export const withoutTag = (filters: ListFilters, tag: string): ListFilters => ({
  ...filters,
  tags: filters.tags.filter((t) => t !== tag),
})

export const LIFECYCLE_LABEL: Record<LifecycleFilter, string> = {
  default: 'Active and stale',
  active: 'Active',
  stale: 'Stale',
  archived: 'Archived',
  all: 'All',
}
