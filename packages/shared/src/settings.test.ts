import { describe, expect, it } from 'vitest'
import {
  dedupeDefaults,
  dedupeOrderIssue,
  embeddingModelKey,
  mergeSettings,
  projectSettings,
  projectSettingsPatch,
  refuseThreshold,
  relatedMinCos,
  resolveProjectSettings,
  settingsPatchPaths,
} from './settings.js'

describe('project settings', () => {
  it('fills defaults on read and rejects unknown keys and out-of-range values', () => {
    const full = projectSettings.parse({})
    expect(full).toEqual({
      cleanup: { stale_days: 30, archive_days: 90, observation_days: 7 },
      digest: { default_budget: 1500, decision_window_days: 30 },
      dedupe: { threshold: 0.87, related_min_cos: 0.7, refuse_threshold: null },
      embedding: { provider: 'local' },
      memory: { exclusive: true },
    })
    expect(projectSettings.safeParse({ cleanup: { nope: 1 } }).success).toBe(false)
    expect(projectSettings.safeParse({ memory: { exclusive: 'yes' } }).success).toBe(false)
    expect(projectSettings.safeParse({ digest: { default_budget: 100 } }).success).toBe(false)
    expect(projectSettings.safeParse({ dedupe: { threshold: 0.995 } }).success).toBe(false)
  })

  it('patch schema: every key optional, ranges and strictness kept', () => {
    expect(projectSettingsPatch.parse({})).toEqual({})
    expect(projectSettingsPatch.parse({ cleanup: { stale_days: 5 } })).toEqual({ cleanup: { stale_days: 5 } })
    expect(projectSettingsPatch.safeParse({ cleanup: { stale_days: 0 } }).success).toBe(false)
    expect(projectSettingsPatch.safeParse({ cleanup: { stale_days: 1.5 } }).success).toBe(false)
    expect(projectSettingsPatch.safeParse({ other: {} }).success).toBe(false)
    expect(projectSettingsPatch.safeParse({ dedupe: { threshold: 0.59 } }).success).toBe(false)
    expect(projectSettingsPatch.safeParse({ dedupe: { threshold: 0.6 } }).success).toBe(true)
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

  it('related_min_cos: 0.40-0.90, default 0.70, read clamped below the duplicate threshold', () => {
    expect(projectSettings.safeParse({ dedupe: { related_min_cos: 0.39 } }).success).toBe(false)
    expect(projectSettings.safeParse({ dedupe: { related_min_cos: 0.91 } }).success).toBe(false)
    expect(projectSettingsPatch.parse({ dedupe: { related_min_cos: 0.8 } })).toEqual({
      dedupe: { related_min_cos: 0.8 },
    })
    expect(relatedMinCos(projectSettings.parse({}))).toBe(0.7)
    expect(relatedMinCos(projectSettings.parse({ dedupe: { threshold: 0.85, related_min_cos: 0.9 } }))).toBe(
      0.84,
    )
  })

  it('lists the dotted paths a patch sets', () => {
    expect(settingsPatchPaths({ embedding: { provider: 'local' }, cleanup: { stale_days: 3 } })).toEqual([
      'cleanup.stale_days',
      'embedding.provider',
    ])
  })

  it('reads the provider and model family out of a model tag', () => {
    expect(embeddingModelKey('ollama:embeddinggemma/768')).toBe('ollama:embeddinggemma')
    expect(embeddingModelKey('ollama:embeddinggemma:latest/768')).toBe('ollama:embeddinggemma')
    expect(embeddingModelKey('ollama:hf.co/org/EmbeddingGemma:300m/768')).toBe('ollama:embeddinggemma')
    expect(embeddingModelKey('local:Xenova/multilingual-e5-small@q8/384')).toBe('local:multilingual-e5-small')
    expect(embeddingModelKey('openai:text-embedding-3-small/1536')).toBe('openai:text-embedding-3-small')
    expect(embeddingModelKey('embeddinggemma')).toBeNull()
    expect(embeddingModelKey('')).toBeNull()
  })

  it('dedupe defaults are per embedding model; unknown models take the e5 defaults', () => {
    expect(dedupeDefaults('ollama:embeddinggemma/768')).toEqual({
      threshold: 0.75,
      related_min_cos: 0.5,
      refuse_threshold: 0.9,
    })
    const e5 = { threshold: 0.87, related_min_cos: 0.7, refuse_threshold: null }
    expect(dedupeDefaults('local:Xenova/multilingual-e5-small@q8/384')).toEqual(e5)
    expect(dedupeDefaults('ollama:nomic-embed-text/768')).toEqual(e5)
    expect(dedupeDefaults('openai:embeddinggemma/768')).toEqual(e5) // the scale was measured through Ollama only
    expect(dedupeDefaults(null)).toEqual(e5)
    expect(dedupeDefaults()).toEqual(e5)
  })

  it('resolves stored settings for a model: unset dedupe keys follow the model, set ones stay', () => {
    const gemma = 'ollama:embeddinggemma/768'
    const g = { threshold: 0.75, related_min_cos: 0.5, refuse_threshold: 0.9 }
    expect(resolveProjectSettings({}, gemma).dedupe).toEqual(g)
    expect(resolveProjectSettings(null, gemma).dedupe).toEqual(g)
    expect(resolveProjectSettings({ dedupe: { threshold: 0.9 } }, gemma).dedupe).toEqual({
      ...g,
      threshold: 0.9,
    })
    expect(resolveProjectSettings({ dedupe: { related_min_cos: 0.6 } }, gemma).dedupe).toEqual({
      ...g,
      related_min_cos: 0.6,
    })
    // a stored null (refusal off) wins over the model's 0.90
    expect(
      resolveProjectSettings({ dedupe: { refuse_threshold: null } }, gemma).dedupe.refuse_threshold,
    ).toBe(null)
    // without a tag, and for every other section, it is the plain schema
    expect(resolveProjectSettings({ cleanup: { stale_days: 5 } })).toEqual(
      projectSettings.parse({ cleanup: { stale_days: 5 } }),
    )
    expect(resolveProjectSettings({ cleanup: { stale_days: 5 } }, gemma).cleanup.stale_days).toBe(5)
    // a stored object the schema rejects falls back to the defaults of that model
    expect(resolveProjectSettings({ dedupe: { threshold: 2 } }, gemma).dedupe.threshold).toBe(0.75)
    expect(resolveProjectSettings({ nope: 1 }, gemma).dedupe.threshold).toBe(0.75)
    expect(resolveProjectSettings([], gemma).dedupe.threshold).toBe(0.75)
    expect(relatedMinCos(resolveProjectSettings({}, gemma))).toBe(0.5)
  })
})

describe('dedupe.refuse_threshold', () => {
  it('is 0.80-1.0 or null, default off (null) for e5 and 0.90 for embeddinggemma', () => {
    expect(projectSettings.parse({}).dedupe.refuse_threshold).toBeNull()
    expect(
      resolveProjectSettings({}, 'local:Xenova/multilingual-e5-small@q8/384').dedupe.refuse_threshold,
    ).toBe(null)
    expect(resolveProjectSettings({}, 'ollama:embeddinggemma/768').dedupe.refuse_threshold).toBe(0.9)
    expect(projectSettingsPatch.safeParse({ dedupe: { refuse_threshold: 0.79 } }).success).toBe(false)
    expect(projectSettingsPatch.safeParse({ dedupe: { refuse_threshold: 1.01 } }).success).toBe(false)
    expect(projectSettingsPatch.safeParse({ dedupe: { refuse_threshold: 0.8 } }).success).toBe(true)
    expect(projectSettingsPatch.safeParse({ dedupe: { refuse_threshold: 1 } }).success).toBe(true)
    expect(projectSettingsPatch.parse({ dedupe: { refuse_threshold: null } })).toEqual({
      dedupe: { refuse_threshold: null },
    })
    // null is stored (it turns the model default off), unlike undefined
    expect(
      mergeSettings({ dedupe: { refuse_threshold: 0.95 } }, { dedupe: { refuse_threshold: null } }),
    ).toEqual({
      dedupe: { refuse_threshold: null },
    })
  })

  it('is read never below the threshold, and off stays off', () => {
    expect(refuseThreshold(projectSettings.parse({}))).toBeNull()
    expect(refuseThreshold(projectSettings.parse({ dedupe: { refuse_threshold: 0.9 } }))).toBe(0.9)
    expect(
      refuseThreshold(resolveProjectSettings({ dedupe: { threshold: 0.95 } }, 'ollama:embeddinggemma/768')),
    ).toBe(0.95)
  })

  it('must be at least the threshold when an admin stored both', () => {
    expect(dedupeOrderIssue({ dedupe: { threshold: 0.9, refuse_threshold: 0.85 } })).toEqual({
      path: 'dedupe.refuse_threshold',
      message: 'must be at least dedupe.threshold',
    })
    expect(dedupeOrderIssue({ dedupe: { threshold: 0.9, refuse_threshold: 0.9 } })).toBeNull()
    expect(dedupeOrderIssue({ dedupe: { threshold: 0.9, refuse_threshold: null } })).toBeNull()
    expect(dedupeOrderIssue({ dedupe: { refuse_threshold: 0.8 } })).toBeNull()
    expect(dedupeOrderIssue(null)).toBeNull()
  })
})
