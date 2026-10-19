/**
 * zod schemas of the archive (data-model.md section 8). Every length obeys the column CHECKs, every id is a
 * uuid, every timestamp is ISO 8601. The archive is untrusted: nothing here maps to a live user.
 */
import { ITEM_LIMITS } from '@spoor/shared'
import { z } from 'zod'
import {
  ARCHIVE_REASONS,
  CONFIDENCES,
  EDGE_KINDS,
  LIFECYCLES,
  MEMORY_TYPES,
  PROJECT_KINDS,
  PROVENANCES,
  REVISION_CHANGES,
  SPACES,
  VIAS,
} from '../../db/schema.js'

export const FORMAT = 'spoor-export/1'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const uuid = z
  .string()
  .regex(UUID_RE, 'uuid')
  .transform((s) => s.toLowerCase())
const iso = z.iso.datetime({ offset: true })
const isoNull = iso.nullable()
const label = z.string().min(1).max(200)
const labelNull = z.string().min(1).max(200).nullable()
const clientName = z.string().max(64).nullable()
const int32 = z.number().int().min(1).max(2_147_483_647)

export const manifestItem = z.strictObject({
  id: uuid,
  space: z.enum(SPACES),
  number: int32,
  adr_number: z.number().int().min(1).max(99999).nullable(),
  slug: z
    .string()
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  path: z.string().max(200),
  revision: int32,
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  pinned: z.boolean(),
  lifecycle: z.enum(LIFECYCLES),
  provenance: z.enum(PROVENANCES),
  last_verified_at: iso,
  last_used_at: isoNull,
  expires_at: isoNull,
  stale_since: isoNull,
  archived_at: isoNull,
  archive_reason: z.enum(ARCHIVE_REASONS).nullable(),
  status_changed_at: iso,
  decided_on: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  source_path: z.string().min(1).max(500).nullable(),
  push_conflict_at: isoNull,
  created_at: iso,
  created_by_label: label,
  updated_at: iso,
  updated_by_label: label,
  client_name: clientName,
})
export type ManifestItem = z.infer<typeof manifestItem>

export const manifestEdge = z.strictObject({
  id: uuid,
  src_id: uuid,
  kind: z.enum(EDGE_KINDS),
  dst_ref: z.string().min(1).max(400),
  dst_id: uuid.nullable(),
  created_at: iso,
  created_by_label: labelNull,
  client_name: clientName,
})
export type ManifestEdge = z.infer<typeof manifestEdge>

export const manifestProject = z.strictObject({
  id: uuid,
  kind: z.enum(PROJECT_KINDS),
  slug: z.string().min(1).max(40),
  name: z.string().min(1).max(100),
  description: z.string().max(2000),
  settings: z.record(z.string(), z.unknown()),
  next_item_number: int32,
  next_adr_number: int32,
})

export const manifest = z.strictObject({
  format: z.literal(FORMAT),
  exported_at: iso,
  spoor_version: z.string().max(40),
  history: z.boolean(),
  project: manifestProject,
  items: z.array(manifestItem),
  edges: z.array(manifestEdge),
})
export type Manifest = z.infer<typeof manifest>

/** What an archive says about who wrote a row, kept only as text. */
export const importedFrom = z.record(z.string(), z.unknown())

export const revisionLine = z.strictObject({
  revision: int32,
  title: z.string().min(1).max(200),
  body: z.string().max(ITEM_LIMITS.body * 2), // contentFrom applies the exact limit
  status: z.string().min(1).max(40),
  frontmatter: z.record(z.string(), z.unknown()),
  change: z.enum(REVISION_CHANGES),
  actor_label: label,
  via: z.enum(VIAS),
  client_name: clientName,
  imported_from: importedFrom.nullable(),
  created_at: iso,
})
export type RevisionLine = z.infer<typeof revisionLine>

export const auditLine = z.strictObject({
  at: iso,
  actor_label: label,
  via: z.enum(VIAS),
  client_name: clientName,
  action: z.string().min(1).max(100),
  item_id: uuid.nullable(),
  item_handle: z.string().max(60).nullable(),
  summary: z.string().max(300),
  data: z.record(z.string(), z.unknown()),
})
export type AuditLine = z.infer<typeof auditLine>

export const memoryTypeEnum = z.enum(MEMORY_TYPES)
export const confidenceEnum = z.enum(CONFIDENCES)
