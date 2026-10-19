/**
 * Anchor matching (docs/design/search-and-digest.md section 8). Pure, no dependency. The ONE normaliser,
 * validator and matcher: every server write path (REST, MCP, push, import), the digest and the `?anchor=`
 * list filter, and the SPA use it, so a stored anchor is exactly one the digest can match.
 *
 * Anchors (repo paths, directories or globs stored on items) are matched against the `files` an agent sends to
 * `spoor_context`. Globs are never compiled to backtracking RegExps: a pattern is parsed once into path
 * segments (cached), `*` / `?` / classes are matched inside one segment with the two-pointer wildcard
 * algorithm, and `**` recurses over segments with memoisation on (pattern segment, path segment).
 *
 * Strength: exact path 3 > glob 2 > directory prefix 1 (segment boundary).
 */

export const ANCHOR_MAX_LENGTH = 256
const MAX_STARS = 4
const MAX_ALTERNATIVES = 4
const GLOB_CHARS = /[*?[{\\]/

export type AnchorStrength = 0 | 1 | 2 | 3

/**
 * Normalise an anchor or a `files` entry: POSIX separators (only for strings without glob syntax, where `\`
 * is an escape), strip leading `./` and `/`, collapse `//`. Returns null for an invalid path: empty, NUL,
 * longer than 256 characters, or a `..` segment. Case is kept (matching is case-sensitive). A trailing `/`
 * (directory) is kept.
 */
export function normalizePath(input: string): string | null {
  if (input.length === 0 || input.length > ANCHOR_MAX_LENGTH || input.includes('\0')) return null
  let s = input.trim()
  if (!/[*?[{]/.test(s)) s = s.replace(/\\/g, '/')
  s = s.replace(/\/{2,}/g, '/')
  for (;;) {
    if (s.startsWith('./')) s = s.slice(2)
    else if (s.startsWith('/')) s = s.slice(1)
    else break
  }
  if (s === '' || s === '.') return null
  const segments = s.split('/')
  if (segments.some((seg) => seg === '..')) return null
  return s
}

export function isGlob(anchor: string): boolean {
  return GLOB_CHARS.test(anchor)
}

// ---- parsing ---------------------------------------------------------------------------------------

type Tok =
  | { k: 'lit'; c: string }
  | { k: 'any1' } // ?
  | { k: 'star' } // *
  | { k: 'cls'; neg: boolean; items: (string | [string, string])[] }

type Segment = { k: 'globstar' } | { k: 'seg'; toks: Tok[] }

interface Compiled {
  alternatives: Segment[][]
}

export class AnchorSyntaxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnchorSyntaxError'
  }
}

/** Split on the top-level `{a,b}` groups (no nesting) into at most MAX_ALTERNATIVES full patterns. */
function expandBraces(pattern: string): string[] {
  let out = ['']
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i] as string
    if (c === '\\' && i + 1 < pattern.length) {
      out = out.map((o) => o + c + (pattern[i + 1] as string))
      i += 2
      continue
    }
    if (c === '[') {
      // copy a class verbatim (a `{` inside a class is literal)
      const end = classEnd(pattern, i)
      const text = end < 0 ? c : pattern.slice(i, end + 1)
      out = out.map((o) => o + text)
      i += text.length
      continue
    }
    if (c === '{') {
      const close = pattern.indexOf('}', i + 1)
      if (close < 0) throw new AnchorSyntaxError('unclosed "{"')
      const body = pattern.slice(i + 1, close)
      if (body.includes('{')) throw new AnchorSyntaxError('nested "{" is not supported')
      const alts = body.split(',')
      const next: string[] = []
      for (const o of out) for (const a of alts) next.push(o + a)
      if (next.length > MAX_ALTERNATIVES) {
        throw new AnchorSyntaxError(`more than ${MAX_ALTERNATIVES} "{…}" alternatives`)
      }
      out = next
      i = close + 1
      continue
    }
    if (c === '}') throw new AnchorSyntaxError('unmatched "}"')
    out = out.map((o) => o + c)
    i++
  }
  return out
}

/** Index of the `]` closing the class that starts at `start`, or -1 (then `[` is a literal). */
function classEnd(p: string, start: number): number {
  let i = start + 1
  if (p[i] === '!' || p[i] === '^') i++
  if (p[i] === ']') i++ // `[]abc]`: a leading `]` is literal
  for (; i < p.length; i++) {
    if (p[i] === '\\') {
      i++
      continue
    }
    if (p[i] === '/') return -1
    if (p[i] === ']') return i
  }
  return -1
}

