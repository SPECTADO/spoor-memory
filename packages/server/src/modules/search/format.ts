/**
 * Output shapes of search: the agent text lines (mcp.md section 5 `spoor_search`, used by the MCP module) and
 * the REST `ItemSummary` (api.md section 0.6) for `GET /api/v1/projects/:slug/search`.
 */
import { cleanLine, type ItemSummary } from '@spoor/shared'
import { inArray } from 'drizzle-orm'
import { items } from '../../db/schema.js'
import type { DbOrTx } from '../../lib/db.js'
import { itemHandle, loadItems, summaryJson } from '../items/index.js'
import { itemTag, truncateTitle } from './digest.js'
import type { SearchHit, SearchResult } from './service.js'

/** `m57~ r2 [dec] (stale) Title | …snippet…` */
export function formatSearchLine(h: SearchHit): string {
  const marks: string[] = []
  if (h.lifecycle === 'stale') marks.push('(stale)')
  if (h.lifecycle === 'archived') marks.push('(archived)')
  if (h.status === 'superseded' || h.status === 'deprecated') marks.push(`(${h.status})`)
  const handle = itemHandle(h, h.shared)
  const pre = marks.length > 0 ? `${marks.join(' ')} ` : ''
  const snippet = h.snippet ? ` | ${h.snippet}` : ''
  return `${handle}${h.provenance === 'agent' ? '~' : ''} r${h.revision} [${itemTag(h)}] ${pre}${truncateTitle(h.title)}${snippet}`
}

/** The whole `spoor_search` text block: count line, one line per hit, then `note:` lines. */
export function formatSearchResults(query: string, result: SearchResult): string {
  const q = cleanLine(query).replace(/\s+/g, ' ').replace(/"/g, "'").slice(0, 80)
  const n = result.hits.length
  const lines = [`${n} result${n === 1 ? '' : 's'} "${q}"`, ...result.hits.map(formatSearchLine)]
  for (const note of result.notes) lines.push(`note: ${note}`)
  return lines.join('\n')
}

/** `ItemSummary` JSON (api.md section 0.6) for the given item ids, keyed by id: the items module's serializer. */
export async function loadItemSummaries(
  db: DbOrTx,
  ids: readonly string[],
  viewerProjectIsShared: boolean,
): Promise<Map<string, ItemSummary>> {
  const out = new Map<string, ItemSummary>()
  if (ids.length === 0) return out
  const view = { projectId: '', projectIsShared: viewerProjectIsShared }
  for (const row of await loadItems(db, inArray(items.id, [...ids]))) out.set(row.id, summaryJson(row, view))
  return out
}
