import { describe, expect, it } from 'vitest'
import { adrNumberOf, insertSpoorId, padAdr, readSpoorId, rewriteAdrH1, setAdrNumber } from './writeback.js'

const ID = '11111111-2222-4333-8444-555555555555'

describe('insertSpoorId', () => {
  it('inserts as the first key, keeping comments, key order, quoting and body bytes', () => {
    const body = '# Title\n\nBody with `code`  and trailing spaces  \n\n---\nnot frontmatter\n'
    const src = `---\n# a comment\ntitle: "Quoted: title"\nstatus: accepted # inline\ntags: [a, b]\n---\n${body}`
    const out = insertSpoorId(src, ID)
    expect(out).toBe(
      `---\nspoor_id: ${ID}\n# a comment\ntitle: "Quoted: title"\nstatus: accepted # inline\ntags: [a, b]\n---\n${body}`,
    )
    expect(readSpoorId(out)).toBe(ID)
  })

  it('adds a block to a file without frontmatter', () => {
    expect(insertSpoorId('# T\n\ntext\n', ID)).toBe(`---\nspoor_id: ${ID}\n---\n# T\n\ntext\n`)
  })

  it('handles an empty frontmatter block and CRLF files', () => {
    expect(insertSpoorId('---\n---\n# T\n', ID)).toBe(`---\nspoor_id: ${ID}\n---\n# T\n`)
    const crlf = '---\r\ntitle: x\r\n---\r\n# T\r\n'
    expect(insertSpoorId(crlf, ID)).toBe(`---\r\nspoor_id: ${ID}\r\ntitle: x\r\n---\r\n# T\r\n`)
  })

  it('never rewrites a file that has a spoor_id', () => {
    const src = `---\nspoor_id: ${ID}\ntitle: x\n---\nb\n`
    expect(insertSpoorId(src, '99999999-2222-4333-8444-555555555555')).toBe(src)
  })

  it('refuses an id that is not a uuid (it would be written as raw text)', () => {
    expect(() => insertSpoorId('# X\n', 'abc\nstatus: accepted')).toThrow(/not a uuid/)
    expect(() => insertSpoorId('---\ntitle: x\n---\n# X\n', 'x')).toThrow(/not a uuid/)
  })

  it('falls back to the Document API for a flow mapping', () => {
    const out = insertSpoorId('---\n{title: x, adr: 3}\n---\nbody\n', ID)
    expect(readSpoorId(out)).toBe(ID)
    expect(out.endsWith('---\nbody\n')).toBe(true)
  })
})

describe('setAdrNumber', () => {
  it('replaces only the adr value', () => {
    const src = '---\nspoor_id: x\nadr: 7 # number\ntitle: t\n---\n# ADR-0007 t\n'
    expect(setAdrNumber(src, 15)).toBe('---\nspoor_id: x\nadr: 15 # number\ntitle: t\n---\n# ADR-0007 t\n')
  })
  it('leaves files without an adr key alone', () => {
    expect(setAdrNumber('---\ntitle: t\n---\nb', 3)).toBe('---\ntitle: t\n---\nb')
    expect(setAdrNumber('no fm', 3)).toBe('no fm')
  })
})

describe('adrNumberOf', () => {
  it('frontmatter, then file name, then H1', () => {
    expect(adrNumberOf('0007-x.md', '---\nadr: 9\n---\n')).toBe(9)
    expect(adrNumberOf('0007-x.md', '# t')).toBe(7)
    expect(adrNumberOf('x.md', '# ADR-0012: t')).toBe(12)
    expect(adrNumberOf('x.md', '# 4. t')).toBe(4)
    expect(adrNumberOf('x.md', '# t')).toBeUndefined()
  })
  it('pads to 4 digits, 5 from 10000', () => {
    expect(padAdr(15)).toBe('0015')
    expect(padAdr(10000)).toBe('10000')
  })
})

describe('rewriteAdrH1', () => {
  it('rewrites a numbered or ADR-n H1 of the body, never a YAML comment', () => {
    expect(rewriteAdrH1('---\n# 2. comment\nadr: 4\n---\n# 2. Use Hono\n', 2, 4)).toBe(
      '---\n# 2. comment\nadr: 4\n---\n# 4. Use Hono\n',
    )
    expect(rewriteAdrH1('# ADR-0002: Second\n', 2, 15)).toBe('# ADR-0015: Second\n')
    expect(rewriteAdrH1('# 12. Other\n', 2, 4)).toBe('# 12. Other\n')
    expect(rewriteAdrH1('# Plain title\n', 2, 4)).toBe('# Plain title\n')
  })
})
