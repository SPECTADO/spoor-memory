/**
 * Key-level diff of two revision frontmatters (web-ui.md §6 `FrontmatterDiff`): added, removed and changed
 * keys; `tags` and `anchors` compared as sets. `spoor_id` and `title` are left out (the title is shown inline).
 */
export type FmChange =
  | { key: string; kind: 'added'; value: unknown }
  | { key: string; kind: 'removed'; value: unknown }
  | { key: string; kind: 'changed'; from: unknown; to: unknown }
  | { key: string; kind: 'set'; added: string[]; removed: string[] }

const SKIP = new Set(['spoor_id', 'title'])
const SETS = new Set(['tags', 'anchors'])

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

export function frontmatterDiff(
  oldFm: Record<string, unknown> | null | undefined,
  newFm: Record<string, unknown> | null | undefined,
): FmChange[] {
  const a = oldFm ?? {}
  const b = newFm ?? {}
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !SKIP.has(k)).sort()
  const out: FmChange[] = []
  for (const key of keys) {
    const inA = key in a && a[key] !== undefined
    const inB = key in b && b[key] !== undefined
    if (SETS.has(key)) {
      const sa = strings(a[key])
      const sb = strings(b[key])
      const added = sb.filter((x) => !sa.includes(x))
      const removed = sa.filter((x) => !sb.includes(x))
      if (added.length || removed.length) out.push({ key, kind: 'set', added, removed })
    } else if (inA && !inB) {
      out.push({ key, kind: 'removed', value: a[key] })
    } else if (!inA && inB) {
      out.push({ key, kind: 'added', value: b[key] })
    } else if (inA && inB && !same(a[key], b[key])) {
      out.push({ key, kind: 'changed', from: a[key], to: b[key] })
    }
  }
  return out
}

/** A frontmatter value as short text. */
export const fmText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v))
