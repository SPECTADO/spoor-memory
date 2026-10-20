/**
 * Drizzle schema, mirrors docs/design/data-model.md sections 2 to 4 (casing: 'snake_case').
 *
 * What Drizzle cannot express lives in hand-written migrations (src/db/migrations):
 *   0000_extensions.sql         vector + unaccent, spoor_unaccent(), spoor_append_only()
 *   0002_triggers_and_hnsw.sql  append-only triggers, edge scope trigger, HNSW index of the default model
 *   0003_library_space.sql      generated: the `library` space, memberships.library_editor, library shape check
 *   0004_library_guards.sql     library edge rules (SQLSTATE SPL01), no mcp/cli library revisions (SPL02),
 *                               reserved `l<n>` slug backfill
 * Enum-like columns are `text` + CHECK (as in the design), not Postgres enum types, so adding a value
 * is a one-line migration. The value lists are exported for the services and for zod schemas.
 */
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

// ---- value lists ---------------------------------------------------------------------------------

export const PROJECT_KINDS = ['project', 'shared'] as const
export const ROLES = ['admin', 'editor', 'viewer'] as const
export const TOKEN_ROLES = ['editor', 'viewer'] as const
export const TOKEN_KINDS = ['user', 'service'] as const
export const TOKEN_ORIGINS = ['web', 'device'] as const
export const DEVICE_STATUSES = ['pending', 'approved', 'denied', 'consumed'] as const
/** Mirrors `spaces` of @spoor/shared (drizzle-kit loads this file without workspace packages); a test pins it. */
export const SPACES = ['memories', 'decisions', 'docs', 'library'] as const
export const MEMORY_TYPES = ['decision', 'fact', 'procedure', 'observation'] as const
export const CONFIDENCES = ['low', 'medium', 'high'] as const
export const LIFECYCLES = ['active', 'stale', 'archived'] as const
export const ARCHIVE_REASONS = ['stale', 'expired', 'manual'] as const
export const PROVENANCES = ['human', 'agent'] as const
export const REVISION_CHANGES = ['create', 'update', 'status', 'supersede', 'import', 'push'] as const
export const VIAS = ['web', 'mcp', 'cli', 'import', 'system'] as const
export const EDGE_KINDS = [
  'refines',
  'supports',
  'depends_on',
  'conflicts_with',
  'supersedes',
  'drafted_from',
  'wikilink',
] as const
export const JOB_STATUSES = ['running', 'ok', 'error'] as const

// ---- custom column types -------------------------------------------------------------------------

/** sha256 digests and the like. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

/** `vector` without a typmod: the dimension is per row (`chunks.dims`), see data-model.md deviation D1. */
const vectorAny = customType<{ data: number[]; driverData: string }>({
  dataType: () => 'vector',
  toDriver: (v) => `[${v.join(',')}]`,
  fromDriver: (v) => v.slice(1, -1).split(',').map(Number),
})

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })

// ---- helpers -------------------------------------------------------------------------------------

const tstz = () => timestamp({ withTimezone: true, mode: 'date' })
const id = () => uuid().primaryKey().defaultRandom()
const raw = (s: string) => sql.raw(s)
const inList = (col: string, values: readonly string[]) =>
  raw(`${col} IN (${values.map((v) => `'${v}'`).join(',')})`)
const emptyTextArray = sql`'{}'::text[]`

// ---- 2. identity and access ----------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text().notNull(),
    name: text().notNull(),
    passwordHash: text().notNull(), // 'scrypt$17$8$1$<salt b64url>$<hash b64url>'
    isAdmin: boolean().notNull().default(false),
    sharedEditor: boolean().notNull().default(false),
    disabledAt: tstz(),
    passwordChangedAt: tstz().notNull().defaultNow(),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(t.email),
    check('users_email_check', raw(`email = lower(btrim(email)) AND email LIKE '%_@_%'`)),
    check('users_name_check', raw('length(name) BETWEEN 1 AND 100')),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    idHash: bytea().primaryKey(), // sha256(cookie value)
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: tstz().notNull().defaultNow(),
    lastSeenAt: tstz().notNull().defaultNow(), // idle expiry: last_seen_at + 14 d
    expiresAt: tstz().notNull(), // absolute: created_at + 30 d
    userAgent: text(),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
    check('sessions_user_agent_check', raw('length(user_agent) <= 300')),
  ],
)

