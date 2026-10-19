/**
 * Body diff of two revision texts (web-ui.md §6): line diff with +/− markers (colour is not the only
 * signal), unchanged runs folded to 3 lines of context with a "Show N unchanged lines" expander, and a
 * toggle for word-level highlighting inside changed line pairs. `oldText = null` (first revision) shows the
 * new text whole, unmarked.
 */
import { useId, useMemo, useState } from 'react'
import {
  type DiffBlock,
  type DiffLine,
  foldDiff,
  hasChanges,
  lineDiff,
  type WordPart,
  wordDiff,
} from '../lib/diff'
import { cx } from './cx'
import { Checkbox } from './Field'

export interface DiffViewProps {
  oldText: string | null
  newText: string
  oldLabel?: string
  newLabel?: string
  context?: number
  className?: string
}

const rowTone: Record<DiffLine['kind'], string> = { add: 'bg-diff-add', del: 'bg-diff-del', same: '' }
const sign: Record<DiffLine['kind'], string> = { add: '+', del: '−', same: ' ' }
const srKind: Record<DiffLine['kind'], string> = { add: 'added', del: 'removed', same: '' }

/** Word parts for each line of a block: pairs the i-th removed line with the i-th added line of a change run. */
function pairWords(lines: DiffLine[]): (WordPart[] | null)[] {
  const out: (WordPart[] | null)[] = lines.map(() => null)
  let i = 0
  while (i < lines.length) {
    if (lines[i]?.kind !== 'del') {
      i++
      continue
    }
    let d = i
    while (d < lines.length && lines[d]?.kind === 'del') d++
    let a = d
    while (a < lines.length && lines[a]?.kind === 'add') a++
    const pairs = Math.min(d - i, a - d)
    for (let k = 0; k < pairs; k++) {
      const parts = wordDiff(lines[i + k]?.text ?? '', lines[d + k]?.text ?? '')
      out[i + k] = parts.filter((p) => p.kind !== 'add')
      out[d + k] = parts.filter((p) => p.kind !== 'del')
    }
    i = a
  }
  return out
}

function Line({ line, words }: { line: DiffLine; words: WordPart[] | null }) {
  return (
    <div className={cx('flex min-w-max', rowTone[line.kind])}>
      <span className="w-10 shrink-0 pr-2 text-right text-muted select-none" aria-hidden="true">
        {line.oldNo ?? ''}
      </span>
      <span className="w-10 shrink-0 pr-2 text-right text-muted select-none" aria-hidden="true">
        {line.newNo ?? ''}
      </span>
      <span className="w-4 shrink-0 text-center select-none" aria-hidden="true">
        {sign[line.kind]}
      </span>
      {line.kind !== 'same' && <span className="sr-only">{srKind[line.kind]}: </span>}
      <span className="pr-3 whitespace-pre-wrap">
        {words
          ? words.map((w, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: parts of one line, never reordered
                key={i}
                className={cx(
                  w.kind === 'add' && 'bg-diff-add-strong',
                  w.kind === 'del' && 'bg-diff-del-strong line-through decoration-1',
                )}
              >
                {w.text}
              </span>
            ))
          : line.text || ' '}
      </span>
    </div>
  )
}

export function DiffView({
  oldText,
  newText,
  oldLabel = 'Before',
  newLabel = 'After',
  context = 3,
  className,
}: DiffViewProps) {
  const [wordLevel, setWordLevel] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const labelId = useId()
  const lines = useMemo(() => (oldText === null ? null : lineDiff(oldText, newText)), [oldText, newText])
  const blocks: DiffBlock[] = useMemo(() => (lines ? foldDiff(lines, context) : []), [lines, context])

  if (lines === null) {
    return (
      <pre
        className={cx(
          'overflow-x-auto rounded-md border border-border bg-surface p-3 font-mono text-xs whitespace-pre-wrap',
          className,
        )}
      >
        {newText}
      </pre>
    )
  }

  return (
    <div className={cx('space-y-2', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <p id={labelId}>
          <span className="font-medium text-fg">−</span> {oldLabel} ·{' '}
          <span className="font-medium text-fg">+</span> {newLabel}
        </p>
        <Checkbox
          label="Highlight changed words"
          checked={wordLevel}
          onChange={(e) => setWordLevel(e.target.checked)}
        />
      </div>
      {!hasChanges(lines) ? (
        <p className="rounded-md border border-border px-3 py-2 text-sm text-muted">The text is identical.</p>
      ) : (
        // biome-ignore lint/a11y/useSemanticElements: a labelled group of diff lines, not a form fieldset
        <div
          role="group"
          aria-labelledby={labelId}
          className="overflow-x-auto rounded-md border border-border font-mono text-xs leading-5"
        >
          {blocks.map((b, bi) => {
            if (b.kind === 'skip' && !expanded.has(bi)) {
              return (
                <button
                  // biome-ignore lint/suspicious/noArrayIndexKey: blocks are derived, index is their identity
                  key={bi}
                  type="button"
                  onClick={() => setExpanded((s) => new Set(s).add(bi))}
                  className="block w-full bg-surface px-3 py-1 text-left text-muted hover:bg-surface-2"
                >
                  Show {b.lines.length} unchanged line{b.lines.length === 1 ? '' : 's'}
                </button>
              )
            }
            const words = wordLevel ? pairWords(b.lines) : null
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks are derived, index is their identity
              <div key={bi}>
                {b.lines.map((l, li) => (
                  <Line key={`${l.oldNo}-${l.newNo}`} line={l} words={words?.[li] ?? null} />
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
