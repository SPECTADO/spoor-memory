/**
 * Backups, restore and async export tasks (0.8; api.md section 13, ADR-0038 to ADR-0041). Request schemas,
 * response shapes and the small pure helpers the server and the SPA both need (ids, phrases, slugs, previews).
 * Every `/api/v1/backups*` route is instance-admin only and cookie only.
 */
import { z } from 'zod'
import { nameSchema, PASSWORD_MAX } from './auth.js'
import { projectSlugSchema } from './projects.js'

// ---- backup ids and kinds ------------------------------------------------------------------------------

export const BACKUP_KINDS = ['auto', 'manual', 'pre-restore'] as const
export type BackupKind = (typeof BACKUP_KINDS)[number]

/** `20261120T030000Z-auto`: the UTC start time and the kind. Checked on every route (no path traversal). */
export const BACKUP_ID_RE = /^\d{8}T\d{6}Z-(auto|manual|pre-restore)$/

export function isBackupId(id: string): boolean {
  return BACKUP_ID_RE.test(id)
}

export const backupIdSchema = z.string().max(40).regex(BACKUP_ID_RE, 'not a backup id')

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** `YYYYMMDD` in UTC. */
export function utcDateStamp(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
}

/** The id of a backup started at `at` (seconds precision, UTC). */
export function backupIdFor(at: Date, kind: BackupKind): string {
  const time = `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`
  return `${utcDateStamp(at)}T${time}Z-${kind}`
}

