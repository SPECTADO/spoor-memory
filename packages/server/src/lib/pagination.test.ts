import { describe, expect, it } from 'vitest'
import { ApiError } from './errors.js'
import { decodeCursor, decodeTypedCursor, encodeCursor, page } from './pagination.js'

describe('cursor pagination', () => {
  it('round-trips cursor values', () => {
    const c = encodeCursor(['2026-10-19T10:00:00.123456Z', 'a1', 3, null])
    expect(decodeCursor(c, 4)).toEqual(['2026-10-19T10:00:00.123456Z', 'a1', 3, null])
  })

  it('rejects malformed cursors and wrong arity as invalid_input', () => {
    for (const bad of ['%%%', encodeCursor(['a']), Buffer.from('{"a":1}').toString('base64url')]) {
      expect(() => decodeCursor(bad, 2)).toThrow(ApiError)
    }
  })

  it('page trims the extra row and points the cursor at the last kept row', () => {
    const rows = [1, 2, 3].map((n) => ({ n }))
    expect(
      page(
        rows,
        2,
        (r) => [r.n],
        (r) => r.n,
      ),
    ).toEqual({ items: [1, 2], next_cursor: encodeCursor([2]) })
    expect(
      page(
        rows,
        3,
        (r) => [r.n],
        (r) => r.n,
      ),
    ).toEqual({ items: [1, 2, 3], next_cursor: null })
  })
})

describe('decodeTypedCursor (phase-2 review S4)', () => {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url')
  const code = (fn: () => unknown) => {
    try {
      fn()
      return 'ok'
    } catch (e) {
      return e instanceof ApiError ? e.code : 'other'
    }
  }
  const TS = '2026-10-19T12:00:00.123456Z'
  const ID = '5b1f6f5e-4b1e-4f46-9d57-0f6a2c2f7c11'
  it('accepts well-typed parts', () => {
    expect(decodeTypedCursor(enc([TS, ID]), ['timestamp', 'uuid'] as const)).toEqual([TS, ID])
    expect(decodeTypedCursor(enc([7]), ['int'] as const)).toEqual([7])
    expect(decodeTypedCursor(enc(['a@b.c', ID]), ['string', 'uuid'] as const)).toEqual(['a@b.c', ID])
  })
  it('refuses parts a SQL cast would choke on, with 400 invalid_input', () => {
    for (const [v, kinds] of [
      [
        ['x', 'y'],
        ['timestamp', 'uuid'],
      ],
      [
        [TS, 'not-a-uuid'],
        ['timestamp', 'uuid'],
      ],
      [
        ['2026-13-01T00:00:00.000000Z', ID],
        ['timestamp', 'uuid'],
      ],
      [
        ['2026-02-30T00:00:00.000000Z', ID],
        ['timestamp', 'uuid'],
      ],
      [['abc'], ['int']],
      [[1.5], ['int']],
      [[2 ** 40], ['int']],
      [
        ['a', 'not-a-uuid'],
        ['string', 'uuid'],
      ],
    ] as const) {
      expect(code(() => decodeTypedCursor(enc(v), kinds))).toBe('invalid_input')
    }
  })
})
