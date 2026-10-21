/**
 * Response and request shapes the SPA uses (docs/design/api.md). Everything `@spoor/shared` defines is re-exported
 * (or aliased under the SPA's older name, e.g. `LoginBody = LoginRequest`) from there, never copied (deviations G5,
 * H12); the rest mirrors the server's route handlers (packages/server/src/modules/*) and moves to `@spoor/shared`
 * when the server exports it.
 */
import type {
  ActorJson,
  AuditRowJson,
  adrStatuses,
  ConflictReviewRow,
  confidences,
  DashboardResponse,
  DeviceApproveResponse,
  DeviceLookupResponse,
  ExpiringReviewRow,
  INVITE_STATUSES,
  InviteAcceptRequest,
  InviteCreateRequest,
  ItemSummary,
  LastRequestJson,
  LoginRequest,
  MemberJson,
  MeResponse,
  memoryTypes,
  ProjectCreateRequest,
  ProjectJson,
  ProjectListItem,
  ProjectPatchRequest,
  ProjectRole,
  PushConflictReviewRow,
  RequestKind,
  RequestRowJson,
  RequestSurface,
  ReviewBulkRequest,
  ReviewBulkResponse,
  ReviewCounts,
  ReviewSection,
  relationKinds,
  Space,
  StaleReviewRow,
  TokenCreateRequest,
  TokenCreateResponse,
  TokenJson,
  UndraftedDecision,
  UndraftedDecisionsResponse,
  UserJson,
  UserPatchRequest,
} from '@spoor/shared'

export { REVIEW_SECTIONS } from '@spoor/shared'
export type {
  ActorJson,
  AuditRowJson,
  DeviceApproveResponse,
  ItemSummary,
  LastRequestJson,
  MemberJson,
  MeResponse,
  ProjectCreateRequest,
  ProjectJson,
  ProjectListItem,
  ProjectPatchRequest,
  ProjectRole,
  RequestKind,
  RequestRowJson,
  RequestSurface,
  ReviewCounts,
  ReviewSection,
  Space,
  TokenCreateRequest,
  TokenCreateResponse,
  TokenJson,
  UndraftedDecision,
  UndraftedDecisionsResponse,
  UserJson,
}

// ---- conventions (api.md §0.5) -----------------------------------------------------------------------

/** A cursor-paginated list. */
export interface Page<T> {
  items: T[]
  next_cursor: string | null
}
/** A bounded list (`{items}` without a cursor). */
export interface ItemsOf<T> {
  items: T[]
}
export interface PageParams {
  cursor?: string
  limit?: number
}

// ---- auth, instance (api.md §1) ----------------------------------------------------------------------

export type LoginBody = LoginRequest
export interface PasswordChangeBody {
  current_password: string
  new_password: string
}
export interface InstanceJson {
  version: string
  public_url: string
  providers: { name: string; tag: string; dims: number; remote: boolean }[]
  default_provider: string
}

// ---- invites and users (api.md §2) -------------------------------------------------------------------

export type InviteStatus = (typeof INVITE_STATUSES)[number]
export interface InviteGrant {
  project: { slug: string; name: string }
  role: ProjectRole
}
export interface InvitePreview {
  email: string | null
  is_admin: boolean
  shared_editor: boolean
  reset: boolean
  grants: InviteGrant[]
  expires_at: string
}
export type InviteAcceptBody = InviteAcceptRequest
export interface InviteJson {
  id: string
  email: string | null
  is_admin: boolean
  shared_editor: boolean
  reset: boolean
  reset_user_id: string | null
  grants: InviteGrant[]
  status: InviteStatus
  created_by: string | null
  created_at: string
  expires_at: string
  used_at: string | null
  used_by: string | null
  revoked_at: string | null
}
export type InviteCreateBody = InviteCreateRequest
export interface InviteCreateResponse {
  invite: InviteJson
  /** `spi_…`, shown once. */
  token: string
  link: string
}
export interface InviteFilters extends PageParams {
  status?: InviteStatus
}
export interface AdminUserJson extends UserJson {
  disabled_at: string | null
  created_at: string
  memberships: MeResponse['memberships']
}
export interface UserFilters extends PageParams {
  q?: string
}
export type UserPatchBody = UserPatchRequest

// ---- device flow, browser side (api.md §3) -----------------------------------------------------------

export type DeviceLookup = DeviceLookupResponse

// ---- projects (api.md §4) ----------------------------------------------------------------------------

export type DashboardJson = DashboardResponse
export interface ContextParams {
  budget?: number
  query?: string
  file?: string[]
  include_shared?: boolean
}
export interface ContextPreview {
  text: string
  budget: number
  est_tokens: number
  items: string[]
  dropped: number
}
export interface TokenListParams {
  include_revoked?: boolean
}

// ---- items (api.md §5) -------------------------------------------------------------------------------

export type ItemJson = ItemSummary & {
  body: string
  extra: Record<string, unknown>
  created_by: { id: string | null; label: string }
  superseded_by: string | null
}
export type MemoryType = (typeof memoryTypes)[number]
export type Confidence = (typeof confidences)[number]
export type AdrStatus = (typeof adrStatuses)[number]
export type RelationKind = (typeof relationKinds)[number]
export type EdgeKind = RelationKind | 'supersedes' | 'drafted_from' | 'wikilink'