export type InviteGrant = { project_id: string; role: (typeof ROLES)[number] }

export const invites = pgTable(
  'invites',
  {
    id: id(),
    tokenHash: bytea().notNull().unique('invites_token_hash_key'), // sha256('spi_' + 32 random bytes b64url)
    email: text(), // optional: locks the invite to one email
    isAdmin: boolean().notNull().default(false),
    sharedEditor: boolean().notNull().default(false),
    grants: jsonb().$type<InviteGrant[]>().notNull().default([]),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: tstz().notNull().defaultNow(),
    expiresAt: tstz().notNull(), // default created_at + 7 d
    usedAt: tstz(),
    usedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    revokedAt: tstz(),
    resetUserId: uuid().references(() => users.id, { onDelete: 'cascade' }), // password reset for this user
    resetRevokeTokens: boolean().notNull().default(true),
  },
  () => [
    check('invites_email_check', raw('email = lower(btrim(email))')),
    check(
      'invites_reset_check',
      raw(`reset_user_id IS NULL OR (grants = '[]'::jsonb AND NOT is_admin AND NOT shared_editor)`),
    ),
  ],
)

export const projects = pgTable(
  'projects',
  {
    id: id(),
    kind: text({ enum: PROJECT_KINDS }).notNull().default('project'),
    slug: text().notNull().unique('projects_slug_key'),
    name: text().notNull(),
    description: text().notNull().default(''),
    settings: jsonb().$type<Record<string, unknown>>().notNull().default({}), // data-model.md 2.1
    nextItemNumber: integer().notNull().default(1),
    nextAdrNumber: integer().notNull().default(1),
    embeddingModel: text().notNull(), // active model tag
    embeddingTarget: text(), // non-null while a re-embed is running
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('projects_single_shared').on(t.kind).where(sql`kind = 'shared'`),
    check('projects_kind_check', inList('kind', PROJECT_KINDS)),
    check('projects_name_check', raw('length(name) BETWEEN 1 AND 100')),
    check('projects_description_check', raw('length(description) <= 2000')),
    check('projects_next_item_number_check', raw('next_item_number >= 1')),
    check('projects_next_adr_number_check', raw('next_adr_number >= 1')),
    check(
      'projects_slug_check',
      raw(
        "(kind = 'shared' AND slug = '_shared') OR (kind = 'project' AND slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$')",
      ),
    ),
  ],
)

export const memberships = pgTable(
  'memberships',
  {
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text({ enum: ROLES }).notNull(),
    /** May write library pages (ADR-0014). Always false for an admin: the role implies the right. */
    libraryEditor: boolean().notNull().default(false),
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('memberships_user_idx').on(t.userId),
    check('memberships_role_check', inList('role', ROLES)),
  ],
)

