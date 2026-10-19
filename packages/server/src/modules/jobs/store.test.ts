// What a failed job run may store (phase-2 review S5): never SQL text or bound parameters.
import { describe, expect, it } from 'vitest'
import { errorText, jobErrorMessage } from './store.js'

describe('job error text', () => {
  it('a drizzle query error is reduced to its SQLSTATE', () => {
    const cause = Object.assign(new Error('duplicate key value'), { code: '23505' })
    const err = Object.assign(
      new Error('Failed query: UPDATE items SET body = $1 WHERE id = $2\nparams: secret body,5b1f6f5e'),
      { cause },
    )
    expect(jobErrorMessage(err)).toBe('database error 23505')
    expect(jobErrorMessage(new Error('Failed query: SELECT 1\nparams: x'))).toBe('database error')
    expect(jobErrorMessage(new Error('lease lost'))).toBe('lease lost')
  })
  it('errorText strips query text whatever the caller passed, and stays one bounded line', () => {
    expect(errorText('boom Failed query: SELECT $1\nparams: secret')).toBe('boom database error')
    expect(errorText(`a\n${'x'.repeat(600)}`)?.length).toBe(500)
    expect(errorText(null)).toBeNull()
  })
})
