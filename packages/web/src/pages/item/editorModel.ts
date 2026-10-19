/**
 * The editor's form model (web-ui.md §5): values, client-side validation with the shared rules (title
 * length, tag pattern, anchor normaliser, slug shape, body limit), and the request bodies. Pure functions,
 * so the rules are tested without rendering.
 */
import {
  adrStatuses,
  codePointLength,
  confidences,
  ITEM_LIMITS,
  itemSlug,
  memoryTypes,
  SLUG_MAX,
  SLUG_RE,
  TAG_RE,
  validateAnchor,
} from '@spoor/shared'
import type {
  AdrStatus,
  Confidence,
  ItemCreateBody,
  ItemJson,
  ItemPatchBody,
  MemoryType,
  Space,
} from '../../api/types'

export const MEMORY_TYPES = memoryTypes as readonly MemoryType[]
export const CONFIDENCES = confidences as readonly Confidence[]
export const ADR_STATUSES = adrStatuses as readonly AdrStatus[]

export interface EditorValues {
  title: string
  body: string
  /** memories */
  type: MemoryType
  confidence: Confidence
  /** decisions */
  status: AdrStatus
  /** decisions, `YYYY-MM-DD` or empty */
  decided_on: string
  /** decisions, create only (optional) */
  adr_number: string
  tags: string[]
  /** One anchor per line, as typed. */
  anchors: string
  /** create only; empty = derived from the title by the server */
  slug: string
  /** create only (memories and docs): skip the near-duplicate check */
  allow_duplicate: boolean
}

export type FieldName = keyof EditorValues
export type FieldErrors = Partial<Record<FieldName, string>>

export const TAG_HINT =
  'Lower-case letters, digits, "-", "_" or "/", starting with a letter or digit, at most 40 characters.'

export function emptyValues(over: Partial<EditorValues> = {}): EditorValues {
  return {
    title: '',
    body: '',
    type: 'fact',
    confidence: 'medium',
    status: 'proposed',
    decided_on: '',
    adr_number: '',
    tags: [],
    anchors: '',
    slug: '',
    allow_duplicate: false,
    ...over,
  }
}

export function valuesFromItem(item: ItemJson): EditorValues {
  return {
    title: item.title,
    body: item.body,
    type: (MEMORY_TYPES as readonly string[]).includes(item.type ?? '') ? (item.type as MemoryType) : 'fact',
    confidence: (CONFIDENCES as readonly string[]).includes(item.confidence ?? '')
      ? (item.confidence as Confidence)
      : 'medium',
    status: (ADR_STATUSES as readonly string[]).includes(item.status)
      ? (item.status as AdrStatus)
      : 'proposed',
    decided_on: item.decided_on ?? '',
    adr_number: item.adr_number ? String(item.adr_number) : '',
    tags: [...item.tags],
    anchors: item.anchors.join('\n'),
    slug: item.slug,
    allow_duplicate: false,
  }
}

/** A typed tag → the stored form, or null when it breaks the shared tag pattern. */
export function normalizeTag(raw: string): string | null {
  const t = raw.trim().toLowerCase()
  return TAG_RE.test(t) ? t : null
}

/** Anchors textarea → normalised anchors (shared normaliser), with the first problem as `error`. */
export function parseAnchors(text: string): { anchors: string[]; error: string | null } {
  const out: string[] = []
  let error: string | null = null
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? '').trim()
    if (!raw) continue
    const v = validateAnchor(raw)
    if (!v.ok) {
      error ??= `Line ${i + 1}: ${v.reason}.`
      continue
    }
    if (!out.includes(v.anchor)) out.push(v.anchor)
  }
  if (!error && out.length > ITEM_LIMITS.anchors) error = `At most ${ITEM_LIMITS.anchors} anchors.`
  return { anchors: out, error }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const validDay = (s: string) => ISO_DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

