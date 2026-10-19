/**
 * Text output of the MCP tools (docs/design/mcp.md section 4): one `text` block, handles first, no JSON,
 * no prose padding. Pure functions only (unit-tested in format.test.ts).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { cleanLine, serializeMarkdown } from '@spoor/shared'
import { ApiError } from '../../lib/errors.js'
import type { Space } from '../../ports.js'
import { type CanonicalInput, canonicalFrontmatter } from '../items/index.js'
import { itemTag } from '../search/index.js'

/** The fixed first line of output that carries item content (the digest's own framing line). */
export { FRAMING_LINE } from '../search/index.js'

export const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] })
export const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] })

/** One line: control and bidi characters gone, whitespace runs collapsed. */
export const oneLine = (s: string): string => cleanLine(s.replace(/\s+/g, ' '))

/** The tag of search-and-digest.md section 7 (the digest's `itemTag`); an ADR without a status reads `proposed`. */
export function tagOf(i: {
  space: Space
  type: string | null
  status?: string | null
  decidedOn?: string | null
}): string {
  return itemTag({
    space: i.space,
    type: i.type,
    status: i.status ?? 'proposed',
    decidedOn: i.decidedOn ?? null,
  })
}

// ---- errors ---------------------------------------------------------------------------------------------

/** Next steps per stable code (mcp.md section 7) when the service gave none. */
const DEFAULT_HINT: Partial<Record<string, string>> = {
  forbidden_role: 'ask a project admin for editor',
  read_only_space: 'shared is edited by humans in the web UI',
  not_found: 'spoor_search',
  revision_required: 'spoor_get first',
  mirrored_item: 'edit the repo file',
}

/** `ERR <code>: <message>` plus an optional `hint:` line. Never tokens, SQL or stacks (callers pass safe text). */
export function errorText(code: string, message?: string, hint?: string): string {
  const lines = [`ERR ${code}: ${oneLine(message ?? code.replace(/_/g, ' '))}`]
  const h = hint ?? DEFAULT_HINT[code]
  if (h) lines.push(`hint: ${oneLine(h)}`)
  return lines.join('\n')
}

/**
 * An expected failure of the services as tool text. `hints` supplies the hint per code where the service gave
 * none (the tool knows the right next step, e.g. which tool to use for `wrong_space`). The service's own message is kept: ApiError
 * messages never carry secrets (lib/errors.ts).
 */
export function apiErrorText(err: ApiError, hints: Partial<Record<string, string>> = {}): string {
  const d = err.details ?? {}
  let hint = err.hint ?? hints[err.code]
  if (err.code === 'revision_conflict' && typeof d.current_revision === 'number') {
    hint = `current r${d.current_revision}; re-read with spoor_get and re-apply`
  } else if (err.code === 'slug_taken' && typeof d.handle === 'string' && typeof d.revision === 'number') {
    hint = `exists as ${d.handle} r${d.revision}; update it with id="${d.handle}" revision=${d.revision}`
  } else if (err.code === 'invalid_input' && hint === undefined) {
    const issues = (d.issues as { path?: string }[] | undefined) ?? []
    if (issues[0]?.path) hint = `field ${issues[0].path}`
  }
  return errorText(err.code, err.publicMessage, hint)
}

export const asApiError = (err: unknown): ApiError | null => (err instanceof ApiError ? err : null)

// ---- write results --------------------------------------------------------------------------------------

export interface DuplicateView {
  handle: string
  revision: number
  cos: number
  title: string
  lifecycle: string
  space: Space
  type: string | null
}

/** search-and-digest.md section 5: the non-error DUPLICATE result. */
export function duplicateText(dup: DuplicateView, tool: 'spoor_remember' | 'spoor_doc_write'): string {
  const stale = dup.lifecycle === 'stale' ? '(stale; spoor_verify restores it) ' : ''
  const what = dup.space === 'docs' ? 'different doc' : 'different fact'
  return [
    `DUPLICATE ${dup.handle} r${dup.revision} cos=${dup.cos.toFixed(2)} [${tagOf(dup)}] ${stale}${oneLine(dup.title)}`,
    'Not saved; the existing item is kept.',
    `next: still true → spoor_verify ids=["${dup.handle}"] · changed → ${tool} id="${dup.handle}" revision=${dup.revision} … · ${what} → repeat with allow_duplicate=true`,
  ].join('\n')
}

