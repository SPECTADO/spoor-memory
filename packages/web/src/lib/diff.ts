/**
 * Line diff of two revision texts for `DiffView` (docs/design/web-ui.md §6), built on `diff` (jsdiff).
 * Unchanged runs longer than twice the context are folded into a `skip` block the user can expand.
 */
import { diffLines, diffWords } from 'diff'

export type DiffLineKind = 'add' | 'del' | 'same'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** 1-based line numbers in the old / new text (null on the side the line does not exist). */
  oldNo: number | null
  newNo: number | null
}

export type DiffBlock = { kind: 'lines'; lines: DiffLine[] } | { kind: 'skip'; lines: DiffLine[] }

function splitLines(value: string): string[] {
  const lines = value.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Every line of both texts tagged add / del / same, with line numbers. */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const out: DiffLine[] = []
  let o = 1
  let n = 1
  for (const part of diffLines(oldText, newText)) {
    for (const text of splitLines(part.value)) {
      if (part.added) out.push({ kind: 'add', text, oldNo: null, newNo: n++ })
      else if (part.removed) out.push({ kind: 'del', text, oldNo: o++, newNo: null })
      else out.push({ kind: 'same', text, oldNo: o++, newNo: n++ })
    }
  }
  return out
}

/**
 * Group lines into visible blocks and folded `skip` blocks: an unchanged run keeps `context` lines next to
 * each change; a run at the start or end keeps only the side next to a change.
 */
export function foldDiff(lines: DiffLine[], context = 3): DiffBlock[] {
  const blocks: DiffBlock[] = []
  const push = (kind: DiffBlock['kind'], ls: DiffLine[]) => {
    if (ls.length === 0) return
    const prev = blocks[blocks.length - 1]
    if (prev && prev.kind === kind && kind === 'lines') prev.lines.push(...ls)
    else blocks.push({ kind, lines: ls })
  }
  let i = 0
  while (i < lines.length) {
    if (lines[i]?.kind !== 'same') {
      let j = i
      while (j < lines.length && lines[j]?.kind !== 'same') j++
      push('lines', lines.slice(i, j))
      i = j
      continue
    }
    let j = i
    while (j < lines.length && lines[j]?.kind === 'same') j++
    const run = lines.slice(i, j)
    const atStart = i === 0
    const atEnd = j === lines.length
    const head = atStart ? 0 : context
    const tail = atEnd ? 0 : context
    if (run.length <= head + tail + 1 || (atStart && atEnd)) {
      push('lines', run)
    } else {
      push('lines', run.slice(0, head))
      push('skip', run.slice(head, run.length - tail))
      push('lines', run.slice(run.length - tail))
    }
    i = j
  }
  return blocks
}

export interface WordPart {
  kind: DiffLineKind
  text: string
}

/** Word-level parts of one changed line pair (the "word" toggle of DiffView). */
export function wordDiff(oldLine: string, newLine: string): WordPart[] {
  return diffWords(oldLine, newLine).map((p) => ({
    kind: p.added ? 'add' : p.removed ? 'del' : 'same',
    text: p.value,
  }))
}

export const hasChanges = (lines: DiffLine[]) => lines.some((l) => l.kind !== 'same')
