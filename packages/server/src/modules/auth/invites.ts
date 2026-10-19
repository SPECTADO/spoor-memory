/**
 * Invite links, including the password-reset invite (auth-and-security.md sections 2 and 5; api.md 2.1).
 *
 * The takeover rule: only an invite with `reset_user_id` (created by an instance admin) can touch an
 * existing account, and it is matched by user id, never by email. Any other invite whose email belongs to
 * an existing user is 409 `already_exists`, the transaction rolls back and the invite stays unused.
 */
import { cleanLine, type ProjectRole } from '@spoor/shared'
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, type SQL, sql } from 'drizzle-orm'
import { type InviteGrant, invites, memberships, projects, users } from '../../db/schema.js'
import { webActor, writeAudit } from '../../lib/audit.js'
import type { AuthContext, AuthUser } from '../../lib/auth-context.js'
import { randomSecret, sha256 } from '../../lib/crypto.js'
import { isUniqueViolation, type Tx, withTx } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError } from '../../lib/errors.js'
import { cursorTimestamp, decodeTypedCursor, page } from '../../lib/pagination.js'
import type { UserContext } from './middleware.js'
import type { PasswordHasher } from './passwords.js'
import { authUser, revokeUserTokens, userJson } from './service.js'
import { createSession, deleteUserSessions } from './sessions.js'

type InviteRow = typeof invites.$inferSelect
export type InviteStatus = 'open' | 'used' | 'expired' | 'revoked'

export interface InviteJson {
  id: string
  email: string | null
  is_admin: boolean
  shared_editor: boolean
  reset: boolean
  reset_user_id: string | null
  grants: { project: { slug: string; name: string }; role: ProjectRole }[]
  status: InviteStatus
  created_by: string | null
  created_at: string
  expires_at: string
  used_at: string | null
  used_by: string | null
  revoked_at: string | null
}

export interface InviteCreateInput {
  email?: string
  grants: { project: string; role: ProjectRole }[]
  is_admin: boolean
  shared_editor: boolean
  reset_user_id?: string
  reset_revoke_tokens: boolean
  expires_in_hours: number
}

export interface InviteAcceptInput {
  token: string
  name?: string
  email?: string
  password: string
}

const INVITE_PREFIX = 'spi_'

function statusOf(r: InviteRow, now = new Date()): InviteStatus {
  if (r.usedAt) return 'used'
  if (r.revokedAt) return 'revoked'
  if (r.expiresAt <= now) return 'expired'
  return 'open'
}

/** The single-use gate's predicate: unused, not revoked, not expired. */
const openPredicate = (tokenHash: Buffer) =>
  and(
    eq(invites.tokenHash, tokenHash),
    isNull(invites.usedAt),
    isNull(invites.revokedAt),
    gt(invites.expiresAt, sql`now()`),
  )

/**
 * The creator still backs the invite (finding S1 of the phase-2 review): the creator exists and is enabled,
 * and is an instance admin, or the invite carries no instance flag and is no reset invite and the creator
 * still administers every project of its grants (grants on deleted projects are skipped, as at accept).
 * An invite created by someone who has since been demoted, disabled, removed or deleted grants nothing.
 */
const creatorBacks: SQL = sql`EXISTS (
  SELECT 1 FROM ${users} AS c
  WHERE c.id = ${invites.createdBy} AND c.disabled_at IS NULL AND (
    c.is_admin OR (
      NOT ${invites.isAdmin} AND NOT ${invites.sharedEditor} AND ${invites.resetUserId} IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(${invites.grants}) AS g
        JOIN ${projects} AS p ON p.id = (g->>'project_id')::uuid
        WHERE NOT EXISTS (
          SELECT 1 FROM ${memberships} AS m
          WHERE m.user_id = c.id AND m.project_id = p.id AND m.role = 'admin')))))`

/** Open and still backed by its creator: what preview and accept require. */
const acceptablePredicate = (tokenHash: Buffer) => and(openPredicate(tokenHash), creatorBacks)

/**
 * Revokes the open invites created by `userId` that the user no longer backs (after a demotion, a disable,
 * a project-admin role loss) or all of them (`all`, before the account is deleted). Called inside the
 * transaction of that change; returns how many were revoked.
 */
export async function revokeUnbackedInvites(tx: Tx, userId: string, all = false): Promise<number> {
  const rows = await tx
    .update(invites)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(invites.createdBy, userId),
        isNull(invites.usedAt),
        isNull(invites.revokedAt),
        gt(invites.expiresAt, sql`now()`),
        all ? undefined : sql`NOT ${creatorBacks}`,
      ),
    )
    .returning({ id: invites.id })
  return rows.length
}