/** Client-side rules; the server checks again (its `invalid_input` issues land on the same fields). */
export function validate(v: EditorValues, space: Space, mode: 'create' | 'edit'): FieldErrors {
  const e: FieldErrors = {}
  const title = v.title.trim()
  if (!title) e.title = 'A title is required.'
  else if (codePointLength(title) > ITEM_LIMITS.title) e.title = `At most ${ITEM_LIMITS.title} characters.`
  else if (/[\r\n]/.test(title)) e.title = 'One line only.'

  if (codePointLength(v.body) > ITEM_LIMITS.body)
    e.body = `At most ${ITEM_LIMITS.body.toLocaleString('en')} characters.`

  const bad = v.tags.find((t) => !TAG_RE.test(t))
  if (bad !== undefined) e.tags = `"${bad}" is not a valid tag. ${TAG_HINT}`
  else if (v.tags.length > ITEM_LIMITS.tags) e.tags = `At most ${ITEM_LIMITS.tags} tags.`

  const anchors = parseAnchors(v.anchors)
  if (anchors.error) e.anchors = anchors.error

  if (mode === 'create' && v.slug.trim()) {
    const s = v.slug.trim()
    if (s.length > SLUG_MAX || !SLUG_RE.test(s))
      e.slug = 'Lower-case letters and digits separated by single "-", at most 80 characters.'
  }
  if (space === 'decisions') {
    if (v.decided_on && !validDay(v.decided_on)) e.decided_on = 'A date like 2026-10-19.'
    if (mode === 'create' && v.adr_number.trim()) {
      const n = Number(v.adr_number)
      if (!Number.isInteger(n) || n < 1 || n > 99999) e.adr_number = 'A whole number from 1 to 99999.'
    }
  }
  return e
}

export const hasErrors = (e: FieldErrors) => Object.values(e).some(Boolean)

/** The slug the server derives from the title when none is given (shown as the slug field's hint). */
export const defaultSlug = (title: string) => itemSlug(title.trim())

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i])

/** Whether the form differs from `base` (what the user would lose). */
export function isChanged(v: EditorValues, base: EditorValues): boolean {
  return (
    v.title !== base.title ||
    v.body !== base.body ||
    v.type !== base.type ||
    v.confidence !== base.confidence ||
    v.status !== base.status ||
    v.decided_on !== base.decided_on ||
    v.adr_number !== base.adr_number ||
    !sameList(v.tags, base.tags) ||
    v.anchors !== base.anchors ||
    v.slug !== base.slug ||
    v.allow_duplicate !== base.allow_duplicate
  )
}

export function createBody(v: EditorValues, space: Space): ItemCreateBody {
  const body: ItemCreateBody = { title: v.title.trim(), body: v.body }
  if (v.tags.length) body.tags = v.tags
  const anchors = parseAnchors(v.anchors).anchors
  if (anchors.length) body.anchors = anchors
  if (v.slug.trim()) body.slug = v.slug.trim()
  if (space === 'memories') {
    body.type = v.type
    body.confidence = v.confidence
  }
  if (space === 'decisions') {
    body.status = v.status
    if (v.decided_on) body.decided_on = v.decided_on
    if (v.adr_number.trim()) body.adr_number = Number(v.adr_number)
  }
  if (space !== 'decisions' && v.allow_duplicate) body.allow_duplicate = true
  return body
}

/**
 * PATCH body: only the fields that differ from `base` (the values the form was loaded with), based on
 * `revision`. Used both for a normal save and for "Save my version over rN" (the user's changes on top of
 * the newer revision; fields they did not touch keep the newer values).
 */
export function patchBody(
  v: EditorValues,
  base: EditorValues,
  revision: number,
  space: Space,
): ItemPatchBody {
  const p: ItemPatchBody = { revision }
  if (v.title.trim() !== base.title.trim()) p.title = v.title.trim()
  if (v.body !== base.body) p.body = v.body
  if (!sameList(v.tags, base.tags)) p.tags = v.tags
  const anchors = parseAnchors(v.anchors).anchors
  if (!sameList(anchors, parseAnchors(base.anchors).anchors)) p.anchors = anchors
  if (space === 'memories') {
    if (v.type !== base.type) p.type = v.type
    if (v.confidence !== base.confidence) p.confidence = v.confidence
  }
  if (space === 'decisions') {
    if (v.status !== base.status) p.status = v.status
    if (v.decided_on !== base.decided_on) p.decided_on = v.decided_on || null
  }
  return p
}

/** Fields a server `invalid_input` issue path points at (`tags.2` → tags). */
export function fieldOfIssue(path: string): FieldName | null {
  const head = path.split('.')[0] ?? ''
  const known: FieldName[] = [
    'title',
    'body',
    'type',
    'confidence',
    'status',
    'decided_on',
    'adr_number',
    'tags',
    'anchors',
    'slug',
    'allow_duplicate',
  ]
  return (known as string[]).includes(head) ? (head as FieldName) : null
}
