/**
 * The items module's Markdown rules (data-model.md sections 5 and 7): frontmatter validation with the zod
 * schemas of `@spoor/shared`, the canonical frontmatter of a revision snapshot, and the repo-file
 * conventions of ADRs (number, title, status section). The splitter, the serializer, the known-key table and
 * the wikilink grammar live in `@spoor/shared` (one copy for push, import, export and the SPA).
 */
import { type adrStatuses, FrontmatterError, frontmatterSchemas, type Space, stripCode } from '@spoor/shared'

/** Extras the server owns: kept by a push whose file lacks them (data-model.md section 5). */
export const SERVER_OWNED_EXTRAS = ['renumbered_from', 'original_status'] as const

/** Validate a parsed mapping with the space's zod schema; issues are reported under `frontmatter.`. */
export function validateFrontmatter(space: Space, data: Record<string, unknown>) {
  const parsed = frontmatterSchemas[space].safeParse(data)
  if (!parsed.success) {
    throw new FrontmatterError(
      parsed.error.issues.map((i) => ({
        path: ['frontmatter', ...i.path.map(String)].join('.'),
        message: i.message,
      })),
    )
  }
  return parsed.data as Record<string, unknown>
}

export interface CanonicalInput {
  id: string
  space: Space
  title: string
  tags: string[]
  anchors: string[]
  type: string | null
  confidence: string | null
  status: string
  adrNumber: number | null
  decidedOn: string | null
  extras: Record<string, unknown>
}

/**
 * The FULL canonical frontmatter of an item's content (what `item_revisions.frontmatter` stores): the
 * content keys in table order, then the extras. Operational keys (`pinned`, `last_verified`, `expires`)
 * and edges are not content and are left out.
 */
export function canonicalFrontmatter(i: CanonicalInput): Record<string, unknown> {
  const fm: Record<string, unknown> = { spoor_id: i.id, title: i.title, tags: i.tags, anchors: i.anchors }
  if (i.space === 'memories') {
    fm.type = i.type
    fm.confidence = i.confidence
    fm.status = i.status
  } else if (i.space === 'decisions') {
    fm.adr = i.adrNumber
    fm.status = i.status
    if (i.decidedOn) fm.date = i.decidedOn
  } else if (i.status !== 'active') {
    fm.status = i.status
  }
  for (const [k, v] of Object.entries(i.extras)) if (!(k in fm)) fm[k] = v
  return fm
}

// ---- repo-file conventions (ADRs and docs) -----------------------------------------------------------

/** First `# H1` outside code, or null. */
export function firstH1(body: string): string | null {
  for (const line of stripCode(body).split('\n')) {
    const m = /^ {0,3}#[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line)
    if (m) return (m[1] as string).trim()
  }
  return null
}

/** Decision titles drop an `ADR-0007:` or `7.` prefix of the H1. */
export function stripAdrPrefix(h1: string): string {
  return h1
    .replace(/^ADR-\d+\s*[:.\-–—]\s*/i, '')
    .replace(/^\d+\.\s*/, '')
    .trim()
}

const baseName = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/i, '')

/** `docs/adr/0007-use-postgres.md` → 7. */
export function numberFromFileName(path: string): number | null {
  const m = /^(\d{1,5})-/.exec(baseName(path))
  return m ? Number.parseInt(m[1] as string, 10) : null
}

/** H1 `ADR-0007: …` or `7. …` → 7. */
export function numberFromH1(h1: string | null): number | null {
  if (!h1) return null
  const m = /^ADR-(\d+)/i.exec(h1) ?? /^(\d+)\./.exec(h1)
  return m ? Number.parseInt(m[1] as string, 10) : null
}

/** The file name without a numeric ADR prefix: what a mirrored item's slug and fallback title come from. */
export function fileStem(path: string, space: Space): string {
  const b = baseName(path)
  return space === 'decisions' ? b.replace(/^\d{1,5}-/, '') : b
}

