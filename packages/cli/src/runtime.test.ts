import { describe, expect, it } from 'vitest'
import { runtimeOf, terminalSafe } from './runtime.js'

describe('terminalSafe (review-log-phase5 S6)', () => {
  it('drops C0 (but TAB and LF), DEL, C1 and bidi controls; keeps text', () => {
    expect(terminalSafe('AB\u001b]0;pwn\u0007CD')).toBe('AB]0;pwnCD')
    expect(terminalSafe('a\tb\nc\r\u007f\u009bd')).toBe('a\tb\ncd')
    expect(terminalSafe('x‮y⁦z‏')).toBe('xyz')
    expect(terminalSafe('Příliš žluťoučký 😀')).toBe('Příliš žluťoučký 😀')
  })

  it('applies to everything the runtime prints and asks', async () => {
    let out = ''
    let err = ''
    let asked = ''
    const rt = runtimeOf({
      out: (s) => {
        out += s
      },
      err: (s) => {
        err += s
      },
      env: {},
      prompt: async (q) => {
        asked = q
        return ''
      },
    })
    rt.out('o\u001b[2J\n')
    rt.err('e\u001b[31m\n')
    await rt.prompt('q\u001b]0;t\u0007?')
    expect(out).toBe('o[2J\n')
    expect(err).toBe('e[31m\n')
    expect(asked).toBe('q]0;t?')
  })
})