function parseSegment(text: string): Segment {
  if (text === '**') return { k: 'globstar' }
  const toks: Tok[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (c === '\\') {
      if (i + 1 < text.length) toks.push({ k: 'lit', c: text[++i] as string })
      else toks.push({ k: 'lit', c })
    } else if (c === '*') {
      // `**` inside a segment (`a**b`) behaves like one `*`; consecutive stars collapse
      if (toks[toks.length - 1]?.k !== 'star') toks.push({ k: 'star' })
    } else if (c === '?') {
      toks.push({ k: 'any1' })
    } else if (c === '[') {
      const end = classEnd(text, i)
      if (end < 0) {
        toks.push({ k: 'lit', c })
        continue
      }
      let body = text.slice(i + 1, end)
      let neg = false
      if (body.startsWith('!') || body.startsWith('^')) {
        neg = true
        body = body.slice(1)
      }
      // unescape into a char list, remembering which `-` are literal
      const chars: { c: string; esc: boolean }[] = []
      for (let j = 0; j < body.length; j++) {
        if (body[j] === '\\' && j + 1 < body.length) chars.push({ c: body[++j] as string, esc: true })
        else chars.push({ c: body[j] as string, esc: false })
      }
      const items: (string | [string, string])[] = []
      for (let j = 0; j < chars.length; j++) {
        const lo = chars[j] as { c: string }
        const dash = chars[j + 1]
        const hi = chars[j + 2]
        if (dash && hi && dash.c === '-' && !dash.esc) {
          items.push([lo.c, hi.c])
          j += 2
        } else {
          items.push(lo.c)
        }
      }
      toks.push({ k: 'cls', neg, items })
      i = end
    } else {
      toks.push({ k: 'lit', c })
    }
  }
  return { k: 'seg', toks }
}

/** Count `*` and `**` tokens of an anchor (outside classes and escapes); `**` counts once. */
function countStars(pattern: string): number {
  let n = 0
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '[') {
      const end = classEnd(pattern, i)
      if (end > 0) i = end
      continue
    }
    if (c === '*') {
      n++
      while (pattern[i + 1] === '*') i++
    }
  }
  return n
}

const cache = new Map<string, Compiled>()
const CACHE_MAX = 4096

/** Parse once, cached. Throws AnchorSyntaxError for malformed brace groups. */
function compile(pattern: string): Compiled {
  const hit = cache.get(pattern)
  if (hit) return hit
  const alternatives = expandBraces(pattern).map((alt) => {
    const segs: Segment[] = []
    for (const s of alt.split('/')) {
      const seg = parseSegment(s)
      // repeated `**` segments are one
      if (seg.k === 'globstar' && segs[segs.length - 1]?.k === 'globstar') continue
      segs.push(seg)
    }
    // a trailing empty segment (pattern ends with `/`) is dropped: `src/**/` matches like `src/**`
    if (segs.length > 1) {
      const last = segs[segs.length - 1]
      if (last?.k === 'seg' && last.toks.length === 0) segs.pop()
    }
    return segs
  })
  const out = { alternatives }
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(pattern, out)
  return out
}

// ---- matching -------------------------------------------------------------------------------------

function tokMatches(t: Tok, ch: string): boolean {
  switch (t.k) {
    case 'lit':
      return t.c === ch
    case 'any1':
      return true
    case 'cls': {
      let hit = false
      for (const it of t.items) {
        if (typeof it === 'string' ? it === ch : ch >= it[0] && ch <= it[1]) {
          hit = true
          break
        }
      }
      return hit !== t.neg
    }
    case 'star':
      return false
  }
}

/**
 * One segment: `*` matches any run (no `/` can occur inside a segment), `?` one character, classes one
 * character. Classic two-pointer wildcard matching with a single backtrack point: O(text × tokens).
 */
function matchSegment(toks: Tok[], text: string): boolean {
  const s = [...text]
  let p = 0
  let t = 0
  let starP = -1
  let starT = 0
  while (t < s.length) {
    const tok = toks[p]
    if (tok !== undefined && tok.k !== 'star' && tokMatches(tok, s[t] as string)) {
      p++
      t++
    } else if (tok?.k === 'star') {
      starP = p++
      starT = t
    } else if (starP >= 0) {
      p = starP + 1
      t = ++starT
    } else {
      return false
    }
  }
  while (toks[p]?.k === 'star') p++
  return p === toks.length
}

/** Segment-by-segment matching; `**` spans zero or more path segments, memoised on (pi, si). */
function matchSegments(pat: Segment[], path: string[]): boolean {
  const memo = new Map<number, boolean>()
  const width = path.length + 1
  const go = (pi: number, si: number): boolean => {
    const key = pi * width + si
    const known = memo.get(key)
    if (known !== undefined) return known
    let res: boolean
    const seg = pat[pi]
    if (seg === undefined) {
      res = si === path.length
    } else if (seg.k === 'globstar') {
      res = go(pi + 1, si) || (si < path.length && go(pi, si + 1))
    } else {
      res = si < path.length && matchSegment(seg.toks, path[si] as string) && go(pi + 1, si + 1)
    }
    memo.set(key, res)
    return res
  }
  return go(0, 0)
}

