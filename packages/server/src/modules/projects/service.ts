/**
 * Projects and their settings (api.md section 4.1; data-model.md sections 2, 2.1, 4; auth-and-security.md
 * sections 7, 8). The shared space is the `kind='shared'` row with slug `_shared`, created at startup.
 */
import {
  mergeSettings,
  type ProjectJson,
  type ProjectListItem,
  type ProjectRole,
  type ProjectSettings,
  type ProjectSettingsPatch,
  projectSettings,
  SHARED_PROJECT_SLUG,
  settingsPatchPaths,
} from '@spoor/shared'
import { type AnyColumn, and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { auditLog, edges, items, memberships, projects } from '../../db/schema.js'
import { webActor, writeAudit } from '../../lib/audit.js'
import { allowPurge, type DbOrTx, isUniqueViolation, withTx } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError, zodIssues } from '../../lib/errors.js'
import type { EmbeddingProvider } from '../../ports.js'
import { assertCan, type UserContext, webPrincipal } from '../auth/index.js'
import { accessFor, type ProjectAccess, type ProjectRow, projectNotFound } from './access.js'

/** Stored settings with defaults filled in; a stored value the schema no longer accepts falls back to defaults. */
export function resolveSettings(stored: unknown): ProjectSettings {
  const parsed = projectSettings.safeParse(stored ?? {})
  return parsed.success ? parsed.data : projectSettings.parse({})
}

/** Validate a merged settings object, reporting issues under `settings.` (400 `invalid_input`). */
function validateSettings(stored: Record<string, unknown>): ProjectSettings {
  const parsed = projectSettings.safeParse(stored)
  if (!parsed.success) {
    throw new ApiError('invalid_input', {
      message: 'Invalid settings.',
      details: { issues: zodIssues(parsed.error).map((i) => ({ ...i, path: `settings.${i.path}` })) },
    })
  }
  return parsed.data
}

/** Counts per space (not archived) and the review-queue total, for the project list. */
async function listStats(db: DbOrTx, ids: string[]) {
  const out = new Map<string, { counts: ProjectListItem['counts']; review: number }>()
  if (ids.length === 0) return out
  for (const id of ids) out.set(id, { counts: { memories: 0, decisions: 0, docs: 0 }, review: 0 })
  const notArchived = sql`${items.lifecycle} <> 'archived'`
  const rows = await db
    .select({
      projectId: items.projectId,
      memories: sql<number>`(count(*) FILTER (WHERE ${items.space} = 'memories' AND ${notArchived}))::int`,
      decisions: sql<number>`(count(*) FILTER (WHERE ${items.space} = 'decisions' AND ${notArchived}))::int`,
      docs: sql<number>`(count(*) FILTER (WHERE ${items.space} = 'docs' AND ${notArchived}))::int`,
      // review-queue sections of cleanup-and-jobs.md section 6 (conflicts counted below)
      review: sql<number>`(
        count(*) FILTER (WHERE ${items.lifecycle} = 'stale')
        + count(*) FILTER (WHERE ${items.lifecycle} = 'archived' AND ${items.archivedAt} > now() - interval '30 days')
        + count(*) FILTER (WHERE ${items.type} = 'observation' AND ${items.lifecycle} = 'active'
                             AND ${items.expiresAt} < now() + interval '48 hours')
        + count(*) FILTER (WHERE ${items.pushConflictAt} IS NOT NULL))::int`,
    })
    .from(items)
    .where(inArray(items.projectId, ids))
    .groupBy(items.projectId)
  for (const r of rows) {
    out.set(r.projectId, {
      counts: { memories: r.memories, decisions: r.decisions, docs: r.docs },
      review: r.review,
    })
  }
  // open conflicts: both ends not archived and active/accepted. An edge belongs to its source's project, and
  // nothing in `_shared` points out of it (spoor_edge_scope), so `_shared` counts only shared-shared edges.
  const a = alias(items, 'a')
  const b = alias(items, 'b')
  const live = (t: { lifecycle: AnyColumn; status: AnyColumn }) =>
    sql`${t.lifecycle} <> 'archived' AND ${t.status} IN ('active', 'accepted')`
  const conflicts = await db
    .select({ projectId: edges.projectId, n: sql<number>`count(*)::int` })
    .from(edges)
    .innerJoin(a, eq(a.id, edges.srcId))
    .innerJoin(b, eq(b.id, edges.dstId))
    .where(and(eq(edges.kind, 'conflicts_with'), inArray(edges.projectId, ids), live(a), live(b)))
    .groupBy(edges.projectId)
  for (const c of conflicts) {
    const s = out.get(c.projectId)
    if (s) s.review += c.n
  }
  return out
}