export const tokens = pgTable(
  'tokens',
  {
    id: id(),
    kind: text({ enum: TOKEN_KINDS }).notNull(),
    tokenHash: bytea().notNull().unique('tokens_token_hash_key'), // sha256(full token string)
    prefix: text().notNull(), // first 12 chars, display only
    name: text().notNull(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    role: text({ enum: TOKEN_ROLES }), // service: required; user: optional cap (NULL = inherit)
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: tstz().notNull().defaultNow(),
    lastUsedAt: tstz(), // bumped at most once per minute
    expiresAt: tstz(), // NULL = no expiry; device-minted tokens default to +90 d
    revokedAt: tstz(),
    origin: text({ enum: TOKEN_ORIGINS }).notNull().default('web'),
  },
  (t) => [
    index('tokens_project_idx').on(t.projectId),
    index('tokens_user_idx').on(t.userId),
    check('tokens_kind_check', inList('kind', TOKEN_KINDS)),
    check('tokens_name_check', raw('length(name) BETWEEN 1 AND 100')),
    check('tokens_role_check', raw(`role IN ('editor','viewer')`)),
    check('tokens_origin_check', inList('origin', TOKEN_ORIGINS)),
    check(
      'tokens_kind_shape_check',
      raw(
        `(kind = 'user' AND user_id IS NOT NULL) OR (kind = 'service' AND user_id IS NULL AND role IS NOT NULL)`,
      ),
    ),
  ],
)

export const deviceCodes = pgTable(
  'device_codes',
  {
    id: id(),
    deviceCodeHash: bytea().notNull().unique('device_codes_device_code_hash_key'), // sha256(device_code)
    userCode: text().notNull(), // stored without dash
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    clientName: text().notNull(),
    status: text({ enum: DEVICE_STATUSES }).notNull().default('pending'),
    roleCap: text({ enum: TOKEN_ROLES }), // chosen on approval ("read-only")
    userId: uuid().references(() => users.id, { onDelete: 'cascade' }), // approver
    tokenId: uuid().references(() => tokens.id, { onDelete: 'set null' }), // minted token
    intervalS: integer().notNull().default(5),
    lastPolledAt: tstz(),
    requesterIp: text(), // shown on the approval page
    createdAt: tstz().notNull().defaultNow(),
    expiresAt: tstz().notNull(), // created_at + 10 min
    decidedAt: tstz(),
  },
  (t) => [
    uniqueIndex('device_codes_live_user_code').on(t.userCode).where(sql`status IN ('pending','approved')`),
    index('device_codes_pending_idx').on(t.createdAt).where(sql`status = 'pending'`),
    check('device_codes_user_code_check', raw("user_code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{8}$'")),
    check('device_codes_client_name_check', raw('length(client_name) BETWEEN 1 AND 64')),
    check('device_codes_status_check', inList('status', DEVICE_STATUSES)),
    check('device_codes_role_cap_check', raw(`role_cap IN ('editor','viewer')`)),
    check('device_codes_requester_ip_check', raw('length(requester_ip) <= 45')),
  ],
)

// ---- 3. content ----------------------------------------------------------------------------------

export const items = pgTable(
  'items',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    space: text({ enum: SPACES }).notNull(),
    number: integer().notNull(), // per-project counter (handles m42 / d7)
    adrNumber: integer(),
    slug: text().notNull(),
    title: text().notNull(),
    type: text({ enum: MEMORY_TYPES }), // memories only
    status: text().notNull(),
    lifecycle: text({ enum: LIFECYCLES }).notNull().default('active'),
    confidence: text({ enum: CONFIDENCES }), // memories only
    tags: text().array().notNull().default(emptyTextArray),
    anchors: text().array().notNull().default(emptyTextArray),
    frontmatter: jsonb().$type<Record<string, unknown>>().notNull().default({}), // extra/unknown keys only
    body: text().notNull().default(''),
    revision: integer().notNull().default(1),
    pinned: boolean().notNull().default(false),
    decidedOn: date({ mode: 'string' }), // decisions: frontmatter `date`
    statusChangedAt: tstz().notNull().defaultNow(),
    sourcePath: text(), // repo-relative path for mirrored ADRs/docs
    lastVerifiedAt: tstz().notNull().defaultNow(),
    lastUsedAt: tstz(),
    expiresAt: tstz(), // observations only
    staleSince: tstz(),
    archivedAt: tstz(),
    archiveReason: text({ enum: ARCHIVE_REASONS }),
    pushConflictAt: tstz(),
    provenance: text({ enum: PROVENANCES }).notNull().default('human'),
    createdAt: tstz().notNull().defaultNow(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdByLabel: text().notNull(),
    // content writes only: set by the one write statement, deliberately NO $onUpdate (data-model.md section 3)
    updatedAt: tstz().notNull().defaultNow(),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    updatedByLabel: text().notNull(),
    clientName: text(), // last writer's MCP client / 'web' / 'spoor-cli'
  },
  (t) => [
    unique('items_project_space_slug_uq').on(t.projectId, t.space, t.slug),
    unique('items_project_number_uq').on(t.projectId, t.number),
    uniqueIndex('items_adr_uq').on(t.projectId, t.adrNumber).where(sql`adr_number IS NOT NULL`),
    uniqueIndex('items_source_uq').on(t.projectId, t.sourcePath).where(sql`source_path IS NOT NULL`),
    index('items_browse_idx').on(t.projectId, t.space, t.lifecycle, t.status),
    index('items_updated_idx').on(t.projectId, t.updatedAt.desc()),
    index('items_verified_idx').on(t.projectId, t.lastVerifiedAt.desc()).where(sql`lifecycle = 'active'`),
    index('items_pinned_idx').on(t.projectId).where(sql`pinned`),
    index('items_tags_gin').using('gin', t.tags),
    index('items_anchored_idx').on(t.projectId).where(sql`cardinality(anchors) > 0`),
    index('items_cleanup_idx').on(t.projectId, t.lifecycle).where(sql`space = 'memories'`),
    check('items_space_check', inList('space', SPACES)),
    check('items_adr_number_check', raw('adr_number BETWEEN 1 AND 99999')),
    check('items_slug_check', raw("slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(slug) <= 80")),
    check('items_title_check', raw(String.raw`length(title) BETWEEN 1 AND 200 AND title !~ '[\r\n]'`)),
    check('items_lifecycle_check', inList('lifecycle', LIFECYCLES)),
    check('items_confidence_check', inList('confidence', CONFIDENCES)),
    check('items_body_check', raw('length(body) <= 200000')),
    check('items_archive_reason_check', inList('archive_reason', ARCHIVE_REASONS)),
    check('items_provenance_check', inList('provenance', PROVENANCES)),
    check('items_client_name_check', raw('length(client_name) <= 64')),
    check('items_decision_adr_check', raw(`(space = 'decisions') = (adr_number IS NOT NULL)`)),
    check(
      'items_memory_shape_check',
      raw(`(space = 'memories') = (type IS NOT NULL AND confidence IS NOT NULL)`),
    ),
    check(
      'items_memory_type_check',
      raw(`space <> 'memories' OR type IN ('decision','fact','procedure','observation')`),
    ),
    check(
      'items_status_check',
      raw(
        `CASE space WHEN 'decisions' THEN status IN ('proposed','accepted','superseded','deprecated') ELSE status IN ('active','superseded') END`,
      ),
    ),
    check('items_observation_expiry_check', raw(`(type = 'observation') = (expires_at IS NOT NULL)`)),
    check('items_stale_check', raw(`(lifecycle = 'stale') = (stale_since IS NOT NULL)`)),
    check(
      'items_archived_check',
      raw(`(lifecycle = 'archived') = (archived_at IS NOT NULL AND archive_reason IS NOT NULL)`),
    ),
    check('items_array_limits_check', raw('cardinality(tags) <= 20 AND cardinality(anchors) <= 20')),
    // library pages: human-written, never mirrored, pinned, expiring or stale (ADR-0014)
    check(
      'items_library_shape_check',
      sql`${t.space} <> 'library' OR (${t.sourcePath} IS NULL AND ${t.pushConflictAt} IS NULL AND ${t.pinned} = false AND ${t.expiresAt} IS NULL AND ${t.staleSince} IS NULL AND ${t.lifecycle} IN ('active','archived') AND ${t.provenance} = 'human' AND ${t.status} = 'active')`,
    ),
  ],
)

/** Append-only (trigger in 0002): full snapshot per content revision. */
export const itemRevisions = pgTable(
  'item_revisions',
  {
    itemId: uuid()
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }), // cascade only under spoor.allow_purge
    revision: integer().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    status: text().notNull(),
    frontmatter: jsonb().$type<Record<string, unknown>>().notNull(), // FULL canonical frontmatter
    change: text({ enum: REVISION_CHANGES }).notNull(),
    actorUserId: uuid(), // no FK: rows are immutable, users may be deleted
    actorLabel: text().notNull(),
    tokenId: uuid(), // no FK, same reason
    via: text({ enum: VIAS }).notNull(),
    clientName: text(),
    importedFrom: jsonb().$type<Record<string, unknown>>(), // zip import only; untrusted text
    createdAt: tstz().notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.revision] }),
    check('item_revisions_change_check', inList('change', REVISION_CHANGES)),
    check('item_revisions_via_check', inList('via', VIAS)),
  ],
)

