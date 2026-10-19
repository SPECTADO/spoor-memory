import { describe, expect, it } from 'vitest'
import {
  CHUNK_MAX,
  chunkContent,
  chunkItem,
  HARD_MARGIN,
  itemText,
  splitBlocks,
  type TokenCounter,
  windowSplit,
} from './chunker.js'

/** Words + punctuation runs, plus 5 "special/prefix" tokens: roughly how e5 counts, deterministic. */
const counter: TokenCounter = {
  maxInputTokens: 512,
  countTokens: (s) => (s.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu) ?? []).length + 5,
}
const count = (s: string) => counter.countTokens(s)

const para = (n: number, word = 'lorem') => `${Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ')}.`

describe('splitBlocks', () => {
  it('keeps fenced code atomic, headings as own blocks with paths', () => {
    const body = [
      '# A',
      'intro text',
      '',
      '## B',
      '```ts',
      'const x = 1',
      '',
      'const y = 2',
      '```',
      'after',
    ].join('\n')
    const blocks = splitBlocks(body)
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'text', 'heading', 'code', 'text'])
    expect(blocks[3]?.text).toBe('```ts\nconst x = 1\n\nconst y = 2\n```')
    expect(blocks[3]?.path).toEqual(['A', 'B'])
    expect(blocks[2]?.path).toEqual(['A']) // a heading's path is its parents
  })
  it('pops the heading stack on a same-or-higher level heading', () => {
    const blocks = splitBlocks('# A\n## B\nx\n# C\ny')
    expect(blocks.at(-1)?.path).toEqual(['C'])
  })
})

describe('chunkItem', () => {
  it('a short item is one chunk: title, tags line, body', () => {
    const input = { title: 'Sessions live in Postgres', tags: ['auth', 'db'], body: 'Not JWT.' }
    expect(chunkItem(input, counter)).toEqual(['Sessions live in Postgres\ntags: auth, db\n\nNot JWT.'])
    expect(itemText({ title: 'T', tags: [], body: '' })).toBe('T')
  })

  it('never exceeds the hard limit and stays near CHUNK_MAX', () => {
    const body = Array.from({ length: 40 }, (_, i) => `## Section ${i}\n\n${para(30)} ${para(25)}`).join(
      '\n\n',
    )
    const chunks = chunkItem({ title: 'Big doc', tags: ['x'], body }, counter)
    expect(chunks.length).toBeGreaterThan(5)
    for (const c of chunks) {
      expect(count(c)).toBeLessThanOrEqual(counter.maxInputTokens - HARD_MARGIN)
      expect(count(c)).toBeLessThanOrEqual(CHUNK_MAX + 40) // join separators only
    }
  })

  it('every chunk starts with the heading-path prefix line', () => {
    const body = ['# Install', para(200), '## Docker', para(200), '## Kubernetes', para(200)].join('\n\n')
    const chunks = chunkItem({ title: 'Runbook', tags: [], body }, counter)
    for (const c of chunks) expect(c.split('\n')[0]?.startsWith('Runbook')).toBe(true)
    // a chunk that starts at a heading is prefixed with the heading's parents (the heading line follows)
    expect(chunks.some((c) => c.startsWith('Runbook › Install\n## Docker\n'))).toBe(true)
  })

  it('carries trailing whole blocks (<= 60 tokens) into the next chunk as overlap', () => {
    const body = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${para(20, `w${i}x`)}`).join('\n\n')
    const chunks = chunkItem({ title: 'Overlap', tags: [], body }, counter)
    expect(chunks.length).toBeGreaterThan(2)
    for (let i = 0; i + 1 < chunks.length; i++) {
      const prevLast = (chunks[i] as string).split('\n\n').at(-1) as string
      const next = chunks[i + 1] as string
      expect(next).toContain(prevLast)
      expect(next.indexOf(prevLast)).toBeLessThan(next.length / 2) // carried to the front, not repeated content
    }
  })

  it('a code fence <= 400 tokens is never split', () => {
    const code = ['```js', ...Array.from({ length: 30 }, (_, i) => `const v${i} = ${i}`), '```'].join('\n')
    expect(count(code)).toBeLessThan(CHUNK_MAX)
    const body = [para(150), code, para(150), para(150)].join('\n\n')
    const chunks = chunkItem({ title: 'Code', tags: [], body }, counter)
    expect(chunks.filter((c) => c.includes(code)).length).toBeGreaterThanOrEqual(1)
    for (const c of chunks) {
      const fences = (c.match(/^```/gm) ?? []).length
      expect(fences % 2).toBe(0)
    }
  })

  it('a code fence > 400 tokens splits on lines and each piece keeps its fences', () => {
    const code = [
      '~~~python',
      ...Array.from({ length: 300 }, (_, i) => `x_${i} = compute(${i}, ${i + 1})`),
      '~~~',
    ].join('\n')
    expect(count(code)).toBeGreaterThan(CHUNK_MAX)
    const chunks = chunkItem({ title: 'Long code', tags: [], body: code }, counter)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      const content = chunkContent(c)
      for (const piece of content.split('\n\n')) {
        if (!piece.startsWith('~~~')) continue
        expect(piece.startsWith('~~~python\n')).toBe(true)
        expect(piece.endsWith('\n~~~')).toBe(true)
      }
      expect(count(c)).toBeLessThanOrEqual(counter.maxInputTokens - HARD_MARGIN)
    }
  })

  it('an overlong sentence and an overlong word are window-split', () => {
    const sentence = Array.from({ length: 900 }, (_, i) => `tok${i}`).join(' ')
    const word = 'x'.repeat(5000)
    const chunks = chunkItem({ title: 'Windows', tags: [], body: `${sentence}\n\n${word}` }, counter)
    for (const c of chunks) expect(count(c)).toBeLessThanOrEqual(counter.maxInputTokens - HARD_MARGIN)
    expect(chunks.join(' ')).toContain('tok899')
  })

  it('respects a smaller model limit', () => {
    const small: TokenCounter = { ...counter, maxInputTokens: 128 }
    const chunks = chunkItem({ title: 'Small', tags: [], body: para(600) }, small)
    for (const c of chunks) expect(count(c)).toBeLessThanOrEqual(128 - HARD_MARGIN)
  })

  it('is deterministic', () => {
    const body = Array.from({ length: 20 }, () => para(40)).join('\n\n')
    expect(chunkItem({ title: 'D', tags: [], body }, counter)).toEqual(
      chunkItem({ title: 'D', tags: [], body }, counter),
    )
  })
})

describe('windowSplit', () => {
  it('windows overlap by about the requested amount and cover the text', () => {
    const text = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ')
    const wins = windowSplit(text, 100, 20, count)
    expect(wins.length).toBeGreaterThan(3)
    for (const w of wins) expect(count(w)).toBeLessThanOrEqual(100)
    expect(wins[0]?.startsWith('w0 ')).toBe(true)
    expect(wins.at(-1)?.endsWith('w299')).toBe(true)
    // overlap: the second window starts before the first one ends
    const firstEnd = wins[0]?.split(' ').at(-1) as string
    expect(wins[1]?.split(' ')).toContain(firstEnd)
  })
})

describe('chunkContent', () => {
  it('drops the prefix line and a tags line', () => {
    expect(chunkContent('Title › H\nbody text')).toBe('body text')
    expect(chunkContent('Title\ntags: a, b\n\nbody')).toBe('body')
  })
})
