import { describe, expect, it } from 'vitest'
import { cleanLine, stripControl } from './text.js'

describe('stripControl', () => {
  it('removes C0/C1 controls incl. CR, LF, TAB and DEL', () => {
    expect(stripControl('a\r\nb\tc\u0000d\u007fe\u0085f')).toBe('abcdef')
  })

  it('removes every bidi control', () => {
    const bidi = '‎‏‪‫‬‭‮⁦⁧⁨⁩'
    expect(stripControl(`x${bidi}y`)).toBe('xy')
  })

  it('keeps ordinary text, accents, emoji and zero-width joiners', () => {
    const s = 'Příliš žluťoučký kůň 👩‍💻 ok'
    expect(stripControl(s)).toBe(s)
  })

  it('cleanLine also trims', () => {
    expect(cleanLine('  ‮evil\n ')).toBe('evil')
  })
})
