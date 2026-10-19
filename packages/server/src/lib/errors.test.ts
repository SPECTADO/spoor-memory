import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ApiError, invalidInput, loggableError } from './errors.js'

describe('ApiError', () => {
  it('takes the status from the shared code table', () => {
    expect(new ApiError('revision_conflict').status).toBe(409)
    expect(new ApiError('forbidden_origin').status).toBe(403)
    expect(new ApiError('busy').status).toBe(503)
  })

  it('sends only an explicit message', () => {
    expect(new ApiError('not_found').publicMessage).toBeUndefined()
    expect(new ApiError('not_found', { message: 'No such item.' }).publicMessage).toBe('No such item.')
  })

  it('maps zod issues to details.issues with dotted paths', () => {
    const r = z.object({ tags: z.array(z.string()) }).safeParse({ tags: [1] })
    expect(r.success).toBe(false)
    const e = invalidInput((r as { error: z.ZodError }).error)
    expect(e.code).toBe('invalid_input')
    expect(e.details?.issues).toEqual([{ path: 'tags.0', message: expect.any(String) }])
  })

  it('never logs query parameters', () => {
    const err = Object.assign(new Error('Failed query: select 1\nparams: secret'), {
      query: 'select 1',
      params: ['secret'],
    })
    const out = loggableError(err)
    expect(JSON.stringify(out)).not.toContain('secret')
    expect(out.query).toBe('select 1')
  })
})