/** `0007-use-postgres.md` → `Use postgres`. */
export function humanizeFileName(path: string, space: Space): string {
  const words = fileStem(path, space).replace(/[-_]+/g, ' ').trim()
  return words === '' ? 'Untitled' : words.charAt(0).toUpperCase() + words.slice(1)
}

export interface StatusSection {
  status: (typeof adrStatuses)[number]
  /** The word found when it was not one of the four statuses (kept as the extra `original_status`). */
  original: string | null
  /** `Superseded by ADR-0009` → `ADR-0009`. */
  supersededBy: string | null
}

const STATUS_WORDS: Record<string, (typeof adrStatuses)[number]> = {
  proposed: 'proposed',
  draft: 'proposed',
  accepted: 'accepted',
  approved: 'accepted',
  adopted: 'accepted',
  superseded: 'superseded',
  deprecated: 'deprecated',
  rejected: 'deprecated',
  withdrawn: 'deprecated',
  obsolete: 'deprecated',
}

/**
 * The value of a `key` written in the body, the way MADR, Nygard and adr-tools ADRs carry their metadata: an inline
 * `Status: x` line, also as a list item or heading and with Markdown emphasis around the key or colon
 * (`- **Status:** x`, `* __Date__: x`, `## Status: x`), or a `## Status` section whose first non-empty line is the value.
 * Fenced code is ignored. Null when the body has no such line or section.
 */
export function bodyField(body: string, key: string): string | null {
  const lines = stripCode(body).split('\n')
  const inlineRe = new RegExp(
    `^ {0,3}(?:#{1,6}[ \\t]+|[*-][ \\t]+)?[*_]{0,2}${key}[*_]{0,2}[ \\t]*:[*_]{0,2}[ \\t]*(\\S.*)$`,
    'i',
  )
  const headingRe = new RegExp(`^ {0,3}#{1,6}[ \\t]+[*_]{0,2}${key}[*_]{0,2}[ \\t]*#*[ \\t]*$`, 'i')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const inline = inlineRe.exec(line)
    if (inline) return (inline[1] as string).replace(/[*_]+$/, '').trim()
    if (headingRe.test(line)) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = (lines[j] as string).trim()
        if (next === '') continue
        if (/^#{1,6}\s/.test(next)) return null
        return next
      }
      return null
    }
  }
  return null
}

/**
 * Status of an ADR file without a `status` key (MADR / adr-tools): the first word of a `## Status` section
 * (or of `## Status: …`, or of a `* Status: …` / `- **Status:** …` line), lower-cased; `rejected` → `deprecated`
 * with the original kept; `superseded by X` → `superseded` and the ref. Null when the file has no status section.
 */
export function statusFromSection(body: string): StatusSection | null {
  const text = bodyField(body, 'status')
  if (text === null) return null
  const clean = text.replace(/^[*_>\-\s]+/, '').trim()
  const word = (/^[A-Za-z]+/.exec(clean)?.[0] ?? '').toLowerCase()
  if (word === '') return null
  const status = STATUS_WORDS[word] ?? 'accepted'
  const original = word === status ? null : word
  let supersededBy: string | null = null
  if (status === 'superseded') {
    const ref = /superseded\s+by\s+\[?\[?(ADR-\d+|[A-Za-z0-9:_-]+)/i.exec(clean)
    supersededBy = ref ? (ref[1] as string) : null
  }
  return { status, original, supersededBy }
}

/**
 * Decision date of an ADR file without a `date` key: the first `YYYY-MM-DD` of a `Date:` line or `## Date` section
 * (`- **Date:** 2026-10-19`), when it is a real calendar date. Without it an imported ADR never reaches the digest's
 * "Decisions (30d)" tier (review-log-phase5 D5).
 */
export function dateFromSection(body: string): string | null {
  const text = bodyField(body, 'date')
  const m = text === null ? null : /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text)
  if (!m) return null
  const iso = `${m[1]}-${m[2]}-${m[3]}`
  const d = new Date(`${iso}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null
}