const statusPredicate: Record<InviteStatus, SQL | undefined> = {
  open: and(isNull(invites.usedAt), isNull(invites.revokedAt), gt(invites.expiresAt, sql`now()`)),
  used: isNotNull(invites.usedAt),
  revoked: and(isNull(invites.usedAt), isNotNull(invites.revokedAt)),
  expired: and(isNull(invites.usedAt), isNull(invites.revokedAt), lte(invites.expiresAt, sql`now()`)),
}

/**
 * Who may list or revoke an invite: an instance admin; its creator; a project admin when the invite has
 * non-empty grants, every grant is on a project they administer, and it carries no instance flag and is
 * not a reset invite.
 */
function visibleTo(user: AuthUser): SQL | undefined {
  if (user.isAdmin) return undefined
  return sql`(${invites.createdBy} = ${user.id} OR (
    jsonb_array_length(${invites.grants}) > 0
    AND NOT ${invites.isAdmin} AND NOT ${invites.sharedEditor} AND ${invites.resetUserId} IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(${invites.grants}) AS g
      WHERE NOT EXISTS (
        SELECT 1 FROM ${memberships} AS m
        WHERE m.user_id = ${user.id} AND m.role = 'admin' AND m.project_id = (g->>'project_id')::uuid))))`
}

export class InviteService {
  constructor(
    private readonly deps: ServerDeps,
    private readonly hasher: PasswordHasher,
  ) {}

