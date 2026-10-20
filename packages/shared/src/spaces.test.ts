import { describe, expect, it } from 'vitest'
import { spaces } from './frontmatter.js'
import { HUMAN_ONLY_SPACES, isHumanOnlySpace } from './spaces.js'

describe('human-only spaces', () => {
  it('library only', () => {
    expect(HUMAN_ONLY_SPACES).toEqual(['library'])
    expect(spaces.filter(isHumanOnlySpace)).toEqual(['library'])
  })
})
