import { describe, expect, it } from 'vitest'
import { foldDiff, lineDiff, wordDiff } from './diff'

const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${i + from}`).join('\n')

describe('lineDiff', () => {
  it('numbers lines on both sides', () => {
    const d = lineDiff('a\nb\nc\n', 'a\nB\nc\n')
    expect(d.map((l) => [l.kind, l.text, l.oldNo, l.newNo])).toEqual([
      ['same', 'a', 1, 1],
      ['del', 'b', 2, null],
      ['add', 'B', null, 2],
      ['same', 'c', 3, 3],
    ])
  })
})

describe('foldDiff', () => {
  it('folds long unchanged runs to 3 lines of context', () => {
    const old = lines(20)
    const neu = old.replace('line 10', 'line ten')
    const blocks = foldDiff(lineDiff(old, neu), 3)
    expect(blocks.map((b) => [b.kind, b.lines.length])).toEqual([
      ['skip', 6],
      ['lines', 3 + 2 + 3],
      ['skip', 7],
    ])
    expect(blocks[1]?.lines[0]?.text).toBe('line 7')
  })

  it('keeps short runs and identical texts whole', () => {
    expect(foldDiff(lineDiff(lines(5), lines(5)), 3).map((b) => b.kind)).toEqual(['lines'])
    const blocks = foldDiff(lineDiff('a\nb\nc', 'a\nb\nC'), 3)
    expect(blocks).toHaveLength(1)
  })
})

describe('wordDiff', () => {
  it('marks changed words', () => {
    expect(wordDiff('the old value', 'the new value')).toEqual([
      { kind: 'same', text: 'the ' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' },
      { kind: 'same', text: ' value' },
    ])
  })
})
