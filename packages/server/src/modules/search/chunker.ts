/**
 * Markdown-aware chunker (docs/design/search-and-digest.md section 1). Pure: the token counter is injected
 * (the provider's tokenizer, `EmbeddingProvider.countTokens`), so the same code serves the e5 tokenizer, the
 * remote providers' char-based estimate and the test fake.
 *
 * Text of an item: the title, a `tags: a, b` line when tags exist, then the body (frontmatter never). Every
 * chunk starts with a prefix line `<title> › <h1> › <h2>…` (the heading path at its first block), which is
 * counted in the budget. Items of at most SINGLE_MAX tokens are one chunk.
 */

export const SINGLE_MAX = 450
export const CHUNK_MAX = 400
export const CHUNK_OVERLAP = 60
/** Every chunk stays at most `maxInputTokens - HARD_MARGIN` (496 for e5, which truncates silently at 512). */
export const HARD_MARGIN = 16
export const MAX_CHUNKS = 500
const PATH_SEP = ' › '

export interface TokenCounter {
  countTokens(text: string): number
  readonly maxInputTokens: number
}

export interface ChunkInput {
  title: string
  tags: readonly string[]
  body: string
}

type BlockKind = 'text' | 'code' | 'heading'

interface Block {
  kind: BlockKind
  text: string
  /** Heading path in effect for this block (for a heading: its parents). */
  path: string[]
  tokens: number
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const SENTENCE_SPLIT = /(?<=[.!?…])\s+/

/** Split a Markdown body into blocks: fenced code, ATX headings, blank-line separated paragraphs. */
export function splitBlocks(body: string): { kind: BlockKind; text: string; path: string[] }[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const out: { kind: BlockKind; text: string; path: string[] }[] = []
  const stack: { level: number; text: string }[] = []
  const path = () => stack.map((s) => s.text)
  let para: string[] = []
  const flush = () => {
    if (para.length > 0) {
      const text = para.join('\n').trim()
      if (text !== '') out.push({ kind: 'text', text, path: path() })
      para = []
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const fence = FENCE_OPEN.exec(line)
    if (fence) {
      flush()
      const marker = fence[1] as string
      const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)
      const buf = [line]
      let j = i + 1
      for (; j < lines.length; j++) {
        buf.push(lines[j] as string)
        if (close.test(lines[j] as string)) break
      }
      out.push({ kind: 'code', text: buf.join('\n'), path: path() })
      i = j
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      flush()
      const level = (h[1] as string).length
      const text = (h[2] ?? '').trim()
      while (stack.length > 0 && (stack[stack.length - 1] as { level: number }).level >= level) stack.pop()
      out.push({ kind: 'heading', text: line.trim(), path: path() })
      if (text !== '') stack.push({ level, text })
      continue
    }
    if (line.trim() === '') flush()
    else para.push(line)
  }
  flush()
  return out
}

function prefixLine(title: string, path: string[]): string {
  return [title, ...path].join(PATH_SEP)
}

/**
 * Split `text` into windows of at most `budget` tokens with about `overlap` tokens of overlap, cutting at
 * whitespace where possible (character level only inside a single overlong word). Uses binary search over
 * text positions with the counter, so it works for any tokenizer without decoding token ids.
 */
export function windowSplit(
  text: string,
  budget: number,
  overlap: number,
  count: (s: string) => number,
): string[] {
  // units: words with their trailing whitespace; an overlong word is cut into character pieces
  const units: string[] = []
  for (const w of text.split(/(?<=\s)/)) {
    if (count(w) <= budget) {
      units.push(w)
      continue
    }
    const chars = [...w]
    let start = 0
    while (start < chars.length) {
      let lo = start + 1
      let hi = chars.length
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        if (count(chars.slice(start, mid).join('')) <= budget) lo = mid
        else hi = mid - 1
      }
      units.push(chars.slice(start, lo).join(''))
      start = lo
    }
  }
  const join = (a: number, b: number) => units.slice(a, b).join('')
  const out: string[] = []
  let i = 0
  while (i < units.length) {
    // largest j with count(units[i..j)) <= budget (at least one unit)
    let lo = i + 1
    let hi = units.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (count(join(i, mid)) <= budget) lo = mid
      else hi = mid - 1
    }
    const j = lo
    const piece = join(i, j).trim()
    if (piece !== '') out.push(piece)
    if (j >= units.length) break
    // next window starts at the smallest k in (i, j] whose tail units[k..j) fits in `overlap`
    let klo = i + 1
    let khi = j
    while (klo < khi) {
      const mid = Math.floor((klo + khi) / 2)
      if (count(join(mid, j)) <= overlap) khi = mid
      else klo = mid + 1
    }
    i = Math.max(klo, i + 1)
  }
  return out
}

/** Re-wrap pieces of an oversized fenced code block with its own fences, split on line boundaries. */
function splitCode(text: string, budget: number, count: (s: string) => number): string[] {
  const lines = text.split('\n')
  const open = lines[0] as string
  const last = lines[lines.length - 1] as string
  const fenceChar = (FENCE_OPEN.exec(open)?.[1] ?? '```') as string
  const closed =
    lines.length > 1 && new RegExp(`^ {0,3}${fenceChar[0] === '`' ? '`' : '~'}{3,}[ \\t]*$`).test(last)
  const close = closed ? last : fenceChar
  const inner = lines.slice(1, closed ? -1 : undefined)
  const wrapCost = count(`${open}\n${close}`)
  const innerBudget = Math.max(8, budget - wrapCost)
  const out: string[] = []
  let cur: string[] = []
  const emit = () => {
    if (cur.length > 0) out.push([open, ...cur, close].join('\n'))
    cur = []
  }
  for (const line of inner) {
    if (count(line) > innerBudget) {
      emit()
      for (const w of windowSplit(line, innerBudget, 0, count)) out.push([open, w, close].join('\n'))
      continue
    }
    if (cur.length > 0 && count([...cur, line].join('\n')) > innerBudget) emit()
    cur.push(line)
  }
  emit()
  return out
}

