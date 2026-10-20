import { spaces } from '@spoor/shared'
import { describe, expect, it } from 'vitest'
import { SPACES } from './schema.js'

describe('space lists', () => {
  it('the server SPACES mirrors the shared spaces (drizzle-kit loads schema.ts without workspace packages)', () => {
    expect([...SPACES]).toEqual([...spaces])
  })
})