export const chunks = pgTable(
  'chunks',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    itemId: uuid()
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    projectId: uuid().notNull(), // denormalised for filtering
    space: text().notNull(), // denormalised for filtering
    ordinal: integer().notNull(),
    itemRevision: integer().notNull(), // revision the chunk was built from
    text: text().notNull(), // chunk text incl. heading-path prefix (no 'passage: ')
    model: text().notNull(), // model tag
    dims: smallint().notNull(),
    embedding: vectorAny(), // untyped vector; NULL = pending embedding
    tsv: tsvector().generatedAlwaysAs(sql`to_tsvector('simple', spoor_unaccent(text))`),
  },
  (t) => [
    unique('chunks_item_model_ordinal_uq').on(t.itemId, t.model, t.ordinal),
    index('chunks_tsv_gin').using('gin', t.tsv),
    index('chunks_scope_idx').on(t.projectId, t.model, t.space),
    index('chunks_pending_idx').on(t.model).where(sql`embedding IS NULL`),
    check('chunks_ordinal_check', raw('ordinal >= 0')),
    check('chunks_dims_check', raw('dims BETWEEN 1 AND 2000')),
    check('chunks_embedding_dims_check', raw('embedding IS NULL OR vector_dims(embedding) = dims')),
    // partial expression HNSW index per model tag: 0002_triggers_and_hnsw.sql (default model), re-embed job (others)
  ],
)

