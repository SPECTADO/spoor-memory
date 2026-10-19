import { describe, expect, it } from 'vitest'
import { runHook } from './hook-guard.js'

describe('runHook', () => {
  it('skips work when SPOOR_DRAFTING=1', async () => {
    let ran = false
    expect(
      await runHook(
        () => {
          ran = true
        },
        { SPOOR_DRAFTING: '1' },
      ),
    ).toBe(0)
    expect(ran).toBe(false)
  })
  it('skips work when SPOOR_DISABLE=1', async () => {
    let ran = false
    await runHook(
      () => {
        ran = true
      },
      { SPOOR_DISABLE: '1' },
    )
    expect(ran).toBe(false)
  })
  it('swallows exceptions and returns 0', async () => {
    let logged: unknown
    expect(
      await runHook(
        () => {
          throw new Error('boom')
        },
        {},
        (e) => {
          logged = e
        },
      ),
    ).toBe(0)
    expect(logged).toBeInstanceOf(Error)
  })
  it('swallows exceptions thrown by the error logger', async () => {
    expect(
      await runHook(
        () => {
          throw new Error('a')
        },
        {},
        () => {
          throw new Error('b')
        },
      ),
    ).toBe(0)
  })
})