/** Full-path glob match (both normalised). A malformed glob never matches. */
export function globMatches(pattern: string, path: string): boolean {
  let compiled: Compiled
  try {
    compiled = compile(pattern)
  } catch {
    return false
  }
  const parts = path.replace(/\/$/, '').split('/')
  return compiled.alternatives.some((alt) => matchSegments(alt, parts))
}

/** Text before the first glob character (unescaped). */
export function staticPrefix(pattern: string): string {
  const m = /[*?[{\\]/.exec(pattern)
  return m ? pattern.slice(0, m.index) : pattern
}

/**
 * Strength of one (anchor, file) pair, both already normalised. A `file` ending with `/` is a directory: it
 * matches an anchor inside it (or equal to it), or a glob whose static prefix lies inside it, with strength 1.
 */
export function matchAnchor(anchor: string, file: string): AnchorStrength {
  const glob = isGlob(anchor)
  if (file.endsWith('/')) {
    if (glob) return staticPrefix(anchor).startsWith(file) ? 1 : 0
    const a = anchor.endsWith('/') ? anchor : `${anchor}/`
    return a.startsWith(file) ? 1 : 0
  }
  if (glob) return globMatches(anchor, file) ? 2 : 0
  if (anchor.endsWith('/')) return file.startsWith(anchor) ? 1 : 0
  if (file === anchor) return 3
  return file.startsWith(`${anchor}/`) ? 1 : 0
}

export interface AnchorScore {
  strength: AnchorStrength
  /** Number of distinct files matched by any anchor (tie-break). */
  matchedFiles: number
  /** The first anchor (in item order) reaching `strength`; shown as ` @<anchor>` in the digest. */
  anchor: string | null
}

/**
 * Item score = max strength over (anchor × file) pairs; ties go to more matched files. Both lists must be
 * normalised already (use normalizeFiles for agent input).
 */
export function scoreAnchors(anchors: readonly string[], files: readonly string[]): AnchorScore {
  let strength: AnchorStrength = 0
  let best: string | null = null
  let matched = 0
  for (const f of files) {
    let fileHit = false
    for (const a of anchors) {
      const s = matchAnchor(a, f)
      if (s > 0) fileHit = true
      if (s > strength) {
        strength = s
        best = a
      } else if (s > 0 && s === strength && best !== null && anchors.indexOf(a) < anchors.indexOf(best)) {
        best = a
      }
    }
    if (fileHit) matched++
  }
  return { strength, matchedFiles: matched, anchor: best }
}

/**
 * A file path as a client sends it (`files` of spoor_context, `?anchor=`, a pushed `source_path`): a file is
 * never a glob, so `\` always becomes `/` (unlike an anchor, where `\` in glob syntax is an escape). Then
 * the rules of `normalizePath`; null when invalid.
 */
export function normalizeFilePath(input: string): string | null {
  return normalizePath(input.replace(/\\/g, '/'))
}

/** The best strength of any (normalised) anchor of an item for one (normalised) file. */
export function bestStrength(anchors: readonly string[], file: string): AnchorStrength {
  let best: AnchorStrength = 0
  for (const a of anchors) best = Math.max(best, matchAnchor(a, file)) as AnchorStrength
  return best
}

/** Agent-supplied `files`: normalised as file paths, invalid entries dropped, duplicates removed, at most `max`. */
export function normalizeFiles(files: readonly string[], max = 200): string[] {
  const out = new Set<string>()
  for (const f of files) {
    if (out.size >= max) break
    const n = normalizeFilePath(f)
    if (n !== null) out.add(n)
  }
  return [...out]
}

export type AnchorValidation = { ok: true; anchor: string } | { ok: false; reason: string }

/**
 * Anchor validation on every write path: normalise, collapse repeated `**` segments, reject runs of three or
 * more `*`, more than 4 `*`/`**` tokens, more than 4 `{…}` alternatives, nested or unbalanced braces.
 */
export function validateAnchor(raw: string): AnchorValidation {
  const n = normalizePath(raw)
  if (n === null) {
    return { ok: false, reason: 'must be a repo-relative path of 1 to 256 characters without ".." segments' }
  }
  if (/(?<!\\)\*{3,}/.test(n)) return { ok: false, reason: 'three or more consecutive "*" are not allowed' }
  // collapse `**/**/…` runs to one `**`
  const collapsed = n.replace(/(^|\/)\*\*(?:\/\*\*)+(?=\/|$)/g, '$1**')
  if (countStars(collapsed) > MAX_STARS) {
    return { ok: false, reason: `at most ${MAX_STARS} "*" or "**" per anchor` }
  }
  try {
    compile(collapsed)
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
  return { ok: true, anchor: collapsed }
}