/** Sentences packed into pieces <= budget; an overlong sentence becomes token windows with overlap. */
function splitText(text: string, budget: number, count: (s: string) => number): string[] {
  const out: string[] = []
  let cur = ''
  for (const s of text.split(SENTENCE_SPLIT)) {
    if (count(s) > budget) {
      if (cur !== '') out.push(cur)
      cur = ''
      out.push(...windowSplit(s, budget, CHUNK_OVERLAP, count))
      continue
    }
    const next = cur === '' ? s : `${cur} ${s}`
    if (cur !== '' && count(next) > budget) {
      out.push(cur)
      cur = s
    } else {
      cur = next
    }
  }
  if (cur !== '') out.push(cur)
  return out
}

function lastSentence(text: string): string {
  const parts = text.split(SENTENCE_SPLIT)
  return (parts[parts.length - 1] ?? '').trim()
}

export class ChunkLimitError extends Error {
  constructor(tokens: number, limit: number) {
    super(`chunk of ${tokens} tokens exceeds the hard limit of ${limit}`)
    this.name = 'ChunkLimitError'
  }
}

/** The item text for a single-chunk item: title, tags line, body. */
export function itemText(input: ChunkInput): string {
  const tagLine = input.tags.length > 0 ? `\ntags: ${input.tags.join(', ')}` : ''
  const body = input.body.trim()
  return `${input.title}${tagLine}${body !== '' ? `\n\n${body}` : ''}`
}

/**
 * Chunk an item. Every returned chunk is at most `counter.maxInputTokens - HARD_MARGIN` tokens (asserted:
 * ChunkLimitError), at most MAX_CHUNKS chunks. Deterministic for a given counter.
 */
export function chunkItem(input: ChunkInput, counter: TokenCounter): string[] {
  const count = (s: string) => counter.countTokens(s)
  const hard = counter.maxInputTokens - HARD_MARGIN
  const single = Math.min(SINGLE_MAX, hard)
  const max = Math.min(CHUNK_MAX, hard)

  const whole = itemText(input)
  if (count(whole) <= single) return [whole]

  // blocks with token counts; the tags line is a block of its own at the start
  const raw = splitBlocks(input.body)
  if (input.tags.length > 0) raw.unshift({ kind: 'text', text: `tags: ${input.tags.join(', ')}`, path: [] })

  // split oversized blocks so that prefix + block always fits
  const blocks: Block[] = []
  for (const b of raw) {
    const prefixCost = count(prefixLine(input.title, b.path))
    const budget = Math.max(16, max - prefixCost)
    const t = count(b.text)
    if (t <= budget) {
      blocks.push({ ...b, tokens: t })
      continue
    }
    const pieces = b.kind === 'code' ? splitCode(b.text, budget, count) : splitText(b.text, budget, count)
    for (const p of pieces) blocks.push({ kind: b.kind, text: p, path: b.path, tokens: count(p) })
  }

  const chunks: string[] = []
  let cur: Block[] = []
  let carried = 0 // how many leading blocks of `cur` are overlap from the previous chunk
  const render = (bs: Block[]) => {
    const head = prefixLine(input.title, (bs[0] as Block).path)
    return `${head}\n${bs.map((b) => b.text).join('\n\n')}`
  }
  const cost = (bs: Block[]) =>
    count(prefixLine(input.title, (bs[0] as Block).path)) + bs.reduce((n, b) => n + b.tokens, 0)

  const emit = () => {
    if (cur.length === 0 || carried === cur.length) return
    chunks.push(render(cur))
    // carry trailing whole blocks totalling <= OVERLAP; else the last sentence of the last block
    const keep: Block[] = []
    let k = 0
    for (let i = cur.length - 1; i >= 0; i--) {
      const b = cur[i] as Block
      if (k + b.tokens > CHUNK_OVERLAP) break
      keep.unshift(b)
      k += b.tokens
    }
    if (keep.length === 0) {
      const last = cur[cur.length - 1] as Block
      if (last.kind === 'text') {
        const s = lastSentence(last.text)
        const t = s === '' ? Number.POSITIVE_INFINITY : count(s)
        if (s !== last.text && t <= CHUNK_OVERLAP) keep.push({ ...last, text: s, tokens: t })
      }
    }
    cur = keep
    carried = keep.length
  }

  for (const b of blocks) {
    if (cur.length > 0 && cost([...cur, b]) > max) {
      if (carried === cur.length) {
        // the overlap alone plus this block does not fit: drop the overlap
        cur = []
        carried = 0
      } else {
        emit()
        if (cur.length > 0 && cost([...cur, b]) > max) {
          cur = []
          carried = 0
        }
      }
    }
    cur.push(b)
  }
  emit()

  const out = chunks.slice(0, MAX_CHUNKS)
  for (const c of out) {
    const t = count(c)
    if (t > hard) throw new ChunkLimitError(t, hard)
  }
  return out
}

/** The chunk text without its heading-prefix line (and a leading `tags:` line): the snippet source. */
export function chunkContent(chunk: string): string {
  const nl = chunk.indexOf('\n')
  let rest = nl < 0 ? '' : chunk.slice(nl + 1)
  if (rest.startsWith('tags: ')) {
    const n2 = rest.indexOf('\n')
    rest = n2 < 0 ? '' : rest.slice(n2 + 1)
  }
  return rest.trim()
}