export interface ItemListFilters extends PageParams {
  type?: MemoryType[]
  status?: string[]
  /** Default on the server: `active,stale`. */
  lifecycle?: ('active' | 'stale' | 'archived' | 'all')[]
  tag?: string[]
  pinned?: boolean
  anchor?: string
  q_title?: string
  sort?: 'updated' | 'created' | 'verified' | 'number'
  dir?: 'asc' | 'desc'
}
export interface ItemWarning {
  code: 'near_duplicate' | 'embedding_pending' | 'mirrored_item' | string
  handle?: string
  cos?: number
  title?: string
  source_path?: string
  [key: string]: unknown
}
export interface ItemCreateBody {
  title: string
  body?: string
  tags?: string[]
  anchors?: string[]
  pinned?: boolean
  slug?: string
  extra?: Record<string, unknown>
  relations?: { kind: RelationKind; to: string }[]
  supersedes?: string
  type?: MemoryType
  confidence?: Confidence
  allow_duplicate?: boolean
  status?: AdrStatus
  adr_number?: number
  decided_on?: string
}
export interface ItemPatchBody {
  /** The revision the user last saw (required; never last-write-wins). */
  revision: number
  title?: string
  body?: string
  type?: MemoryType
  confidence?: Confidence
  status?: string
  tags?: string[]
  anchors?: string[]
  extra?: Record<string, unknown>
  decided_on?: string | null
}
export interface ItemWriteResponse {
  item: ItemJson
  warnings: ItemWarning[]
}
export type ItemAction = 'pin' | 'unpin' | 'verify' | 'archive'
export interface RestoreBody {
  note?: string
  promote_to_fact?: boolean
  revision?: number
}
export interface SupersedeBody {
  new?: {
    title: string
    body?: string
    type?: MemoryType
    confidence?: Confidence
    anchors?: string[]
    tags?: string[]
  }
  new_id?: string
  revision?: number
  reason?: string
}
export interface SupersedeResponse {
  new: ItemJson
  old: ItemJson
  warnings?: ItemWarning[]
}
/** `details` of 409 `revision_conflict`. */
export interface RevisionConflictDetails {
  current_revision: number
  current: ItemJson
}

export interface RevisionSummary {
  revision: number
  title: string
  status: string
  change: 'create' | 'update' | 'status' | 'supersede' | 'import' | 'push' | string
  actor: ActorJson
  created_at: string
}
export interface RevisionSnapshot extends RevisionSummary {
  body: string
  frontmatter: Record<string, unknown>
}

export interface EdgeJson {
  id: string
  kind: EdgeKind
  editable: boolean
  /** `null` for a dangling wikilink (see `dst_ref`). */
  other: ItemSummary | null
  dst_ref?: string
}
export interface EdgesResponse {
  outgoing: EdgeJson[]
  incoming: EdgeJson[]
}

// ---- search (api.md §6) ------------------------------------------------------------------------------

export interface SearchParams {
  q: string
  space?: Space
  type?: MemoryType
  tag?: string[]
  limit?: number
  include_shared?: boolean
  include_inactive?: boolean
}
export interface SearchHit {
  item: ItemSummary
  score: number
  snippet: string
}
export interface SearchResponse {
  items: SearchHit[]
  notes: string[]
}

// ---- review queue (api.md §8) ------------------------------------------------------------------------

export type StaleRow = StaleReviewRow
export type ArchivedRow = ItemSummary
export type ExpiringRow = ExpiringReviewRow
export type ConflictRow = ConflictReviewRow
export type PushConflictRow = PushConflictReviewRow
export interface ReviewRowOf {
  stale: StaleRow
  archived: ArchivedRow
  expiring: ExpiringRow
  conflicts: ConflictRow
  push_conflicts: PushConflictRow
}
export type ReviewRow = ReviewRowOf[ReviewSection]
export type ReviewBulkBody = ReviewBulkRequest
export type ReviewBulkResult = ReviewBulkResponse

// ---- export / import (api.md §9) ---------------------------------------------------------------------

export interface ImportResult {
  project: { slug: string }
  counts: { items: number; revisions: number; edges: number; audit: number }
  remapped: boolean
  appended_revisions: string[]
  dangling_edges: { from: string; dst_ref: string }[]
  notes: string[]
}

// ---- audit and jobs (api.md §10) ---------------------------------------------------------------------

export interface AuditFilters extends PageParams {
  /** Repeatable; a value ending in `.` is a prefix (`item.`). */
  action?: string[]
  /** Project audit only. */
  item?: string
  actor?: string
  via?: ActorJson['via']
  since?: string
  until?: string
}
/** `GET /projects/:slug/requests` (api.md §10.3): the agent request log, admins only. */
export interface RequestFilters extends PageParams {
  kind?: RequestKind
  surface?: RequestSurface
  /** Exact tool name or `METHOD /path`. */
  operation?: string
  /** Actor, token name or agent substring. */
  actor?: string
  since?: string
  until?: string
}

export interface JobRunJson {
  id: number
  name: string
  project_id: string | null
  started_at: string
  finished_at: string | null
  status: string
  stats: Record<string, unknown>
  error: string | null
}
export interface ProjectJobsJson {
  embedding: { model: string; target: string | null; remaining: number; providers_enabled: string[] }
  runs: JobRunJson[]
}
export interface InstanceJobsJson {
  scheduler: { enabled: boolean }
  jobs: {
    name: string
    every_s: number | null
    last_run_at: string | null
    last_status: string | null
    last_error: string | null
    locked_until: string | null
    locked_by: string | null
    running_here: boolean
  }[]
  recent: JobRunJson[]
}
export interface RunJobResult {
  name: string
  started: boolean
  reason?: 'disabled' | 'running' | 'stopped'
}
