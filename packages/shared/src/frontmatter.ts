/** Frontmatter zod schemas per space (docs/design/data-model.md section 5). Unknown keys pass through (round-trip). */
import { z } from 'zod'

/**
 * Field limits of an item, the one copy every write path (REST, MCP, push, import) and the SPA use. Lengths
 * are Unicode code points (what the database's `length()` CHECKs count), except `extrasBytes` and
 * `frontmatterBytes` (UTF-8 bytes).
 */
export const ITEM_LIMITS = {
  title: 200,
  body: 200_000,
  extrasBytes: 8 * 1024,
  frontmatterBytes: 16 * 1024,
  tags: 20,
  anchors: 20,
  anchorLength: 256,
} as const

/** Code points, not UTF-16 units (an emoji counts once), like Postgres `length()`. */
export const codePointLength = (s: string): number => {
  let n = 0
  for (const _ of s) n++
  return n
}

const oneLine = (s: string) => !/[\r\n]/.test(s)
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(?:[Tt ][\d:.]+(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/, 'ISO date or date-time')

export const TAG_RE = /^[a-z0-9][a-z0-9_/-]{0,39}$/
export const tagSchema = z.string().regex(TAG_RE)
export const handleOrUuid = z.string().min(1).max(100)

export const relationKinds = ['refines', 'supports', 'depends_on', 'conflicts_with'] as const
export const relationSchema = z.object({ kind: z.enum(relationKinds), to: handleOrUuid })

/** Keys common to all spaces. */
export const commonFrontmatterShape = {
  spoor_id: z.string().uuid().optional(),
  title: z
    .string()
    .min(1)
    .refine((s) => codePointLength(s) <= ITEM_LIMITS.title, `at most ${ITEM_LIMITS.title} characters`)
    .refine(oneLine, 'single line')
    .optional(),
  tags: z.array(tagSchema).max(ITEM_LIMITS.tags).default([]),
  anchors: z.array(z.string().min(1).max(ITEM_LIMITS.anchorLength)).max(ITEM_LIMITS.anchors).default([]),
  pinned: z.boolean().default(false),
  last_verified: isoDate.optional(),
  relations: z.array(relationSchema).default([]),
  supersedes: handleOrUuid.optional(),
  superseded_by: handleOrUuid.optional(),
}

export const memoryTypes = ['decision', 'fact', 'procedure', 'observation'] as const
export const confidences = ['low', 'medium', 'high'] as const
export const adrStatuses = ['proposed', 'accepted', 'superseded', 'deprecated'] as const

export const memoryFrontmatter = z.looseObject({
  ...commonFrontmatterShape,
  type: z.enum(memoryTypes),
  confidence: z.enum(confidences).default('medium'),
  status: z.enum(['active', 'superseded']).optional(),
  expires: isoDate.optional(),
})

export const decisionFrontmatter = z.looseObject({
  ...commonFrontmatterShape,
  adr: z.number().int().min(1).optional(),
  status: z.enum(adrStatuses).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  deciders: z.array(z.string()).optional(),
  drafted_from: z.array(handleOrUuid).optional(),
})

export const docFrontmatter = z.looseObject({ ...commonFrontmatterShape })

export const spaces = ['memories', 'decisions', 'docs'] as const
export type Space = (typeof spaces)[number]

export const frontmatterSchemas = {
  memories: memoryFrontmatter,
  decisions: decisionFrontmatter,
  docs: docFrontmatter,
} as const

export type MemoryFrontmatter = z.infer<typeof memoryFrontmatter>
export type DecisionFrontmatter = z.infer<typeof decisionFrontmatter>
export type DocFrontmatter = z.infer<typeof docFrontmatter>

// ---- which keys are columns (the one known-key table, data-model.md section 5) ---------------------------

/** Keys every space maps to columns or edges (or derives, like `superseded_by`). */
export const COMMON_KEYS = [
  'spoor_id',
  'title',
  'tags',
  'anchors',
  'pinned',
  'last_verified',
  'relations',
  'supersedes',
  'superseded_by',
] as const

/**
 * Space-specific known keys. `status` is known in every space: an input for decisions, output only for
 * memories and docs (written by export and `spoor_get`, never stored as an extra). `deciders` is validated
 * by the schema but stored as an extra.
 */
export const SPACE_KEYS: Record<Space, readonly string[]> = {
  memories: ['type', 'confidence', 'status', 'expires'],
  decisions: ['adr', 'status', 'date', 'drafted_from'],
  docs: ['status'],
}

export function knownKeys(space: Space): Set<string> {
  return new Set<string>([...COMMON_KEYS, ...SPACE_KEYS[space]])
}

/** Unknown keys of a parsed frontmatter: what goes into `items.frontmatter` (round-trip). */
export function extrasOf(space: Space, data: Record<string, unknown>): Record<string, unknown> {
  const known = knownKeys(space)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) if (!known.has(k)) out[k] = v
  return out
}

export const utf8Length = (s: string): number => new TextEncoder().encode(s).length
