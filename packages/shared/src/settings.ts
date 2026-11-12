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
    /** The ranges span every supported model's cosine scale; the defaults are per model (`dedupeDefaults`). */
    threshold: z.number().min(0.6).max(0.99),
    /** Minimum cosine of a related-item suggestion; read through `relatedMinCos` (kept below `threshold`). */
    related_min_cos: z.number().min(0.4).max(0.9),
    /**
     * MCP creates refuse a near-copy at or above this cosine (values agree, same space and type); `null` = off.
     * Read through `refuseThreshold` (never below `threshold`).
     */
    refuse_threshold: z.number().min(0.8).max(1).nullable(),
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
  dedupe: { threshold: 0.87, related_min_cos: 0.7, refuse_threshold: null },
  embedding: { provider: 'local' },
  memory: { exclusive: true },
} as const

const f = fields
const d = SETTINGS_DEFAULTS

type DedupeDefaults = {
  readonly threshold: number
  readonly related_min_cos: number
  readonly refuse_threshold: number | null
}

/**
 * Dedupe defaults of models whose cosines sit on another scale than e5-small's, keyed by
 * `<provider>:<model family>` (ADR-0028). embeddinggemma scores a reworded duplicate 0.65 to 0.94 (median
 * 0.85) and a different fact on the same topic at most 0.65 once the values guard has run, where e5-small
 * puts both near 0.9; unrelated items sit below 0.53. Every other model takes `SETTINGS_DEFAULTS.dedupe`.
 * The near-copy refusal (`refuse_threshold`) is on at 0.90 only for embeddinggemma: on e5-small different
 * facts score as high as reworded duplicates (up to 0.957), so no value is safe there.
 */
const DEDUPE_DEFAULTS_BY_MODEL: Readonly<Record<string, DedupeDefaults>> = {
  'ollama:embeddinggemma': { threshold: 0.75, related_min_cos: 0.5, refuse_threshold: 0.9 },
}

/**
 * `<provider>:<model family>` of a model tag: `ollama:hf.co/org/EmbeddingGemma:300m/768` gives
 * `ollama:embeddinggemma`, `local:Xenova/multilingual-e5-small@q8/384` gives `local:multilingual-e5-small`.
 * `null` for a string that is not a model tag.
 */
export function embeddingModelKey(tag: string): string | null {
  const m = /^([^:/]+):(.+)\/\d+$/.exec(tag)
  if (!m) return null
  const model = m[2] as string
  const family = (model.slice(model.lastIndexOf('/') + 1).split(/[:@]/)[0] as string).toLowerCase()
  return family === '' ? null : `${m[1]}:${family}`
}

/** The dedupe defaults for a project whose active embedding model has this tag. */
export function dedupeDefaults(modelTag?: string | null): DedupeDefaults {
  const key = modelTag ? embeddingModelKey(modelTag) : null
  return (key !== null ? DEDUPE_DEFAULTS_BY_MODEL[key] : undefined) ?? d.dedupe
}

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
      refuse_threshold: f.dedupe.refuse_threshold.default(d.dedupe.refuse_threshold),
    })
    .prefault({}),
  embedding: z.strictObject({ provider: f.embedding.provider.default(d.embedding.provider) }).prefault({}),
  memory: z.strictObject({ exclusive: f.memory.exclusive.default(d.memory.exclusive) }).prefault({}),
})
export type ProjectSettings = z.infer<typeof projectSettings>

/**
 * Stored settings resolved for a project whose active embedding model is `modelTag`: a `dedupe` key the
 * admin never set takes that model's default, every other missing key the schema default. A stored value the
 * schema no longer accepts falls back to the defaults as a whole.
 */
export function resolveProjectSettings(stored: unknown, modelTag?: string | null): ProjectSettings {
  const model = dedupeDefaults(modelTag)
  const withModel = (s: Record<string, unknown>) => ({
    ...s,
    dedupe: isRecord(s.dedupe) ? { ...model, ...s.dedupe } : (s.dedupe ?? { ...model }),
  })
  const parsed = projectSettings.safeParse(isRecord(stored) ? withModel(stored) : (stored ?? withModel({})))
  return parsed.success ? parsed.data : projectSettings.parse(withModel({}))
}

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
      refuse_threshold: f.dedupe.refuse_threshold.optional(),
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

/**
 * The cosine at or above which an MCP create is refused as a near-copy, or `null` when the refusal is off.
 * Never below the duplicate threshold: a stored `threshold` above the model's default `refuse_threshold` raises it.
 */
export function refuseThreshold(settings: Pick<ProjectSettings, 'dedupe'>): number | null {
  const { threshold, refuse_threshold } = settings.dedupe
  return refuse_threshold === null ? null : Math.max(refuse_threshold, threshold)
}

/**
 * The cross-field rule of stored settings: when an admin stored both `dedupe.threshold` and
 * `dedupe.refuse_threshold` (not null), the refusal cut-off is not below the threshold. `null` when it holds.
 */
export function dedupeOrderIssue(stored: unknown): { path: string; message: string } | null {
  const dd = isRecord(stored) && isRecord(stored.dedupe) ? stored.dedupe : null
  if (!dd || typeof dd.threshold !== 'number' || typeof dd.refuse_threshold !== 'number') return null
  return dd.refuse_threshold < dd.threshold
    ? { path: 'dedupe.refuse_threshold', message: 'must be at least dedupe.threshold' }
    : null
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
