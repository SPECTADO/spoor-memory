import { describe, expect, it } from 'vitest'
import { mergeSettings, projectSettings, projectSettingsPatch, settingsPatchPaths } from './settings.js'

describe('project settings', () => {
  it('fills defaults on read and rejects unknown keys and out-of-range values', () => {
    const full = projectSettings.parse({})
    expect(full).toEqual({
      cleanup: { stale_days: 30, archive_days: 90, observation_days: 7 },
      digest: { default_budget: 1500, decision_window_days: 30 },
      dedupe: { threshold: 0.92 },
      embedding: { provider: 'local' },
    })
    expect(projectSettings.safeParse({ cleanup: { nope: 1 } }).success).toBe(false)
    expect(projectSettings.safeParse({ digest: { default_budget: 100 } }).success).toBe(false)
    expect(projectSettings.safeParse({ dedupe: { threshold: 0.995 } }).success).toBe(false)
  })

  it('patch schema: every key optional, ranges and strictness kept', () => {
    expect(projectSettingsPatch.parse({})).toEqual({})
    expect(projectSettingsPatch.parse({ cleanup: { stale_days: 5 } })).toEqual({ cleanup: { stale_days: 5 } })
    expect(projectSettingsPatch.safeParse({ cleanup: { stale_days: 0 } }).success).toBe(false)
    expect(projectSettingsPatch.safeParse({ cleanup: { stale_days: 1.5 } }).success).toBe(false)
    expect(projectSettingsPatch.safeParse({ other: {} }).success).toBe(false)
    expect(projectSettingsPatch.safeParse({ dedupe: { threshold: 0.79 } }).success).toBe(false)
  })

  it('deep-merges a patch over stored keys without filling defaults', () => {
    const stored = { cleanup: { stale_days: 10 }, dedupe: { threshold: 0.9 } }
    const merged = mergeSettings(stored, { cleanup: { archive_days: 20 }, embedding: { provider: 'openai' } })
    expect(merged).toEqual({
      cleanup: { stale_days: 10, archive_days: 20 },
      dedupe: { threshold: 0.9 },
      embedding: { provider: 'openai' },
    })
    expect(stored.cleanup).toEqual({ stale_days: 10 }) // input untouched
    expect(mergeSettings(null, {})).toEqual({})
    expect(projectSettings.parse(merged).cleanup.observation_days).toBe(7)
  })

  it('lists the dotted paths a patch sets', () => {
    expect(settingsPatchPaths({ embedding: { provider: 'local' }, cleanup: { stale_days: 3 } })).toEqual([
      'cleanup.stale_days',
      'embedding.provider',
    ])
  })
})
