/** Handles and canonical refs (docs/design/data-model.md section 0). */
import { slugify } from './slug.js'

export type HandleKind = 'memory' | 'doc' | 'decision'

export interface ParsedHandle {
  kind: HandleKind
  /** `number` for m/d handles, `adr_number` for ADRs. */
  number: number
  /** `S:` prefix present: the item lives in the shared space. */
  shared: boolean
}

const HANDLE_RE = /^(S:)?(?:([md])(\d+)|ADR-(\d+))$/i

/** Parse `m42`, `d7`, `ADR-0007`, `adr-7` and their `S:` forms. Returns null for anything else (uuid, slug). */
export function parseHandle(input: string): ParsedHandle | null {
  const t = input.trim()
  const m = /^S:/.test(t) || !/^s:/i.test(t) ? HANDLE_RE.exec(t) : null
  if (!m) return null
  const shared = m[1] !== undefined
  if (m[4] !== undefined) {
    // `ADR-` is case-insensitive; the `m`/`d` forms are lower-case only.
    return { kind: 'decision', number: Number.parseInt(m[4], 10), shared }
  }
  const letter = m[2] as string
  if (letter !== 'm' && letter !== 'd') return null
  return { kind: letter === 'm' ? 'memory' : 'doc', number: Number.parseInt(m[3] as string, 10), shared }
}

export function formatHandle(kind: HandleKind, number: number, shared = false): string {
  const core =
    kind === 'memory'
      ? `m${number}`
      : kind === 'doc'
        ? `d${number}`
        : `ADR-${String(number).padStart(4, '0')}`
  return shared ? `S:${core}` : core
}

/** Canonical ref used for wikilinks and dst_ref: `ADR-0007`/`adr-7`/`ADR-07` give `adr-7`, `m42` stays, else slugify. */
export function canonicalRef(text: string): string {
  const t = text.trim()
  const adr = /^adr-(\d+)$/i.exec(t)
  if (adr) return `adr-${Number.parseInt(adr[1] as string, 10)}`
  if (/^[md]\d+$/.test(t)) return t
  return slugify(t)
}
