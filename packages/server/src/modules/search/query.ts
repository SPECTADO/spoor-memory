/**
 * Pure helpers of hybrid search (docs/design/search-and-digest.md section 4): the FTS query sanitiser,
 * reciprocal rank fusion, merging project and shared results, snippets. The SQL lives in service.ts.
 */
import { chunkContent } from './chunker.js'

export const RRF_K = 60
export const QUERY_MAX_CHARS = 500
const MAX_TOKENS = 16
const MAX_TOKEN_CHARS = 64
const SNIPPET_CHARS = 160

/** Step 1: trim, cap at 500 characters, NFC, lower-case. Unaccenting (step 2) happens in Postgres. */
export function normalizeQuery(q: string): string {
  return [...q.trim()].slice(0, QUERY_MAX_CHARS).join('').normalize('NFC').toLowerCase()
}

/** Step 3: tokens of the UNACCENTED text, at most 16 of at most 64 characters, first occurrence order. */
export function queryTokens(unaccented: string): string[] {
  const out: string[] = []
  for (const m of unaccented.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const tok = [...m[0]].slice(0, MAX_TOKEN_CHARS).join('')
    if (!out.includes(tok)) out.push(tok)
    if (out.length >= MAX_TOKENS) break
  }
  return out
}

/**
 * Step 4: the tsquery text. Tokens of three or more characters become prefix matches (`tok:*`), shorter
 * ones stay bare; OR-ed with ` | `. The output contains only `[\p{L}\p{N}_]`, `:*` and ` | `, so it is safe
 * for `to_tsquery('simple', $q)`. Empty string = no FTS branch.
 */
export function buildTsQuery(unaccented: string): string {
  return queryTokens(unaccented)
    .map((t) => ([...t].length >= 3 ? `${t}:*` : t))
    .join(' | ')
}

/** A ranked list (best first) of chunk hits, as produced by one branch. */
export interface RankedHit {
  itemId: string
  chunkId: number
}

export interface FusedHit {
  itemId: string
  chunkId: number
  score: number
}

/**
 * RRF over ranked lists (rank r starting at 1): score(chunk) = Σ 1 / (RRF_K + r); an item scores with its
 * best chunk. Mirrors the SQL of service.ts (unit-tested on hand-built lists). Sorted by score desc, then
 * chunk id.
 */
export function rrfFuse(lists: readonly (readonly RankedHit[])[]): FusedHit[] {
  const byChunk = new Map<number, FusedHit>()
  for (const list of lists) {
    list.forEach((h, i) => {
      const add = 1 / (RRF_K + i + 1)
      const cur = byChunk.get(h.chunkId)
      if (cur) cur.score += add
      else byChunk.set(h.chunkId, { itemId: h.itemId, chunkId: h.chunkId, score: add })
    })
  }
  const best = new Map<string, FusedHit>()
  for (const h of byChunk.values()) {
    const cur = best.get(h.itemId)
    if (!cur || h.score > cur.score || (h.score === cur.score && h.chunkId < cur.chunkId))
      best.set(h.itemId, h)
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.chunkId - b.chunkId)
}

/** Merge per-scope result lists by score; on a tie the project item wins; cut to `limit`. */
export function mergeScopes<T extends { score: number }>(project: T[], shared: T[], limit: number): T[] {
  const tagged = [
    ...project.map((h, i) => ({ h, scope: 0, i })),
    ...shared.map((h, i) => ({ h, scope: 1, i })),
  ]
  tagged.sort((a, b) => b.h.score - a.h.score || a.scope - b.scope || a.i - b.i)
  return tagged.slice(0, limit).map((t) => t.h)
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * The best chunk with its heading prefix removed, cut to 160 characters around the first query-token hit
 * (accent- and case-insensitive), or the first 160 characters when nothing matches. Single line.
 */
export function makeSnippet(chunkText: string, tokens: readonly string[]): string {
  const text = chunkContent(chunkText).replace(/\s+/g, ' ').trim()
  const chars = [...text]
  if (chars.length <= SNIPPET_CHARS) return text
  // NFD folding can change lengths; search the folded form char by char to map back to positions
  const folded = chars.map((c) => fold(c))
  let hit = -1
  for (const tok of tokens) {
    const t = fold(tok)
    if (t === '') continue
    for (let i = 0; i < folded.length; i++) {
      let j = i
      let acc = ''
      while (j < folded.length && acc.length < t.length) acc += folded[j++]
      if (acc.startsWith(t)) {
        hit = i
        break
      }
    }
    if (hit >= 0) break
  }
  if (hit < 0) return `${chars.slice(0, SNIPPET_CHARS - 1).join('')}…`
  let start = Math.max(0, hit - 40)
  const end = Math.min(chars.length, start + SNIPPET_CHARS - 2)
  start = Math.max(0, end - (SNIPPET_CHARS - 2))
  return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`
}
