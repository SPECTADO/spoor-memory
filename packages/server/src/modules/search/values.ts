/**
 * The values guard of the near-duplicate check (search-and-digest.md section 5, ADR-0025). e5 cosine barely
 * sees numbers and identifiers, so "admin API: 60 requests/min" and "public API: 600 requests/min" score
 * like paraphrases. Two texts whose values disagree are different claims, never duplicates.
 */

const CODE_SPAN = /`([^`\n]{1,80})`/g
const QUOTED = /["“„]([^"“”„\n]{1,80})["”“]/g
const NUMBER = /\d+(?:[.,:]\d+)*/g
/** Words joined by `_ . / :` (env vars, paths, hosts, `a.b` keys, URLs) or camelCase; `-` is ordinary prose. */
const IDENT = /[A-Za-z][A-Za-z0-9]*(?:[_./:]+[A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*/g
const NOT_IDENT = new Set(['e.g', 'i.e', 'etc', 'vs'])

/** The values a text states: numbers, identifiers, code spans and quoted strings, lower-cased. */
export function factValues(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(CODE_SPAN)) out.add((m[1] as string).trim().toLowerCase())
  for (const m of text.matchAll(QUOTED)) out.add((m[1] as string).trim().toLowerCase())
  for (const m of text.matchAll(NUMBER)) out.add(m[0])
  for (const m of text.matchAll(IDENT)) {
    const v = m[0].toLowerCase()
    if (!NOT_IDENT.has(v)) out.add(v)
  }
  out.delete('')
  return out
}

/**
 * Values each side states that the other does not, or `null` when one side's values are a subset of the
 * other's (an elaboration or a rewording, which can still be a duplicate). Only a two-sided difference
 * (`60` vs `600`) makes the texts different claims.
 */
export function differentValues(
  probe: string,
  existing: string,
): { new: string[]; existing: string[] } | null {
  const a = factValues(probe)
  const b = factValues(existing)
  const onlyA = [...a].filter((v) => !b.has(v))
  const onlyB = [...b].filter((v) => !a.has(v))
  return onlyA.length > 0 && onlyB.length > 0 ? { new: onlyA, existing: onlyB } : null
}
