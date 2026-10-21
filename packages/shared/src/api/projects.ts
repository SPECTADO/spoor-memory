/**
 * Request schemas and response shapes of projects, memberships, tokens, the audit log and `whoami`
 * (docs/design/api.md sections 4, 7.2 and 10). Shared by the server, the SPA and the CLI.
 */
import { z } from 'zod'
import { projectSettingsPatch } from '../settings.js'
import { isValidProjectSlug } from '../slug.js'
import { emailSchema, nameSchema, PROJECT_ROLES, type ProjectRole } from './auth.js'
import type { ItemSummary } from './items.js'
import type { LastRequestJson } from './requests.js'
import type { ReviewSection } from './review.js'

// ---- projects (api.md 4.1) ----------------------------------------------------------------------------

export const projectSlugSchema = z
  .string()
  .max(40)
  .refine(isValidProjectSlug, 'lower-case letters, digits and inner dashes, 1 to 40 characters, not reserved')

/** Multi-line text: only control characters other than tab and newline are dropped. */
export const descriptionSchema = z
  .string()
  .max(4000)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  .transform((s) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f‎‏‪-‮⁦-⁩]/g, ''))
  .pipe(z.string().max(2000))

export const projectCreateRequest = z.strictObject({
  slug: projectSlugSchema,
  name: nameSchema,
  description: descriptionSchema.default(''),
  settings: projectSettingsPatch.optional(),
})

/** The slug is immutable: sending it is 400 `invalid_input` (unknown field). */
export const projectPatchRequest = z.strictObject({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  settings: projectSettingsPatch.optional(),
})

export type ProjectCreateRequest = z.input<typeof projectCreateRequest>
export type ProjectPatchRequest = z.input<typeof projectPatchRequest>

export interface ProjectListItem {
  slug: string
  name: string
  description: string
  /** Effective role: `admin` for an instance admin without a membership. */
  role: ProjectRole
  /** Items that are not archived, per space. */
  counts: { memories: number; decisions: number; docs: number; library: number }
  /** Sum of the review-queue sections (cleanup-and-jobs.md section 6). */
  review_total: number
}

export interface ProjectJson {
  id: string
  slug: string
  name: string
  description: string
  kind: 'project' | 'shared'
  /** The resolved settings (defaults filled in). */
  settings: {
    cleanup: { stale_days: number; archive_days: number; observation_days: number }
    digest: { default_budget: number; decision_window_days: number }
    dedupe: { threshold: number; related_min_cos: number }
    embedding: { provider: string }
    memory: { exclusive: boolean }
  }
  /**
   * Effective role. Projects: the membership role, `admin` for an instance admin. `_shared`: `admin` for an
   * instance admin, `editor` for a shared editor, `viewer` for everyone else.
   */
  role: ProjectRole
  /**
   * The caller may create, edit, archive and restore library pages here (`library.write`): project admins,
   * instance admins and library editors; on `_shared`, shared writers. The SPA gates on this, never on role.
   */
  can_edit_library: boolean
  embedding: { model: string; target: string | null; remaining: number }
  created_at: string
}

/** Items per lifecycle in one space (`GET …/dashboard`). */
export interface LifecycleCounts {
  active: number
  stale: number
  archived: number
}

/**
 * What `recent` rows report: a content change (`create`, `update`, `supersede` (the old item became
 * superseded), `push` (a repo push wrote it)) or a lifecycle change (`stale`, `archive`, `expire` (an
 * observation passed its expiry), `restore`).
 */
export const DASHBOARD_CHANGES = [
  'create',
  'update',
  'supersede',
  'push',
  'stale',
  'archive',
  'expire',
  'restore',
] as const
export type DashboardChange = (typeof DASHBOARD_CHANGES)[number]

/** `GET /api/v1/projects/:slug/dashboard` (api.md 4.1). */
export interface DashboardResponse {
  counts: {
    memories: LifecycleCounts
    decisions: LifecycleCounts
    docs: LifecycleCounts
    library: LifecycleCounts
  }
  /** The review-queue counts (the same numbers as `GET …/review`). */
  review: Record<ReviewSection, number>
  /** The last 15 content or lifecycle changes of items that still exist, newest first. */
  recent: { item: ItemSummary; change: DashboardChange; actor: ActorJson; at: string }[]
  /** The newest agent read and write in the request log (14 days), `null` when there is none. */
  last_requests: { read: LastRequestJson | null; write: LastRequestJson | null }
  /**
   * Link health (the map's defaults): `unlinked_items` = active or stale items of the project, status not
   * superseded or deprecated, with no edge of any kind in either direction; `dangling_refs` = distinct refs of
   * dangling wikilinks written in such items.
   */
  links: { unlinked_items: number; dangling_refs: number }
}

