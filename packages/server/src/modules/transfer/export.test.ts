import { describe, expect, it } from 'vitest'
import { EXPORT_MAX_BYTES } from './export.js'
import { ZIP_LIMITS } from './zip.js'

describe('export size cap', () => {
  it('equals the import cumulative cap, so every export can be re-imported (deviations G12)', () => {
    expect(EXPORT_MAX_BYTES).toBe(ZIP_LIMITS.maxTotalBytes)
    expect(EXPORT_MAX_BYTES).toBe(200 * 1024 * 1024)
  })
})