/** Service warnings and notes as `note:` lines (only the ones an agent can act on). */
export function noteLines(notes: readonly string[], warnings: readonly { code: string }[] = []): string[] {
  const out = notes.map((n) => `note: ${oneLine(n)}`)
  for (const w of warnings) {
    if (w.code === 'embedding_pending') out.push('note: embedding pending; keyword search finds it meanwhile')
    else if (w.code === 'status_kept_superseded') out.push('note: status kept superseded')
  }
  return out
}

// ---- spoor_get ------------------------------------------------------------------------------------------

export interface GetItemView extends CanonicalInput {
  /** `m42~`: handle with the agent-provenance mark. */
  markedHandle: string
  /** Plain handle (for the paging hint). */
  handle: string
  revision: number
  slug: string
  body: string
  lifecycle: string
  pinned: boolean
  lastVerifiedAt: Date
  expiresAt: Date | null
  sourcePath: string | null
}

export interface LinkView {
  kind: string
  direction: 'out' | 'in'
  /** The other end's handle; `null` for a dangling wikilink. */
  other: string | null
  /** Dangling wikilinks: the unresolved ref. */
  ref?: string | null
}

/** `refines→m12 · supports←m50 · wikilink→?auth-flow · superseded_by→m60` */
export function linksLine(links: readonly LinkView[]): string | null {
  if (links.length === 0) return null
  const parts = links.map((l) => {
    if (l.direction === 'in' && l.kind === 'supersedes') return `superseded_by→${l.other}`
    const arrow = l.direction === 'out' ? '→' : '←'
    return `${l.kind}${arrow}${l.other ?? `?${l.ref ?? ''}`}`
  })
  return `links: ${parts.join(' · ')}`
}

/** One item of `spoor_get` (mcp.md section 5): header, frontmatter, the body page, the paging hint, links. */
export function getItemText(
  item: GetItemView,
  links: readonly LinkView[],
  page: { offset: number; maxChars: number },
): string {
  const fm = canonicalFrontmatter(item)
  // agent output carries nothing twice (review-log-phase5 A11): the id is in the header line, empty lists and an
  // `active` lifecycle say nothing
  delete fm.spoor_id
  for (const k of ['tags', 'anchors'])
    if (Array.isArray(fm[k]) && (fm[k] as unknown[]).length === 0) delete fm[k]
  fm.status = item.status
  if (item.lifecycle !== 'active') fm.lifecycle = item.lifecycle
  if (item.pinned) fm.pinned = true
  fm.last_verified = item.lastVerifiedAt.toISOString()
  if (item.expiresAt) fm.expires = item.expiresAt.toISOString()
  if (item.sourcePath) fm.source_path = item.sourcePath
  const total = item.body.length
  const start = Math.min(page.offset, total)
  let end = Math.min(start + page.maxChars, total)
  // never split a surrogate pair at the page end
  if (end < total && end > start && /[\uD800-\uDBFF]/.test(item.body.charAt(end - 1))) end--
  const slice = item.body.slice(start, end)
  const lines = [
    `=== ${item.markedHandle} r${item.revision} ${item.space}/${item.slug} id=${item.id}`,
    serializeMarkdown(fm, slice).replace(/\n$/, ''),
  ]
  if (end < total) {
    lines.push(`[truncated ${end}/${total}; spoor_get ids=["${item.handle}"] offset=${end}]`)
  } else if (page.offset > 0 && page.offset >= total && total > 0) {
    lines.push(`[offset ${page.offset} is past the end ${total}]`)
  }
  const l = linksLine(links)
  if (l) lines.push(l)
  return lines.join('\n')
}