// ---- memberships (api.md 4.2) -------------------------------------------------------------------------

/** `library_editor` defaults to false and is ignored (stored false) for an admin: admin implies the right. */
export const memberAddRequest = z.strictObject({
  email: emailSchema,
  role: z.enum(PROJECT_ROLES),
  library_editor: z.boolean().optional(),
})

/**
 * `PUT …/members/:userId`: a role, the library-editor flag, or both. Promoting to admin clears the stored
 * flag; demoting from admin sets it to `library_editor ?? false` (auth-and-security.md section 7).
 */
export const memberUpdateRequest = z
  .strictObject({
    role: z.enum(PROJECT_ROLES).optional(),
    library_editor: z.boolean().optional(),
  })
  .refine((v) => v.role !== undefined || v.library_editor !== undefined, {
    message: 'send role, library_editor or both',
  })
export type MemberUpdateRequest = z.input<typeof memberUpdateRequest>
/** The older name of `memberUpdateRequest`. */
export const memberRoleRequest = memberUpdateRequest

export interface MemberJson {
  user: { id: string; email: string; name: string }
  role: ProjectRole
  /** The stored flag: always false for an admin (the role implies the right). */
  library_editor: boolean
  created_at: string
}

// ---- tokens (api.md 4.3, auth-and-security.md section 5) ----------------------------------------------

/** User tokens: `spr_` + 32 random bytes base64url (47 characters). Service tokens use `sprs_`. */
export const USER_TOKEN_PREFIX = 'spr_'
export const SERVICE_TOKEN_PREFIX = 'sprs_'
/** `tokens.prefix`: the first 12 characters, for display. */
export const TOKEN_DISPLAY_LENGTH = 12
export const TOKEN_RE = /^sprs?_[A-Za-z0-9_-]{43}$/

/** Shape check only (no lookup): what the CLI validates before saving a pasted token. */
export function looksLikeToken(s: string): boolean {
  return TOKEN_RE.test(s)
}

export const TOKEN_KINDS = ['user', 'service'] as const
export const TOKEN_ROLE_CAPS = ['editor', 'viewer'] as const
export type TokenKind = (typeof TOKEN_KINDS)[number]

export const tokenCreateRequest = z
  .strictObject({
    kind: z.enum(TOKEN_KINDS),
    name: nameSchema,
    /** Service: required fixed role. User: optional cap (`viewer` = read-only), default inherit. */
    role: z.enum(TOKEN_ROLE_CAPS).optional(),
    expires_at: z.iso.datetime({ offset: true }).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'service' && v.role === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['role'],
        message: 'a service token needs a role (editor or viewer)',
      })
    }
  })
export type TokenCreateRequest = z.input<typeof tokenCreateRequest>

export interface TokenJson {
  id: string
  kind: TokenKind
  origin: 'web' | 'device'
  name: string
  prefix: string
  /** Service: the fixed role. User: the cap, `null` = inherits the membership role. */
  role: 'editor' | 'viewer' | null
  user: { id: string; label: string } | null
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
}

export interface TokenCreateResponse {
  token: TokenJson
  /** The plaintext, shown exactly once. */
  secret: string
}

// ---- whoami (api.md 7.2) ------------------------------------------------------------------------------

export interface WhoamiResponse {
  project: { slug: string; name: string; next_adr_number: number }
  token: {
    id: string
    name: string
    kind: TokenKind
    prefix: string
    role: ProjectRole
    /** ISO 8601, or null for a token without expiry (`spoor status` shows it). */
    expires_at: string | null
  }
  user: { label: string }
  server: { version: string }
}

// ---- audit (api.md 0.6 Actor, 10) ---------------------------------------------------------------------

export const AUDIT_VIAS = ['web', 'mcp', 'cli', 'import', 'system'] as const

export interface ActorJson {
  user_id: string | null
  label: string
  via: (typeof AUDIT_VIAS)[number]
  client_name: string | null
}

export interface AuditRowJson {
  id: number
  at: string
  actor: ActorJson
  action: string
  item_handle: string | null
  item_id: string | null
  summary: string
  data: Record<string, unknown>
}