  async #toJson(rows: InviteRow[]): Promise<InviteJson[]> {
    const ids = [...new Set(rows.flatMap((r) => r.grants.map((g) => g.project_id)))]
    const ps = ids.length
      ? await this.deps.db
          .select({ id: projects.id, slug: projects.slug, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, ids))
      : []
    const byId = new Map(ps.map((p) => [p.id, p]))
    const now = new Date()
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      is_admin: r.isAdmin,
      shared_editor: r.sharedEditor,
      reset: r.resetUserId !== null,
      reset_user_id: r.resetUserId,
      grants: r.grants.flatMap((g) => {
        const p = byId.get(g.project_id)
        return p ? [{ project: { slug: p.slug, name: p.name }, role: g.role }] : [] // deleted projects drop out
      }),
      status: statusOf(r, now),
      created_by: r.createdBy,
      created_at: r.createdAt.toISOString(),
      expires_at: r.expiresAt.toISOString(),
      used_at: r.usedAt?.toISOString() ?? null,
      used_by: r.usedBy,
      revoked_at: r.revokedAt?.toISOString() ?? null,
    }))
  }

  async create(ctx: UserContext, input: InviteCreateInput) {
    const { db, config } = this.deps
    const isIA = ctx.user.isAdmin
    if (!isIA && (input.is_admin || input.shared_editor || input.reset_user_id !== undefined)) {
      throw new ApiError('forbidden', {
        message: 'Only an instance admin can create admin, shared-editor or reset invites.',
      })
    }
    if (!isIA && input.grants.length === 0) {
      throw new ApiError('invalid_input', {
        message: 'A project admin’s invite needs at least one project grant.',
        details: { issues: [{ path: 'grants', message: 'must not be empty' }] },
      })
    }
    const slugs = input.grants.map((g) => g.project)
    if (new Set(slugs).size !== slugs.length) {
      throw new ApiError('invalid_input', {
        message: 'Each project may appear only once in grants.',
        details: { issues: [{ path: 'grants', message: 'duplicate project' }] },
      })
    }

    let email = input.email ?? null
    let resetTarget: { id: string; email: string } | null = null
    if (input.reset_user_id !== undefined) {
      if (input.grants.length > 0 || input.is_admin || input.shared_editor) {
        throw new ApiError('invalid_input', {
          message: 'A reset invite carries no grants and no instance flags.',
          details: { issues: [{ path: 'reset_user_id', message: 'requires grants:[] and no flags' }] },
        })
      }
      const [u] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.id, input.reset_user_id))
      if (!u) throw new ApiError('user_not_found', { message: 'No such user.' })
      if (email !== null && email !== u.email) {
        throw new ApiError('invalid_input', {
          message: 'A reset invite is locked to that user’s email.',
          details: { issues: [{ path: 'email', message: 'must be omitted or equal the user’s email' }] },
        })
      }
      resetTarget = u
      email = u.email
    }

    return withTx(db, async (tx) => {
      const found = slugs.length
        ? await tx
            .select({ id: projects.id, slug: projects.slug, name: projects.name, kind: projects.kind })
            .from(projects)
            .where(inArray(projects.slug, slugs))
        : []
      const bySlug = new Map(found.map((p) => [p.slug, p]))
      const issues = input.grants.flatMap((g, i) => {
        const p = bySlug.get(g.project)
        return p?.kind !== 'project' ? [{ path: `grants.${i}.project`, message: 'unknown project' }] : []
      })
      if (issues.length)
        throw new ApiError('invalid_input', { message: 'Unknown project in grants.', details: { issues } })
      if (!isIA) {
        const ids = found.map((p) => p.id)
        const adminOf = await tx
          .select({ projectId: memberships.projectId })
          .from(memberships)
          .where(
            and(
              eq(memberships.userId, ctx.user.id),
              eq(memberships.role, 'admin'),
              inArray(memberships.projectId, ids),
            ),
          )
        if (adminOf.length !== ids.length) {
          throw new ApiError('forbidden', { message: 'You can invite only into projects you administer.' })
        }
      }
      const grants: InviteGrant[] = input.grants.map((g) => ({
        project_id: (bySlug.get(g.project) as { id: string }).id,
        role: g.role,
      }))
      const token = randomSecret(INVITE_PREFIX)
      const [row] = await tx
        .insert(invites)
        .values({
          tokenHash: sha256(token),
          email,
          isAdmin: input.is_admin,
          sharedEditor: input.shared_editor,
          grants,
          createdBy: ctx.user.id,
          expiresAt: sql`now() + make_interval(hours => ${input.expires_in_hours})`,
          resetUserId: resetTarget?.id ?? null,
          resetRevokeTokens: input.reset_revoke_tokens,
        })
        .returning()
      const invite = row as InviteRow
      await writeAudit(tx, webActor(ctx), {
        action: 'invite.create',
        summary: resetTarget
          ? `${ctx.user.email} created a password-reset invite for ${resetTarget.email}`
          : `${ctx.user.email} created an invite${email ? ` for ${email}` : ''}`,
        data: {
          invite_id: invite.id,
          email,
          reset: resetTarget !== null,
          is_admin: input.is_admin,
          shared_editor: input.shared_editor,
          grants: input.grants,
        },
      })
      const [json] = await this.#toJson([invite])
      return { invite: json as InviteJson, token, link: `${config.publicOrigin}/invite#${token}` }
    })
  }

  /**
   * What the accept page shows; 404 for unknown, used, revoked or expired, and for an invite its creator
   * no longer backs (demoted, disabled, deleted, or no longer admin of a granted project).
   */
  async preview(token: string) {
    const [row] = await this.deps.db
      .select()
      .from(invites)
      .where(acceptablePredicate(sha256(token)))
      .limit(1)
    if (!row)
      throw new ApiError('not_found', { message: 'This invite is invalid, used, revoked or expired.' })
    const [json] = await this.#toJson([row])
    const j = json as InviteJson
    return {
      email: j.email,
      is_admin: j.is_admin,
      shared_editor: j.shared_editor,
      reset: j.reset,
      grants: j.grants,
      expires_at: j.expires_at,
    }
  }

  /**
   * One transaction. The `UPDATE … SET used_at = now() … RETURNING` is the single-use gate (it also
   * re-checks that the creator still backs the invite, `creatorBacks`); a later
   * error (`already_exists`, `invalid_input`) rolls it back, so the invite stays unused.
   * Returns the session cookie value, or null when the account is disabled (reset only).
   */
  async accept(input: InviteAcceptInput, userAgent: string | undefined) {
    const { db } = this.deps
    const tokenHash = sha256(input.token)
    // cheap pre-check, so a wrong token costs no password hash; the real gate is in the transaction
    const [open] = await db
      .select({ id: invites.id })
      .from(invites)
      .where(acceptablePredicate(tokenHash))
      .limit(1)
    if (!open)
      throw new ApiError('not_found', { message: 'This invite is invalid, used, revoked or expired.' })
    const passwordHash = await this.hasher.hash(input.password)

    return withTx(db, async (tx) => {
      const [inv] = await tx
        .update(invites)
        .set({ usedAt: sql`now()` })
        .where(acceptablePredicate(tokenHash))
        .returning()
      if (!inv)
        throw new ApiError('not_found', { message: 'This invite is invalid, used, revoked or expired.' })

      if (inv.resetUserId !== null) {
        // reset: exactly this user, by id; name and email are ignored
        const [u] = await tx
          .update(users)
          .set({ passwordHash, passwordChangedAt: sql`now()` })
          .where(eq(users.id, inv.resetUserId))
          .returning()
        if (!u) throw new ApiError('not_found')
        await deleteUserSessions(tx, u.id)
        const revoked = inv.resetRevokeTokens ? await revokeUserTokens(tx, u.id) : 0
        await tx.update(invites).set({ usedBy: u.id }).where(eq(invites.id, inv.id))
        const ctx: AuthContext = {
          user: authUser(u),
          project: null,
          role: null,
          via: 'cookie',
          clientName: 'web',
        }
        await writeAudit(tx, webActor(ctx), {
          action: 'user.password_reset',
          summary: `${u.email} reset their password with an invite`,
          data: { user_id: u.id, invite_id: inv.id, tokens_revoked: revoked },
        })
        const sid = u.disabledAt === null ? await createSession(tx, u.id, userAgent) : null
        return { user: userJson(u), sid, reset: true }
      }

      if (!input.name) {
        throw new ApiError('invalid_input', {
          message: 'name is required.',
          details: { issues: [{ path: 'name', message: 'required' }] },
        })
      }
      if (inv.email !== null && input.email !== undefined && input.email !== inv.email) {
        throw new ApiError('invalid_input', {
          message: 'This invite is for a different email address.',
          details: { issues: [{ path: 'email', message: 'does not match the invite' }] },
        })
      }
      const email = inv.email ?? input.email
      if (!email) {
        throw new ApiError('invalid_input', {
          message: 'email is required.',
          details: { issues: [{ path: 'email', message: 'required' }] },
        })
      }
      const alreadyExists = () =>
        new ApiError('already_exists', {
          message: 'An account with this email already exists.',
          hint: 'Log in instead, or ask an instance admin for a password-reset invite.',
        })
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
      if (existing) throw alreadyExists()
      let created: typeof users.$inferSelect
      try {
        const [u] = await tx
          .insert(users)
          .values({
            email,
            name: cleanLine(input.name),
            passwordHash,
            isAdmin: inv.isAdmin,
            sharedEditor: inv.sharedEditor,
          })
          .returning()
        created = u as typeof users.$inferSelect
      } catch (err) {
        if (isUniqueViolation(err, 'users_email_uq')) throw alreadyExists()
        throw err
      }
      // grants on projects that no longer exist are skipped
      const projectIds = inv.grants.map((g) => g.project_id)
      const live = projectIds.length
        ? await tx
            .select({ id: projects.id })
            .from(projects)
            .where(and(inArray(projects.id, projectIds), eq(projects.kind, 'project')))
        : []
      const liveIds = new Set(live.map((p) => p.id))
      const rows = inv.grants
        .filter((g) => liveIds.has(g.project_id))
        .map((g) => ({ projectId: g.project_id, userId: created.id, role: g.role }))
      if (rows.length) await tx.insert(memberships).values(rows).onConflictDoNothing()
      await tx.update(invites).set({ usedBy: created.id }).where(eq(invites.id, inv.id))
      const ctx: AuthContext = {
        user: authUser(created),
        project: null,
        role: null,
        via: 'cookie',
        clientName: 'web',
      }
      await writeAudit(tx, webActor(ctx), {
        action: 'user.create',
        summary: `${created.email} joined through an invite`,
        data: {
          user_id: created.id,
          invite_id: inv.id,
          is_admin: created.isAdmin,
          shared_editor: created.sharedEditor,
          memberships: rows.length,
        },
      })
      const sid = await createSession(tx, created.id, userAgent)
      return { user: userJson(created), sid, reset: false }
    })
  }

  async list(ctx: UserContext, q: { status?: InviteStatus; cursor?: string; limit: number }) {
    const conds: (SQL | undefined)[] = [visibleTo(ctx.user)]
    if (q.status) conds.push(statusPredicate[q.status])
    if (q.cursor) {
      const [at, id] = decodeTypedCursor(q.cursor, ['timestamp', 'uuid'] as const)
      conds.push(sql`(${invites.createdAt}, ${invites.id}) < (${at}::timestamptz, ${id}::uuid)`)
    }
    const found = await this.deps.db
      .select({ row: invites, at: cursorTimestamp(invites.createdAt) })
      .from(invites)
      .where(and(...conds))
      .orderBy(desc(invites.createdAt), desc(invites.id))
      .limit(q.limit + 1)
    const rows = found.map((f) => f.row)
    const atById = new Map(found.map((f) => [f.row.id, f.at]))
    const json = await this.#toJson(rows.slice(0, q.limit))
    const byId = new Map(json.map((j) => [j.id, j]))
    return page(
      rows,
      q.limit,
      (r) => [atById.get(r.id) as string, r.id],
      (r) => byId.get(r.id) as InviteJson,
    )
  }

  /** Sets `revoked_at`; a second revoke is a no-op. Invisible invites are 404. */
  async revoke(ctx: UserContext, id: string): Promise<void> {
    await withTx(this.deps.db, async (tx) => {
      const [row] = await tx
        .select()
        .from(invites)
        .where(and(eq(invites.id, id), visibleTo(ctx.user)))
        .for('update')
      if (!row) throw new ApiError('not_found')
      if (row.revokedAt !== null) return
      await tx.update(invites).set({ revokedAt: sql`now()` }).where(eq(invites.id, id))
      await writeAudit(tx, webActor(ctx), {
        action: 'invite.revoke',
        summary: `${ctx.user.email} revoked an invite${row.email ? ` for ${row.email}` : ''}`,
        data: { invite_id: id },
      })
    })
  }
}