/** The start time and kind encoded in a backup id; null for anything that is not one. */
export function parseBackupId(id: string): { at: Date; kind: BackupKind } | null {
  if (!isBackupId(id)) return null
  const y = Number(id.slice(0, 4))
  const mo = Number(id.slice(4, 6))
  const d = Number(id.slice(6, 8))
  const h = Number(id.slice(9, 11))
  const mi = Number(id.slice(11, 13))
  const s = Number(id.slice(13, 15))
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  // reject 20261340T… and the like: the date must round-trip
  if (at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null
  return { at, kind: id.slice(17) as BackupKind }
}

// ---- settings (instance_settings key 'backup', ADR-0040) -------------------------------------------------

export const BACKUP_TIER_EVERY = ['24h', '48h', '7d'] as const
export type BackupTierEvery = (typeof BACKUP_TIER_EVERY)[number]
export const BACKUP_TIER_HOURS: Record<BackupTierEvery, number> = { '24h': 24, '48h': 48, '7d': 168 }
export const BACKUP_TIER_KEEP_MAX = 90
export const BACKUP_TIERS_MAX = 3

/** The schedule job looks every 15 minutes whether a backup is due (a design constant). */
export const BACKUP_JOB_EVERY_S = 900
/** A pre-restore backup is kept at least this long; older ones are pruned like auto backups. */
export const PRE_RESTORE_KEEP_DAYS = 14
/** The safety archive written before a project overwrite is kept this long. */
export const SAFETY_ARCHIVE_KEEP_DAYS = 14

export const backupTierSchema = z.strictObject({
  every: z.enum(BACKUP_TIER_EVERY),
  keep: z.number().int().min(1).max(BACKUP_TIER_KEEP_MAX),
})
export type BackupTier = z.output<typeof backupTierSchema>

/** `HH:MM`, 00:00 to 23:59, UTC. */
export const BACKUP_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

export const DEFAULT_BACKUP_TIERS: readonly BackupTier[] = [
  { every: '24h', keep: 3 },
  { every: '7d', keep: 2 },
]

/**
 * The stored and the PUT shape. Missing fields take the defaults: off until an instance admin enables it,
 * 03:00 UTC, 3 daily and 2 weekly, per-project archives on. Tiers: 1 to 3, each `every` at most once.
 */
export const backupSettingsSchema = z.strictObject({
  enabled: z.boolean().default(false),
  time_utc: z.string().regex(BACKUP_TIME_RE, 'HH:MM, 00:00 to 23:59 (UTC)').default('03:00'),
  tiers: z
    .array(backupTierSchema)
    .min(1)
    .max(BACKUP_TIERS_MAX)
    .refine((t) => new Set(t.map((x) => x.every)).size === t.length, 'each interval may appear only once')
    .default(() => DEFAULT_BACKUP_TIERS.map((t) => ({ ...t }))),
  project_archives: z.boolean().default(true),
})
export type BackupSettings = z.output<typeof backupSettingsSchema>
export type BackupSettingsInput = z.input<typeof backupSettingsSchema>

/** `PUT /api/v1/backups/settings` body: the whole settings object (missing fields take the defaults). */
export const backupSettingsPutRequest = backupSettingsSchema

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = backupSettingsSchema.parse({})

/**
 * Read a stored value leniently: anything invalid (an older or hand-edited row) falls back to the defaults
 * field by field, so a bad row never breaks the page or the job.
 */
export function resolveBackupSettings(stored: unknown): BackupSettings {
  const whole = backupSettingsSchema.safeParse(stored ?? {})
  if (whole.success) return whole.data
  const src = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>
  const out: BackupSettings = {
    ...DEFAULT_BACKUP_SETTINGS,
    tiers: DEFAULT_BACKUP_SETTINGS.tiers.map((t) => ({ ...t })),
  }
  const shape = backupSettingsSchema.shape
  const enabled = shape.enabled.safeParse(src.enabled)
  if (enabled.success) out.enabled = enabled.data
  const time = shape.time_utc.safeParse(src.time_utc)
  if (time.success) out.time_utc = time.data
  const tiers = shape.tiers.safeParse(src.tiers)
  if (tiers.success) out.tiers = tiers.data
  const pa = shape.project_archives.safeParse(src.project_archives)
  if (pa.success) out.project_archives = pa.data
  return out
}

/** How often an auto backup is made: the smallest tier interval, in hours. */
export function backupCadenceHours(tiers: readonly BackupTier[]): number {
  return Math.min(...tiers.map((t) => BACKUP_TIER_HOURS[t.every]))
}

/**
 * The "keeps up to N backups" preview: at most one auto backup per kept bucket of every tier (buckets of
 * different tiers may share a backup, so this is an upper bound). Manual, pinned and recent pre-restore
 * backups are kept on top of it.
 */
export function maxKeptAutoBackups(tiers: readonly BackupTier[]): number {
  return tiers.reduce((n, t) => n + t.keep, 0)
}

// ---- backup.json (the bundle manifest) -----------------------------------------------------------------

export const BACKUP_FORMAT = 'spoor-backup/1'
/** The per-project archive was not written; the project is restorable only by a full restore. */
export const BACKUP_SKIP_REASONS = ['busy', 'too_large', 'error', 'disabled'] as const
export type BackupSkipReason = (typeof BACKUP_SKIP_REASONS)[number]

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 hex')
/** A bundle-relative path: `database.dump` or `projects/<slug>.zip`; never absolute, never `..`. */
const bundlePath = z
  .string()
  .max(200)
  .regex(/^(database\.dump|projects\/(_shared|[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\.zip)$/, 'bundle path')

export const backupFileSchema = z.object({
  path: bundlePath,
  size: z.number().int().nonnegative(),
  sha256: sha256Hex,
})
export type BackupFile = z.output<typeof backupFileSchema>

export const backupMigrationSchema = z.object({
  /** Applied drizzle migrations at backup time (journal entries). */
  count: z.number().int().nonnegative(),
  /** The newest migration's tag, e.g. `0010_backups`; null on an empty journal. */
  last_tag: z.string().max(200).nullable(),
})
export type BackupMigration = z.output<typeof backupMigrationSchema>

export const backupManifestProjectSchema = z.object({
  id: z.uuid(),
  slug: z.string().max(40),
  name: z.string().max(100),
  kind: z.enum(['project', 'shared']),
  /** Items in the project at backup time. */
  items: z.number().int().nonnegative(),
  /** `projects/<slug>.zip`, or null when the archive was skipped. */
  archive: bundlePath.nullable(),
  /** The archive keeps revisions and audit rows (false after the size-cap retry). */
  history: z.boolean(),
  skipped_reason: z.enum(BACKUP_SKIP_REASONS).optional(),
})
export type BackupManifestProject = z.output<typeof backupManifestProjectSchema>

/** `backup.json`. Readers ignore unknown fields (a newer 1.x writer may add some). */
export const backupManifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  id: backupIdSchema,
  kind: z.enum(BACKUP_KINDS),
  created_at: z.iso.datetime(),
  spoor_version: z.string().max(50),
  migration: backupMigrationSchema,
  pg_server_version: z.string().max(200),
  pg_dump_version: z.string().max(200),
  files: z.array(backupFileSchema).max(10_000),
  projects: z.array(backupManifestProjectSchema).max(10_000),
  pinned: z.boolean(),
  /** Last successful verify (sha256 + pg_restore list); set by the backup run itself and by `POST …/verify`. */
  verified_at: z.iso.datetime().nullable(),
})
export type BackupManifest = z.output<typeof backupManifestSchema>

// ---- GET /api/v1/backups ---------------------------------------------------------------------------------

/** Why backups cannot run here (`status.available === false`). */
export const BACKUP_UNAVAILABLE_REASONS = [
  /** `SPOOR_BACKUP_DIR` is not set. */
  'no_backup_dir',
  /** The directory is missing or not writable by the app. */
  'dir_not_writable',
  /** pg_dump / pg_restore / psql not found (`SPOOR_PG_BIN_DIR`, PATH). */
  'pg_tools_missing',
  /** The database server's major version is newer than the client tools'. */
  'pg_version_mismatch',
] as const
export type BackupUnavailableReason = (typeof BACKUP_UNAVAILABLE_REASONS)[number]

export const BACKUP_OPERATIONS = ['backup', 'restore', 'verify'] as const
export type BackupOperation = (typeof BACKUP_OPERATIONS)[number]

/** The heavy operation running anywhere on the instance (advisory lock), or null. */
export interface BackupRunningJson {
  operation: BackupOperation
  /** The backup being written, restored or verified. */
  backup_id: string
  kind: BackupKind | null
  started_at: string
}

export interface BackupStatusJson {
  available: boolean
  reason?: BackupUnavailableReason
  /** Human detail for `reason` (no secrets): the missing binary, the two versions. */
  reason_message?: string
  /** `SPOOR_BACKUP_DIR`, null when unset. */
  dir: string | null
  /** Free bytes on the backup volume (`fs.statfs`), null when unknown. */
  free_bytes: number | null
  /** `pg_dump --version` output, e.g. `pg_dump (PostgreSQL) 17.6`; null when missing. */
  pg_dump_version: string | null
  /** `SHOW server_version`. */
  server_version: string | null
  /** Newest verified backup of any kind. */
  last_good_at: string | null
  /** Next scheduled slot; null while the schedule is off or unavailable. */
  next_due_at: string | null
  /** Scheduled backups are on and the newest good one is older than twice the cadence. */
  overdue: boolean
  running: BackupRunningJson | null
}

/** One bundle in the list (from its backup.json; directories without a valid one are never listed). */
export interface BackupItemJson {
  id: string
  kind: BackupKind
  created_at: string
  /** Sum of the bundle's files. */
  size_bytes: number
  pinned: boolean
  verified_at: string | null
  spoor_version: string
  migration: BackupMigration
  pg_server_version: string
  /** Projects in the dump (including `_shared`). */
  projects: number
  /** Projects without a per-project archive (restorable only by a full restore). */
  projects_skipped: number
  /** False when the backup has more migrations than this server knows (full restore: `backup_too_new`). */
  restorable: boolean
  /** Pruning would keep it regardless of the tiers: manual, pinned, a young pre-restore, the newest good one. */
  protected: boolean
}

export interface BackupListResponse {
  status: BackupStatusJson
  settings: BackupSettings
  /** Newest first. */
  items: BackupItemJson[]
}

/** `PUT /api/v1/backups/settings` answer. */
export interface BackupSettingsResponse {
  settings: BackupSettings
  next_due_at: string | null
}

/** `POST /api/v1/backups` (202): a manual backup started in the background. */
export interface BackupStartedResponse {
  backup: { id: string; kind: BackupKind; started_at: string }
}

export const backupPatchRequest = z.strictObject({ pinned: z.boolean() })
export type BackupPatchRequest = z.input<typeof backupPatchRequest>

/** `POST /api/v1/backups/:id/verify`. */
export interface BackupVerifyResponse {
  ok: boolean
  /** One line per failed check (`database.dump: sha256 mismatch`), empty when ok. */
  problems: string[]
  item: BackupItemJson
}

// ---- full restore (ADR-0039) -----------------------------------------------------------------------------

/** The phrase the admin types to confirm a full restore, from the backup's start time (UTC, minutes). */
export function restorePhrase(createdAt: Date): string {
  const d = createdAt
  return `RESTORE ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** A prepare token is good for this long, bound to the session and the backup, in memory only. */
export const RESTORE_TOKEN_TTL_S = 300

export const RESTORE_WARNING_CODES = [
  /** Everything written after the backup is lost. */
  'data_loss',
  /** Every session ends: everyone logs in again. */
  'logout',
  /** The backup is from an older schema; newer migrations run after the restore. */
  'older_schema',
  /** The backup was made by another Spoor version. */
  'other_version',
  /** The backup was never verified, or its last verify is old. */
  'not_verified',
  /** Some projects have no per-project archive (they are in the dump all the same). */
  'projects_skipped',
  /** Tokens revoked or deleted after the backup stay revoked; tokens created after it are gone. */
  'tokens',
  /** Credentials are not rewound: disabled users, newer passwords, used or revoked invites stay as they are now. */
  'security',
] as const
export type RestoreWarningCode = (typeof RESTORE_WARNING_CODES)[number]

export interface RestoreWarningJson {
  code: RestoreWarningCode
  message: string
}

/** `POST /api/v1/backups/:id/restore/prepare` (no body). */
export interface RestorePrepareResponse {
  token: string
  expires_at: string
  /** Type exactly this, e.g. `RESTORE 2026-11-20 03:00`. */
  phrase: string
  backup: BackupItemJson
  summary: {
    created_at: string
    spoor_version: string
    /** The backup's migrations vs this server's. */
    migration: { backup: BackupMigration; current: BackupMigration; to_apply: number }
    projects: number
    items: number
    /** A pre-restore backup of the current database is made first. */
    pre_restore_backup: true
  }
  warnings: RestoreWarningJson[]
}

export const restoreConfirmRequest = z.strictObject({
  token: z.string().min(1).max(200),
  password: z
    .string()
    .min(1)
    .max(4 * PASSWORD_MAX),
  phrase: z.string().min(1).max(100),
})
export type RestoreConfirmRequest = z.input<typeof restoreConfirmRequest>

export const RESTORE_STATES = ['idle', 'running', 'done', 'interrupted', 'failed'] as const
export type RestoreState = (typeof RESTORE_STATES)[number]

/** Phases in order; `restore-state.json` records the current one. */
export const RESTORE_PHASES = [
  'pre_restore_backup',
  'maintenance',
  'draining',
  'restoring',
  'startup',
  'done',
] as const
export type RestorePhase = (typeof RESTORE_PHASES)[number]

/**
 * `GET /api/v1/backups/restore-status`: the one route besides /healthz that answers during maintenance.
 * IA cookie; while the maintenance gate is on it also answers without a session (sessions end with the
 * restore), with `backup_id`, `pre_restore_backup_id` and `error` set to null.
 */
export interface RestoreStatusJson {
  state: RestoreState
  phase: RestorePhase | null
  backup_id: string | null
  pre_restore_backup_id: string | null
  started_at: string | null
  finished_at: string | null
  /** Safe one-line message when `failed` or `interrupted`. */
  error: string | null
  /** Maintenance gate on: every other route answers 503 `maintenance`. */
  maintenance: boolean
}

/** `POST /api/v1/backups/:id/restore` (202). */
export interface RestoreStartedResponse {
  restore: RestoreStatusJson
}

// ---- single project from a backup -----------------------------------------------------------------------

/** One project of a bundle, `GET /api/v1/backups/:id/projects`. */
export interface BackupProjectJson {
  id: string
  slug: string
  name: string
  kind: 'project' | 'shared'
  items: number
  history: boolean
  /** Has a per-project archive (otherwise: "not restorable per project; use full restore"). */
  restorable: boolean
  skipped_reason: BackupSkipReason | null
  /** A live project with the same id exists (overwrite possible; never for `_shared` in 0.8). */
  live: { slug: string; name: string } | null
  can_overwrite: boolean
  /** Prefill of the "restore as copy" form: `<slug>-r<YYYYMMDD>` (made unique) and `<name> (restored <date>)`. */
  suggested_slug: string
  suggested_name: string
}

export interface BackupProjectsResponse {
  backup_id: string
  created_at: string
  projects: BackupProjectJson[]
}

export const PROJECT_RESTORE_MODES = ['new', 'overwrite'] as const
export type ProjectRestoreMode = (typeof PROJECT_RESTORE_MODES)[number]

/**
 * `POST /api/v1/backups/:id/projects/:projectId/restore`. `new` (default) is a temporary copy to look at:
 * new ids, an editable unique slug and name, only the restoring admin as a member. `overwrite` replaces the
 * live project's items with the backup's (same ids), after the admin's password and the typed slug.
 */
export const projectRestoreRequest = z
  .strictObject({
    mode: z.enum(PROJECT_RESTORE_MODES).default('new'),
    slug: projectSlugSchema.optional(),
    name: nameSchema.optional(),
    password: z
      .string()
      .min(1)
      .max(4 * PASSWORD_MAX)
      .optional(),
    /** `overwrite`: the live project's slug, typed. */
    confirm: z.string().max(100).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.mode === 'overwrite') {
      if (r.password === undefined) ctx.addIssue({ code: 'custom', path: ['password'], message: 'required' })
      if (r.confirm === undefined) ctx.addIssue({ code: 'custom', path: ['confirm'], message: 'required' })
      if (r.slug !== undefined || r.name !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['mode'], message: 'slug and name are for mode "new" only' })
      }
    }
  })
export type ProjectRestoreRequest = z.input<typeof projectRestoreRequest>

export interface ProjectRestoreResponse {
  mode: ProjectRestoreMode
  project: { id: string; slug: string; name: string }
  counts: { items: number; revisions: number; edges: number; audit: number }
  /** `overwrite`: the safety archive of the project as it was (`exports/safety-<slug>-<ts>.zip`, 14 days). */
  safety_archive: string | null
  /** `new`: the copy's marker; null for an overwrite. */
  restored_from: RestoredFromJson | null
  notes: string[]
}

/** `projects.restored_from`: the project is a restored copy ("Restored copy, delete when done" banner). */
export interface RestoredFromJson {
  backup_id: string
  source_slug: string
  restored_at: string
}

const COPY_SUFFIX_LEN = 10 // '-rYYYYMMDD'

/** `<slug>-r<YYYYMMDD>`, shortened to fit 40 characters; `_shared` becomes `shared-r…`. */
export function restoredCopySlug(sourceSlug: string, at: Date): string {
  const base =
    sourceSlug
      .replace(/^_+/, '')
      .slice(0, 40 - COPY_SUFFIX_LEN)
      .replace(/-+$/, '') || 'project'
  return `${base}-r${utcDateStamp(at)}`
}

/** `<name> (restored YYYY-MM-DD)`, cut to the 100-character name limit. */
export function restoredCopyName(sourceName: string, backupAt: Date): string {
  const d = backupAt
  const suffix = ` (restored ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())})`
  return `${sourceName.slice(0, 100 - suffix.length).trimEnd()}${suffix}`
}

// ---- async export tasks (ADR-0041) ----------------------------------------------------------------------

export const EXPORT_FORMATS = ['markdown'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]
export const EXPORT_TASK_STATUSES = ['queued', 'running', 'ready', 'failed', 'expired'] as const
export type ExportTaskStatus = (typeof EXPORT_TASK_STATUSES)[number]
/** Open = queued or running; a user may have at most this many (one more is 503 `too_many_pending`). */
export const EXPORT_TASKS_OPEN_MAX = 3
/** A ready file is deleted (status `expired`) after this long. */
export const EXPORT_READY_KEEP_HOURS = 24
/** The SPA polls a task list this often while a task is queued or running. */
export const EXPORT_TASK_POLL_MS = 5000

export function isOpenExportTask(status: ExportTaskStatus): boolean {
  return status === 'queued' || status === 'running'
}

/** `spoor-<slug>-markdown-<YYYYMMDD>.zip` (`_shared` keeps its slug). */
export function markdownZipFileName(slug: string, at: Date): string {
  return `spoor-${slug}-markdown-${utcDateStamp(at)}.zip`
}

/** `POST /api/v1/projects/:slug/exports` and `POST /api/v1/backups/:id/projects/:projectId/exports`. */
export const exportTaskCreateRequest = z.strictObject({
  format: z.enum(EXPORT_FORMATS).default('markdown'),
})
export type ExportTaskCreateRequest = z.input<typeof exportTaskCreateRequest>

export interface ExportTaskJson {
  id: string
  format: ExportFormat
  status: ExportTaskStatus
  /** `live` (a project now) or `backup` (a project archive inside a backup). */
  source: 'live' | 'backup'
  /** The live project (null once it was deleted, and for backup sources). */
  project: { id: string; slug: string; name: string } | null
  backup_id: string | null
  /** Backup source: the project's id and slug inside the backup. */
  source_project: { id: string; slug: string } | null
  requested_by: { id: string; label: string }
  file_name: string | null
  size_bytes: number | null
  sha256: string | null
  error: string | null
  created_at: string
  finished_at: string | null
  expires_at: string | null
  /** `/api/v1/exports/<id>/download` when `ready`, else null. A plain `<a download>` link (cookie GET). */
  download_url: string | null
}

export interface ExportTaskResponse {
  task: ExportTaskJson
}

/** `GET /api/v1/projects/:slug/exports`: the project's tasks of the last 7 days, newest first (bounded). */
export interface ExportTaskListResponse {
  items: ExportTaskJson[]
}
