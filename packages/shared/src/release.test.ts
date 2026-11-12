import { describe, expect, it } from 'vitest'
import { isNewerRelease, isStableRelease, releaseTagUrl } from './release.js'

describe('isStableRelease', () => {
  it('accepts x.y.z only', () => {
    expect(isStableRelease('0.6.1')).toBe(true)
    expect(isStableRelease('10.0.12')).toBe(true)
    expect(isStableRelease('0.7.0-rc.1')).toBe(false)
    expect(isStableRelease('0.0.0')).toBe(false)
    expect(isStableRelease('v0.6.1')).toBe(false)
    expect(isStableRelease('0.6')).toBe(false)
  })
})

describe('isNewerRelease', () => {
  it('compares numerically, not as text', () => {
    expect(isNewerRelease('0.10.0', '0.9.5')).toBe(true)
    expect(isNewerRelease('1.0.0', '0.99.99')).toBe(true)
    expect(isNewerRelease('0.6.2', '0.6.1')).toBe(true)
    expect(isNewerRelease('0.6.1', '0.6.1')).toBe(false)
    expect(isNewerRelease('0.6.1', '0.7.0')).toBe(false)
    expect(isNewerRelease('0.9.5', '0.10.0')).toBe(false)
  })

  it('never announces a pre-release', () => {
    expect(isNewerRelease('0.8.0-rc.1', '0.7.0')).toBe(false)
  })

  it('treats a release as newer than its own pre-release only', () => {
    expect(isNewerRelease('0.8.0', '0.8.0-rc.1')).toBe(true)
    expect(isNewerRelease('0.7.0', '0.8.0-rc.1')).toBe(false)
  })

  it('ignores 0.0.0 and unparsable versions on either side', () => {
    expect(isNewerRelease('0.7.0', '0.0.0')).toBe(false)
    expect(isNewerRelease('0.7.0', '0.0.0-dev')).toBe(false)
    expect(isNewerRelease('0.0.0', '0.6.1')).toBe(false)
    expect(isNewerRelease('0.7.0', 'dev')).toBe(false)
    expect(isNewerRelease('latest', '0.6.1')).toBe(false)
  })
})

describe('releaseTagUrl', () => {
  it('points at the GitHub release of the tag', () => {
    expect(releaseTagUrl('0.6.1')).toBe('https://github.com/SPECTADO/spoor-memory/releases/tag/v0.6.1')
  })
})
