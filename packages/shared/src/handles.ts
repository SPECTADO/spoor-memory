/** Handles and canonical refs (docs/design/data-model.md section 0). */
import type { Space } from './frontmatter.js'
import { slugify } from './slug.js'

export type HandleKind = 'memory' | 'doc' | 'decision' | 'library'

export interface ParsedHandle {
  kind: HandleKind
  /** `number` for m/d/L handles, `adr_number` for ADRs. */
  number: number
  /** `S:` prefix present: the item lives in the shared space. */
  shared: boolean
}

/** The one space-to-handle table. */
export const SPACE_HANDLE_KIND: Record<Space, HandleKind> = {
  memories: 'memory',
  decisions: 'decision',
  docs: 'doc',
  library: 'library',
}

export const HANDLE_KIND_SPACE: Record<HandleKind, Space> = {
  memory: 'memories',
  decision: 'decisions',
  doc: 'docs',
  library: 'library',
}

const HANDLE_RE = /^(S:)?(?:([mdl])(\d+)|ADR-(\d+))$/i

/**
 * Parse `m42`, `d7`, `L3`/`l3`, `ADR-0007`, `adr-7` and their `S:` forms. Returns null for anything else
 * (uuid, slug).
 */
export function parseHandle(input: string): ParsedHandle | null {
  const t = input.trim()
  const m = /^S:/.test(t) || !/^s:/i.test(t) ? HANDLE_RE.exec(t) : null
  if (!m) return null
  const shared = m[1] !== undefined
  if (m[4] !== undefined) {
    // `ADR-` is case-insensitive; the `m`/`d` forms are lower-case only, `L` takes either case.
    return { kind: 'decision', number: Number.parseInt(m[4], 10), shared }
  }
  const letter = m[2] as string
  const kind: HandleKind | null =
    letter === 'm' ? 'memory' : letter === 'd' ? 'doc' : letter === 'l' || letter === 'L' ? 'library' : null
  if (kind === null) return null
  return { kind, number: Number.parseInt(m[3] as string, 10), shared }
}

export function formatHandle(kind: HandleKind, number: number, shared = false): string {
  const core =
    kind === 'memory'
      ? `m${number}`
      : kind === 'doc'
        ? `d${number}`
        : kind === 'library'
          ? `L${number}`
          : `ADR-${String(number).padStart(4, '0')}`
  return shared ? `S:${core}` : core
}

/**
 * The canonical ref form of an item's handle (what `dst_ref` and `refsOf` store): `m42`, `d7`, `l3`,
 * `adr-7`. A decision without an ADR number gives `adr-null`, which no link names.
 */
export function refHandle(space: Space, number: number, adrNumber: number | null): string {
  switch (space) {
    case 'memories':
      return `m${number}`
    case 'docs':
      return `d${number}`
    case 'library':
      return `l${number}`
    case 'decisions':
      return `adr-${adrNumber}`
  }
}

/**
 * Canonical ref used for wikilinks and dst_ref: `ADR-0007`/`adr-7`/`ADR-07` give `adr-7`, `m42` stays,
 * `L3`/`l3` give `l3`, else slugify.
 */
export function canonicalRef(text: string): string {
  const t = text.trim()
  const adr = /^adr-(\d+)$/i.exec(t)
  if (adr) return `adr-${Number.parseInt(adr[1] as string, 10)}`
  if (/^[md]\d+$/.test(t)) return t
  if (/^l\d+$/i.test(t)) return t.toLowerCase()
  return slugify(t)
}
