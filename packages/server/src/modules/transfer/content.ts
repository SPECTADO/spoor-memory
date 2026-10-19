/**
 * The content of an item as it appears in a Markdown file or a revision snapshot (data-model.md sections 3
 * and 5), and how an export file's frontmatter is built. Pure; no database.
 *
 * One rule set for every write path: the known-key table is `@spoor/shared`'s, and titles, bodies, tags,
 * anchors and extras go through the item module's cleaners (`cleanTitle`, `cleanBody`, `cleanTags`,
 * `cleanAnchors` with the one anchor validator, `cleanExtras`), so an archive stores exactly what the API
 * would store and anything the API accepts re-imports. Their `invalid_input` becomes `invalid_archive`
 * naming the file.
 */
import { extrasOf, knownKeys } from '@spoor/shared'
import { type CONFIDENCES, MEMORY_TYPES } from '../../db/schema.js'
import { ApiError } from '../../lib/errors.js'
import type { Space } from '../../ports.js'
import {
  type ContentFields,
  cleanAnchors,
  cleanBody,
  cleanExtras,
  cleanTags,
  cleanTitle,
} from '../items/index.js'
import { invalidArchive } from './errors.js'

export type MemoryType = (typeof MEMORY_TYPES)[number]
export type Confidence = (typeof CONFIDENCES)[number]

/** The item fields a file carries (everything of `ContentFields` but `decidedOn`, which is per item). */
export type Content = Omit<ContentFields, 'decidedOn' | 'type' | 'confidence'> & {
  /** memories only */
  type: MemoryType | null
  /** memories only */
  confidence: Confidence | null
}

export const STATUSES: Record<Space, readonly string[]> = {
  memories: ['active', 'superseded'],
  docs: ['active', 'superseded'],
  decisions: ['proposed', 'accepted', 'superseded', 'deprecated'],
}

function fail(path: string, message: string): never {
  throw invalidArchive(`${path}: ${message}`, [{ path, message }])
}

const isStr = (x: unknown): x is string => typeof x === 'string'

/** Run an item field cleaner; its `invalid_input` (or `too_large`) is the archive's fault. */
function field<T>(path: string, fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'invalid_input' || err.code === 'too_large')) {
      const issue = (err.details?.issues as { path: string; message: string }[] | undefined)?.[0]
      return fail(path, issue ? `${issue.path}: ${issue.message}` : (err.publicMessage ?? 'invalid field'))
    }
    throw err
  }
}

const stringList = (path: string, key: string, v: unknown): string[] => {
  if (v === undefined) return []
  if (!Array.isArray(v) || !v.every(isStr)) return fail(path, `${key} must be a list of strings`)
  return v
}

/**
 * Build `Content` from frontmatter. `title` / `status` given in `opts` (a snapshot's columns) win over the
 * frontmatter; otherwise the frontmatter, then `opts.titleFallback`. A bad archive is `invalid_archive`,
 * never a database error.
 */
export function contentFrom(
  space: Space,
  fm: Record<string, unknown>,
  opts: {
    path: string
    body: string
    title?: string
    titleFallback?: string
    status?: string
    defaultStatus: string
  },
): Content {
  const { path } = opts
  const rawTitle = opts.title ?? (isStr(fm.title) ? fm.title : opts.titleFallback)
  if (!isStr(rawTitle)) return fail(path, 'title is missing')
  const title = field(path, () => cleanTitle(rawTitle))
  const body = field(path, () => cleanBody(opts.body))
  const tags = field(path, () => cleanTags(stringList(path, 'tags', fm.tags)))
  const anchors = field(path, () => cleanAnchors(stringList(path, 'anchors', fm.anchors)))

  let type: MemoryType | null = null
  let confidence: Confidence | null = null
  if (space === 'memories') {
    if (!isStr(fm.type) || !(MEMORY_TYPES as readonly string[]).includes(fm.type))
      return fail(path, 'type is missing or invalid')
    type = fm.type as MemoryType
    const c = fm.confidence === undefined ? 'medium' : fm.confidence
    if (c !== 'low' && c !== 'medium' && c !== 'high') return fail(path, 'confidence is invalid')
    confidence = c
  }

  const status = opts.status ?? (fm.status === undefined ? opts.defaultStatus : fm.status)
  if (!isStr(status) || !STATUSES[space].includes(status)) return fail(path, `status is invalid for ${space}`)

  const extras = field(path, () => cleanExtras(extrasOf(space, fm), knownKeys(space)))
  return { title, body, status, type, confidence, tags, anchors, extras }
}

export interface ExportFrontmatterInput {
  id: string
  space: Space
  title: string
  tags: string[]
  anchors: string[]
  pinned: boolean
  lastVerifiedAt: Date
  type: string | null
  confidence: string | null
  status: string
  expiresAt: Date | null
  adrNumber: number | null
  decidedOn: string | null
  extras: Record<string, unknown>
  /** typed edges as exported: uuid or `shared:<space>/<slug>` */
  relations: { kind: string; to: string }[]
  supersedes: string | null
  supersededBy: string | null
  draftedFrom: string[]
}

/**
 * Canonical key order = table order of data-model.md section 5, extras last in sorted order. An extra never
 * overrides a known key (an extra named like one would change the item's meaning on re-import).
 */
export function exportFrontmatter(i: ExportFrontmatterInput): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    spoor_id: i.id,
    title: i.title,
    tags: i.tags,
    anchors: i.anchors,
    pinned: i.pinned,
    last_verified: i.lastVerifiedAt.toISOString(),
    relations: i.relations,
  }
  if (i.supersedes) fm.supersedes = i.supersedes
  if (i.supersededBy) fm.superseded_by = i.supersededBy
  if (i.space === 'memories') {
    fm.type = i.type
    fm.confidence = i.confidence
    fm.status = i.status
    if (i.expiresAt) fm.expires = i.expiresAt.toISOString()
  } else if (i.space === 'decisions') {
    fm.adr = i.adrNumber
    fm.status = i.status
    if (i.decidedOn) fm.date = i.decidedOn
    if (i.draftedFrom.length > 0) fm.drafted_from = i.draftedFrom
  } else if (i.status !== 'active') {
    fm.status = i.status
  }
  const known = knownKeys(i.space)
  for (const k of Object.keys(i.extras).sort()) if (!known.has(k)) fm[k] = i.extras[k]
  return fm
}