/**
 * Create the `_shared` project row if it is missing (startup step 5, deployment.md section 4). Idempotent.
 * Like `ProjectService.create`, the row names the instance's default provider in `settings.embedding.provider`
 * AND stores its tag as the active model: without the setting the project would resolve to the built-in
 * default (`local`) and startup's embedding-target sync would re-embed it away from the default provider.
 */
export async function ensureSharedProject(
  db: DbOrTx,
  provider: Pick<EmbeddingProvider, 'name' | 'tag'>,
): Promise<{ created: boolean }> {
  const rows = await db
    .insert(projects)
    .values({
      kind: 'shared',
      slug: SHARED_PROJECT_SLUG,
      name: 'Shared',
      description: 'Org-wide knowledge, readable from every project.',
      settings: mergeSettings({}, { embedding: { provider: provider.name } }),
      embeddingModel: provider.tag,
    })
    .onConflictDoNothing()
    .returning({ id: projects.id })
  return { created: rows.length > 0 }
}

export class ProjectService {
  constructor(private readonly deps: ServerDeps) {}

  /** The embedding provider named by a setting, or 400 `invalid_input` when this instance has none of that name. */
  #provider(name: string): EmbeddingProvider {
    const p = this.deps.ports.embeddings.byName(name)
    if (!p) {
      throw new ApiError('invalid_input', {
        message: `Embedding provider "${name}" is not enabled on this instance.`,
        details: { issues: [{ path: 'settings.embedding.provider', message: 'provider not enabled' }] },
      })
    }
    return p
  }

  /** Projects the user is a member of (an instance admin: all), without `_shared`. Not paginated. */
  async list(ctx: UserContext): Promise<{ items: ProjectListItem[] }> {
    const { db } = this.deps
    const rows = await db
      .select({ project: projects, membership: memberships.role })
      .from(projects)
      .leftJoin(memberships, and(eq(memberships.projectId, projects.id), eq(memberships.userId, ctx.user.id)))
      .where(
        and(
          eq(projects.kind, 'project'),
          ctx.user.isAdmin ? undefined : sql`${memberships.userId} IS NOT NULL`,
        ),
      )
      .orderBy(asc(projects.slug))
    const stats = await listStats(
      db,
      rows.map((r) => r.project.id),
    )
    return {
      items: rows.map((r) => {
        const s = stats.get(r.project.id)
        return {
          slug: r.project.slug,
          name: r.project.name,
          description: r.project.description,
          role: ctx.user.isAdmin ? 'admin' : (r.membership as ProjectRole),
          counts: s?.counts ?? { memories: 0, decisions: 0, docs: 0 },
          review_total: s?.review ?? 0,
        }
      }),
    }
  }

  /** `GET /projects/:slug`; `remaining` counts items without target-model chunks while a re-embed runs. */
  async get(access: ProjectAccess): Promise<ProjectJson> {
    const p = access.project
    let remaining = 0
    if (p.embeddingTarget !== null) {
      const [row] = await this.deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(items)
        .where(
          and(
            eq(items.projectId, p.id),
            sql`NOT EXISTS (SELECT 1 FROM chunks c WHERE c.item_id = ${items.id}
                  AND c.model = ${p.embeddingTarget} AND c.item_revision = ${items.revision})`,
          ),
        )
      remaining = row?.n ?? 0
    }
    return {
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      kind: p.kind,
      settings: resolveSettings(p.settings),
      role: access.role,
      embedding: { model: p.embeddingModel, target: p.embeddingTarget, remaining },
      created_at: p.createdAt.toISOString(),
    }
  }

  /** Instance admins only. 409 `slug_taken`. Settings default to the instance's default embedding provider. */
  async create(
    ctx: UserContext,
    input: { slug: string; name: string; description: string; settings?: ProjectSettingsPatch },
  ): Promise<ProjectJson> {
    assertCan(webPrincipal(ctx.user, null), 'project.create')
    const patch: ProjectSettingsPatch = { ...(input.settings ?? {}) }
    if (patch.embedding?.provider === undefined) {
      patch.embedding = { ...patch.embedding, provider: this.deps.ports.embeddings.defaultProvider.name }
    }
    const stored = mergeSettings({}, patch)
    const settings = validateSettings(stored)
    const provider = this.#provider(settings.embedding.provider)
    const row = await withTx(this.deps.db, async (tx) => {
      let created: ProjectRow | undefined
      try {
        ;[created] = await tx
          .insert(projects)
          .values({
            kind: 'project',
            slug: input.slug,
            name: input.name,
            description: input.description,
            settings: stored,
            embeddingModel: provider.tag,
            createdBy: ctx.user.id,
          })
          .returning()
      } catch (err) {
        if (isUniqueViolation(err, 'projects_slug_key')) {
          throw new ApiError('slug_taken', {
            message: `The project slug "${input.slug}" is taken.`,
            details: { slug: input.slug },
          })
        }
        throw err
      }
      const p = created as ProjectRow
      await writeAudit(tx, webActor(ctx), {
        action: 'project.create',
        summary: `${ctx.user.email} created project ${p.slug}`,
        data: { project_id: p.id, slug: p.slug, name: p.name },
      })
      return p
    })
    return this.get(accessFor(ctx, row, null))
  }

  /**
   * PA / IA (`_shared`: IA). `settings` is a partial object deep-merged over the stored one and validated.
   * Choosing another embedding provider sets `embedding_target` (the re-embed job takes over); choosing the
   * active one again clears it.
   */
  async update(
    access: ProjectAccess,
    patch: { name?: string; description?: string; settings?: ProjectSettingsPatch },
  ): Promise<ProjectJson> {
    access.assert('settings.manage')
    const { ctx } = access
    let reembed = false
    const row = await withTx(this.deps.db, async (tx) => {
      const [cur] = await tx.select().from(projects).where(eq(projects.id, access.project.id)).for('update')
      if (!cur) throw projectNotFound()
      const set: Partial<typeof projects.$inferInsert> = {}
      const fields: string[] = []
      if (patch.name !== undefined && patch.name !== cur.name) {
        set.name = patch.name
        fields.push('name')
      }
      if (patch.description !== undefined && patch.description !== cur.description) {
        set.description = patch.description
        fields.push('description')
      }
      const paths = patch.settings ? settingsPatchPaths(patch.settings) : []
      if (patch.settings && paths.length > 0) {
        const stored = mergeSettings(cur.settings, patch.settings)
        const next = validateSettings(stored)
        set.settings = stored
        const wanted = patch.settings.embedding?.provider
        if (wanted !== undefined && wanted !== resolveSettings(cur.settings).embedding.provider) {
          const tag = this.#provider(next.embedding.provider).tag
          const target = tag === cur.embeddingModel ? null : tag
          if (target !== cur.embeddingTarget) {
            set.embeddingTarget = target
            reembed = target !== null
          }
        }
      }
      if (Object.keys(set).length === 0) return cur
      const [updated] = await tx.update(projects).set(set).where(eq(projects.id, cur.id)).returning()
      if (fields.length > 0) {
        await writeAudit(tx, webActor(ctx), {
          projectId: cur.id,
          action: 'project.update',
          summary: `${ctx.user.email} changed ${fields.join(', ')} of ${cur.slug}`,
          data: { fields },
        })
      }
      if (set.settings !== undefined) {
        await writeAudit(tx, webActor(ctx), {
          projectId: cur.id,
          action: 'project.settings',
          summary: `${ctx.user.email} changed settings of ${cur.slug}: ${paths.join(', ')}`,
          data: {
            changed: paths,
            settings: patch.settings ?? {},
            ...(set.embeddingTarget !== undefined ? { embedding_target: set.embeddingTarget } : {}),
          },
        })
      }
      return updated as ProjectRow
    })
    if (reembed) this.deps.ports.jobs.enqueue('reembed', { projectId: row.id })
    return this.get(accessFor(ctx, row, access.membership))
  }

  /**
   * Instance admins only; `confirm` must equal the slug. `_shared` cannot be deleted (403 `forbidden`).
   * Purge transaction: items, revisions, chunks, edges, memberships, tokens and device codes cascade, and the
   * project's audit rows go with it (data-model.md section 4). One instance-level `project.delete` row stays.
   */
  async delete(ctx: UserContext, slug: string, confirm: string | undefined): Promise<void> {
    assertCan(webPrincipal(ctx.user, null), 'project.delete')
    const [row] = await this.deps.db.select().from(projects).where(eq(projects.slug, slug)).limit(1)
    if (!row) throw projectNotFound()
    if (row.kind === 'shared') {
      throw new ApiError('forbidden', { message: 'The shared space cannot be deleted.' })
    }
    if (confirm !== row.slug) {
      throw new ApiError('invalid_input', {
        message: 'confirm must equal the project slug.',
        details: { issues: [{ path: 'confirm', message: 'must equal the slug' }] },
      })
    }
    await withTx(this.deps.db, async (tx) => {
      await allowPurge(tx)
      const [gone] = await tx
        .delete(projects)
        .where(and(eq(projects.id, row.id), ne(projects.kind, 'shared')))
        .returning({ id: projects.id })
      if (!gone) throw projectNotFound()
      await tx.delete(auditLog).where(eq(auditLog.projectId, row.id))
      await writeAudit(tx, webActor(ctx), {
        action: 'project.delete',
        summary: `${ctx.user.email} deleted project ${row.slug}`,
        data: { project_id: row.id, slug: row.slug, name: row.name },
      })
    })
  }
}