export const edges = pgTable(
  'edges',
  {
    id: id(),
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }), // project of src
    srcId: uuid()
      .notNull()
      .references(() => items.id, { onDelete: 'cascade' }),
    kind: text({ enum: EDGE_KINDS }).notNull(),
    dstRef: text().notNull(),
    dstId: uuid().references(() => items.id, { onDelete: 'set null' }), // NULL = dangling
    createdAt: tstz().notNull().defaultNow(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdByLabel: text(),
    clientName: text(),
  },
  (t) => [
    unique('edges_src_kind_dst_ref_uq').on(t.srcId, t.kind, t.dstRef),
    index('edges_dst_idx').on(t.dstId, t.kind),
    index('edges_dangling_idx').on(t.projectId, t.dstRef).where(sql`dst_id IS NULL`),
    check('edges_kind_check', inList('kind', EDGE_KINDS)),
    check('edges_no_self_loop_check', raw('src_id <> dst_id')),
    // scope trigger spoor_edge_scope: 0002_triggers_and_hnsw.sql
  ],
)

// ---- 4. audit and jobs ---------------------------------------------------------------------------

/** Append-only (trigger in 0002). No FKs: rows are immutable and outlive users, tokens, items, projects. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: tstz().notNull().defaultNow(),
    projectId: uuid(), // NULL = instance-level
    actorUserId: uuid(),
    actorLabel: text().notNull(),
    tokenId: uuid(),
    via: text({ enum: VIAS }).notNull(),
    clientName: text(),
    action: text().notNull(),
    itemId: uuid(),
    itemHandle: text(), // snapshot 'm42' / 'ADR-0007'
    summary: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('audit_project_idx').on(t.projectId, t.at.desc()),
    index('audit_item_idx').on(t.itemId, t.at.desc()).where(sql`item_id IS NOT NULL`),
    check('audit_log_via_check', inList('via', VIAS)),
    check('audit_log_summary_check', raw('length(summary) <= 300')),
  ],
)

/** Scheduler lease, one row per job name (seeded at startup). */
export const jobLocks = pgTable(
  'job_locks',
  {
    name: text().primaryKey(),
    lockedUntil: tstz().notNull().default(sql`'-infinity'`),
    lockedBy: text(), // instance id (hostname:pid)
    lastRunAt: tstz(),
    lastStatus: text({ enum: ['ok', 'error'] }),
    lastError: text(),
  },
  () => [check('job_locks_last_status_check', raw(`last_status IN ('ok','error')`))],
)

/** History for the admin UI; pruned to 30 days. */
export const jobRuns = pgTable(
  'job_runs',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    name: text().notNull(),
    projectId: uuid(),
    startedAt: tstz().notNull().defaultNow(),
    finishedAt: tstz(),
    status: text({ enum: JOB_STATUSES }).notNull(),
    stats: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    error: text(),
  },
  (t) => [
    index('job_runs_name_idx').on(t.name, t.startedAt.desc()),
    check('job_runs_status_check', inList('status', JOB_STATUSES)),
  ],
)

export const TABLES = {
  users,
  sessions,
  invites,
  projects,
  memberships,
  tokens,
  deviceCodes,
  items,
  itemRevisions,
  chunks,
  edges,
  auditLog,
  jobLocks,
  jobRuns,
} as const
