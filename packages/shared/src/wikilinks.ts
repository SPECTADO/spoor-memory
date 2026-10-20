/**
 * Wikilinks (data-model.md section 3): the grammar, code stripping, extraction, and the resolution order.
 * Pure and shared by the server (item writes, import) and the SPA (editor preview), so a link means the
 * same thing everywhere.
 */
import type { Space } from './frontmatter.js'
import { canonicalRef, HANDLE_KIND_SPACE } from './handles.js'

/** data-model.md section 3 wikilink grammar. */
export const WIKILINK_RE = /\[\[(?:(shared):)?([^[\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g

/** Remove fenced code blocks (``` / ~~~, up to 3 spaces of indent) and inline code spans. */
export function stripCode(body: string): string {
  const lines = body.split('\n')
  const out: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (m && (m[1] as string)[0] === fence[0] && (m[1] as string).length >= fence.length) fence = null
      out.push('')
      continue
    }
    if (m) {
      fence = m[1] as string
      out.push('')
      continue
    }
    out.push(line)
  }
  // inline code: a run of N backticks up to the next run of exactly N backticks
  return out.join('\n').replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, '')
}

export interface Wikilink {
  shared: boolean
  /** Canonical ref (data-model.md section 0) without the `shared:` prefix. */
  ref: string
  /** What `edges.dst_ref` stores: `ref`, or `shared:<ref>`. */
  dstRef: string
}

/** Distinct wikilinks of a body (code stripped first), in order of first appearance. */
export function extractWikilinks(body: string): Wikilink[] {
  const seen = new Set<string>()
  const out: Wikilink[] = []
  for (const m of stripCode(body).matchAll(WIKILINK_RE)) {
    const text = (m[2] ?? '').trim()
    if (text === '') continue
    const ref = canonicalRef(text)
    const shared = m[1] === 'shared'
    const dstRef = shared ? `shared:${ref}` : ref
    if (seen.has(dstRef)) continue
    seen.add(dstRef)
    out.push({ shared, ref, dstRef })
  }
  return out
}

/** What a canonical ref names: a handle form by number, or a slug. */
export type RefTarget =
  | { kind: 'memory' | 'doc' | 'decision' | 'library'; number: number }
  | { kind: 'slug'; slug: string }

const HANDLE_LETTER_KIND = { m: 'memory', d: 'doc', l: 'library' } as const

export function refTarget(ref: string): RefTarget {
  const adr = /^adr-(\d+)$/.exec(ref)
  if (adr) return { kind: 'decision', number: Number(adr[1]) }
  const h = /^([mdl])(\d+)$/.exec(ref)
  if (h) return { kind: HANDLE_LETTER_KIND[h[1] as 'm' | 'd' | 'l'], number: Number(h[2]) }
  return { kind: 'slug', slug: ref }
}

const SPACE_ORDER: Space[] = ['docs', 'decisions', 'memories']

/**
 * Slug precedence for a link from `srcSpace` (lower wins): a library page first for every source (0), then
 * the source's own space (1), then docs, decisions, memories (2 and up). The relative order of the three
 * older spaces is what it was before the library existed.
 */
export function spaceRank(srcSpace: Space, space: Space): number {
  if (space === 'library') return 0
  if (space === srcSpace) return 1
  return 2 + SPACE_ORDER.filter((s) => s !== srcSpace).indexOf(space)
}

export interface RefCandidate {
  space: Space
  number: number
  adrNumber: number | null
  slug: string
}

/**
 * The target of a canonical ref among the candidates of ONE project: handle forms by number, else the slug
 * with the precedence of `spaceRank`. The caller scopes the candidates (own project, or `_shared`). A
 * library source resolves like any other (ADR-0014: its outgoing links are a human choice at save time);
 * only the rank differs.
 */
export function pickRefTarget<T extends RefCandidate>(
  cands: Iterable<T>,
  srcSpace: Space,
  ref: string,
): T | null {
  const t = refTarget(ref)
  if (t.kind !== 'slug') {
    const space = HANDLE_KIND_SPACE[t.kind]
    for (const c of cands) {
      if (c.space === space && (t.kind === 'decision' ? c.adrNumber : c.number) === t.number) return c
    }
    return null
  }
  let best: T | null = null
  for (const c of cands) {
    if (c.slug !== t.slug) continue
    if (best === null || spaceRank(srcSpace, c.space) < spaceRank(srcSpace, best.space)) best = c
  }
  return best
}
