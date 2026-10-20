/**
 * The review queue's request and response shapes (docs/design/api.md section 8, cleanup-and-jobs.md
 * section 6). Shared by the server and the SPA.
 */
import { z } from 'zod'
import type { ItemSummary } from './items.js'

export const REVIEW_SECTIONS = ['stale', 'archived', 'expiring', 'conflicts', 'push_conflicts'] as const
export type ReviewSection = (typeof REVIEW_SECTIONS)[number]

/** `GET /api/v1/projects/:slug/review`. */
export interface ReviewCounts {
  counts: Record<ReviewSection, number>
}

/** Rows of `GET …/review/:section` (conflicts are pairs, every other section an `ItemSummary` plus extras). */
export type StaleReviewRow = ItemSummary & { days_to_archive: number | null; used_since_stale: boolean }
export type ExpiringReviewRow = ItemSummary & { expires_in_s: number | null }
export type PushConflictReviewRow = ItemSummary & {
  edited_by: { label: string; via: string | null; client_name: string | null; at: string }
}
export interface ConflictReviewRow {
  edge_id: string
  a: ItemSummary
  b: ItemSummary
}

export const REVIEW_BULK_ACTIONS = ['verify', 'archive'] as const
export const REVIEW_BULK_MAX = 100

/** `POST …/review/bulk`: refs are handles, uuids or slugs of the path's project. */
export const reviewBulkRequest = z.strictObject({
  action: z.enum(REVIEW_BULK_ACTIONS),
  refs: z.array(z.string().min(1).max(200)).min(1).max(REVIEW_BULK_MAX),
})
export type ReviewBulkRequest = z.input<typeof reviewBulkRequest>

/**
 * Why a bulk ref was not acted on: `not_found`, `ambiguous_id`, `read_only_space` (a shared ref from a
 * project, or a library ref without the library right), `wrong_space` (verify of a library page the caller
 * may edit: library pages are never verified), `archived` (verify of an archived item: restore first),
 * `already_archived` (archive).
 */
export type ReviewBulkSkipReason =
  | 'not_found'
  | 'ambiguous_id'
  | 'read_only_space'
  | 'wrong_space'
  | 'archived'
  | 'already_archived'

export interface ReviewBulkResponse {
  /** Handles acted on, in request order; one audit row each. */
  done: string[]
  /** `handle` is the item's handle when the ref resolved, otherwise the ref as sent. */
  skipped: { handle: string; reason: ReviewBulkSkipReason }[]
}

/**
 * A decision memory that no (non-superseded) ADR was drafted from yet: `GET /p/:slug/api/decisions/undrafted` (bearer,
 * the Stop hook's drafting run; api.md section 7.2) and its cookie twin `GET /api/v1/projects/:slug/decisions/undrafted`
 * (the review queue's "Undrafted decisions" list; api.md section 8). Created in the last 14 days, oldest first, at most 200.
 */
export interface UndraftedDecision {
  handle: string
  spoor_id: string
  title: string
  body: string
  tags: string[]
  anchors: string[]
  confidence: string | null
  created_at: string
}
export interface UndraftedDecisionsResponse {
  items: UndraftedDecision[]
}
