/**
 * Request schemas of the items routes (api.md sections 5 and 7.2/7.3). Strict objects: unknown fields,
 * including the immutable `slug`, `space`, `number` and `adr_number` on PATCH, are 400 `invalid_input`.
 *
 * NOTE: the design puts these in `packages/shared/src/api/` so the SPA and the CLI share them; they live
 * here until they move, because this module may not write outside its folder.
 */
import { adrStatuses, confidences, ITEM_LIMITS, memoryTypes, relationKinds, spaces } from '@spoor/shared'
import { z } from 'zod'
import { paginationQuery } from '../../lib/pagination.js'

export const SPACE_VALUES = spaces
export const spaceParam = z.enum(SPACE_VALUES)

const ref = z.string().min(1).max(200)
// loose request bounds (UTF-16 units: at most 2 per code point); the field cleaners of writes.ts apply
// ITEM_LIMITS exactly, in code points, with the right error (`too_large` for a body)
const title = z
  .string()
  .min(1)
  .max(ITEM_LIMITS.title * 2)
const body = z.string().max(ITEM_LIMITS.body * 2)
const tags = z.array(z.string().max(80)).max(ITEM_LIMITS.tags)
const anchors = z.array(z.string().max(ITEM_LIMITS.anchorLength * 2)).max(ITEM_LIMITS.anchors)
const extra = z.record(z.string().min(1).max(100), z.unknown())
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
const relation = z.strictObject({ kind: z.enum(relationKinds), to: ref })

export const itemCreateRequest = z.strictObject({
  title,
  body: body.optional(),
  tags: tags.optional(),
  anchors: anchors.optional(),
  pinned: z.boolean().optional(),
  slug: z.string().min(1).max(100).optional(),
  extra: extra.optional(),
  relations: z.array(relation).max(20).optional(),
  supersedes: ref.optional(),
  // memories
  type: z.enum(memoryTypes).optional(),
  confidence: z.enum(confidences).optional(),
  allow_duplicate: z.boolean().optional(),
  // decisions
  status: z.enum(adrStatuses).optional(),
  adr_number: z.number().int().min(1).max(99999).optional(),
  decided_on: isoDay.optional(),
})
export type ItemCreateRequest = z.infer<typeof itemCreateRequest>

export const itemPatchRequest = z.strictObject({
  /** Required; its absence is 400 `revision_required` (checked by the service, not here). */
  revision: z.number().int().min(1).optional(),
  title: title.optional(),
  body: body.optional(),
  type: z.enum(memoryTypes).optional(),
  confidence: z.enum(confidences).optional(),
  status: z.string().min(1).max(20).optional(),
  tags: tags.optional(),
  anchors: anchors.optional(),
  extra: extra.optional(),
  decided_on: isoDay.nullable().optional(),
})
export type ItemPatchRequest = z.infer<typeof itemPatchRequest>

export const noteRequest = z.strictObject({ note: z.string().max(300).optional() })

export const restoreRequest = z.strictObject({
  note: z.string().max(300).optional(),
  promote_to_fact: z.boolean().optional(),
  revision: z.number().int().min(1).optional(),
})

export const supersedeRequest = z.strictObject({
  new: z
    .strictObject({
      title,
      body: body.optional(),
      type: z.enum(memoryTypes).optional(),
      confidence: z.enum(confidences).optional(),
      anchors: anchors.optional(),
      tags: tags.optional(),
    })
    .optional(),
  new_id: ref.optional(),
  revision: z.number().int().min(1).optional(),
  reason: z.string().max(300).optional(),
})
export type SupersedeRequest = z.infer<typeof supersedeRequest>

export const edgeCreateRequest = z.strictObject({ kind: z.enum(relationKinds), to: ref })

export const deleteQuery = z.strictObject({ confirm: z.string().max(200).optional() })

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .max(200)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(values)).min(1))

export const listQuery = z.strictObject({
  type: csv(memoryTypes).optional(),
  status: csv(['active', 'superseded', ...adrStatuses] as const).optional(),
  lifecycle: z
    .string()
    .max(100)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(['active', 'stale', 'archived', 'all'])).min(1))
    .optional(),
  tag: z.union([z.string().max(80), z.array(z.string().max(80)).max(10)]).optional(),
  pinned: z.enum(['true', 'false']).optional(),
  anchor: z.string().min(1).max(256).optional(),
  q_title: z.string().min(1).max(200).optional(),
  sort: z.enum(['updated', 'created', 'verified', 'number']).default('updated'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  ...paginationQuery,
})
export type ListQuery = z.infer<typeof listQuery>

export const revisionsQuery = z.strictObject({ ...paginationQuery })
/** `from`: the space of the item the link is written in; it only sets the slug precedence (default docs). */
export const resolveQuery = z.strictObject({
  ref: z.string().min(1).max(200),
  from: z.enum(spaces).optional(),
})

// ---- bearer (CLI) -------------------------------------------------------------------------------------

export const pushRequest = z.strictObject({
  space: z.enum(['decisions', 'docs']),
  source_path: z.string().min(1).max(256),
  content: z.string().max(400_000),
  base_revision: z.number().int().min(1).optional(),
  force: z.boolean().optional(),
})
export type PushRequest = z.infer<typeof pushRequest>

export const adrImportRequest = z.strictObject({
  files: z
    .array(z.strictObject({ source_path: z.string().min(1).max(256), content: z.string().max(400_000) }))
    .min(1)
    .max(100),
  reserve_above: z.number().int().min(0).max(99999).optional(),
})
export type AdrImportRequest = z.infer<typeof adrImportRequest>
