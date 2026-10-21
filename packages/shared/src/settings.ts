/**
 * Project settings (docs/design/data-model.md section 2.1). `projects.settings` stores only the keys an admin
 * set; missing keys take the defaults below on read, so a changed default reaches every project that never
 * overrode it. Unknown keys are rejected on write.
 */
import { z } from 'zod'

/** One schema per field, shared by the full schema (with defaults) and the patch schema (all optional). */
const fields = {
  cleanup: {
    stale_days: z.number().int().min(1).max(3650),
    archive_days: z.number().int().min(1).max(3650),
    observation_days: z.number().int().min(1).max(365),
  },
  digest: {
    default_budget: z.number().int().min(200).max(8000),
    decision_window_days: z.number().int().min(1).max(365),
  },
  dedupe: {
    threshold: z.number().min(0.8).max(0.99),
    /** Minimum cosine of a related-item suggestion; read through `relatedMinCos` (kept below `threshold`). */
    related_min_cos: z.number().min(0.5).max(0.9),
  },
  embedding: {
    /** A provider name enabled by env (`local` always); the server checks it against its registry. */
    provider: z.string().min(1).max(32),
  },
  memory: {
    /** Spoor is the agents' only memory (ADR-0015): MCP instructions, the AGENTS.md block, auto-memory off. */
    exclusive: z.boolean(),
  },
} as const

export const SETTINGS_DEFAULTS = {
  cleanup: { stale_days: 30, archive_days: 90, observation_days: 7 },
  digest: { default_budget: 1500, decision_window_days: 30 },
  dedupe: { threshold: 0.92, related_min_cos: 0.7 },
  embedding: { provider: 'local' },
  memory: { exclusive: true },
} as const

const f = fields
const d = SETTINGS_DEFAULTS

/** The resolved settings: missing keys take defaults, unknown keys are rejected. */
export const projectSettings = z.strictObject({
  cleanup: z
    .strictObject({
      stale_days: f.cleanup.stale_days.default(d.cleanup.stale_days),
      archive_days: f.cleanup.archive_days.default(d.cleanup.archive_days),
      observation_days: f.cleanup.observation_days.default(d.cleanup.observation_days),
    })
    .prefault({}),
  digest: z
    .strictObject({
      default_budget: f.digest.default_budget.default(d.digest.default_budget),
      decision_window_days: f.digest.decision_window_days.default(d.digest.decision_window_days),
    })
    .prefault({}),
  dedupe: z
    .strictObject({
      threshold: f.dedupe.threshold.default(d.dedupe.threshold),
      related_min_cos: f.dedupe.related_min_cos.default(d.dedupe.related_min_cos),
    })
    .prefault({}),
  embedding: z.strictObject({ provider: f.embedding.provider.default(d.embedding.provider) }).prefault({}),
  memory: z.strictObject({ exclusive: f.memory.exclusive.default(d.memory.exclusive) }).prefault({}),
})
export type ProjectSettings = z.infer<typeof projectSettings>

/** A partial settings object (`PATCH /api/v1/projects/:slug`, `POST /api/v1/projects`): deep-merged. */
export const projectSettingsPatch = z.strictObject({
  cleanup: z
    .strictObject({
      stale_days: f.cleanup.stale_days.optional(),
      archive_days: f.cleanup.archive_days.optional(),
      observation_days: f.cleanup.observation_days.optional(),
    })
    .optional(),
  digest: z
    .strictObject({
      default_budget: f.digest.default_budget.optional(),
      decision_window_days: f.digest.decision_window_days.optional(),
    })
    .optional(),
  dedupe: z
    .strictObject({
      threshold: f.dedupe.threshold.optional(),
      related_min_cos: f.dedupe.related_min_cos.optional(),
    })
    .optional(),
  embedding: z.strictObject({ provider: f.embedding.provider.optional() }).optional(),
  memory: z.strictObject({ exclusive: f.memory.exclusive.optional() }).optional(),
})
export type ProjectSettingsPatch = z.infer<typeof projectSettingsPatch>

/**
 * The cosine floor related-item suggestions use: `dedupe.related_min_cos`, clamped to 0.01 below the duplicate
 * threshold so a suggestion is never a near-duplicate's score band.
 */
export function relatedMinCos(settings: Pick<ProjectSettings, 'dedupe'>): number {
  const { threshold, related_min_cos } = settings.dedupe
  return Math.min(related_min_cos, Math.round((threshold - 0.01) * 100) / 100)
}

type StoredSettings = Record<string, Record<string, unknown>>

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/**
 * Deep-merge a patch into the stored (explicit-keys-only) settings. Returns what to store; validate the
 * result with `projectSettings` before writing. `undefined` values in the patch are skipped.
 */
export function mergeSettings(stored: unknown, patch: ProjectSettingsPatch): StoredSettings {
  const out: StoredSettings = {}
  if (isRecord(stored)) {
    for (const [k, v] of Object.entries(stored)) if (isRecord(v)) out[k] = { ...v }
  }
  for (const [section, values] of Object.entries(patch)) {
    if (!isRecord(values)) continue
    const target = out[section] ?? {}
    for (const [k, v] of Object.entries(values)) if (v !== undefined) target[k] = v
    if (Object.keys(target).length > 0) out[section] = target
  }
  return out
}

/** Dotted paths of the keys a patch sets, e.g. `['cleanup.stale_days', 'embedding.provider']` (audit data). */
export function settingsPatchPaths(patch: ProjectSettingsPatch): string[] {
  const out: string[] = []
  for (const [section, values] of Object.entries(patch)) {
    if (!isRecord(values)) continue
    for (const [k, v] of Object.entries(values)) if (v !== undefined) out.push(`${section}.${k}`)
  }
  return out.sort()
}
