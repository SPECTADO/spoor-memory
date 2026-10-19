/**
 * Accounts and sessions (auth-and-security.md sections 2, 3, 7; api.md sections 1 and 2.2).
 * No Hono here: routes.ts parses requests and calls these with the caller's AuthContext.
 */
import type { MeResponse, ProjectRole, UserJson } from '@spoor/shared'
import { and, asc, eq, gt, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { memberships, projects, sessions, tokens, users } from '../../db/schema.js'
import { webActor, writeAudit } from '../../lib/audit.js'
import type { AuthUser } from '../../lib/auth-context.js'
import { type DbOrTx, escapeLike, type Tx, withTx } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError } from '../../lib/errors.js'
import { decodeTypedCursor, page } from '../../lib/pagination.js'
import { revokeUnbackedInvites } from './invites.js'
import type { UserContext } from './middleware.js'
import { needsRehash, type PasswordHasher } from './passwords.js'
import { createSession, deleteSession, deleteUserSessions } from './sessions.js'

type UserRow = typeof users.$inferSelect

export function userJson(u: Pick<UserRow, 'id' | 'email' | 'name' | 'isAdmin' | 'sharedEditor'>): UserJson {
  return { id: u.id, email: u.email, name: u.name, is_admin: u.isAdmin, shared_editor: u.sharedEditor }
}

export function authUser(u: UserRow): AuthUser {
  return { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, sharedEditor: u.sharedEditor }
}

const invalidCredentials = () => new ApiError('invalid_credentials', { message: 'Wrong email or password.' })

/** Memberships of regular projects (the shared project never has any). */
export async function membershipsOf(db: DbOrTx, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, MeResponse['memberships']>()
  const rows = await db
    .select({
      userId: memberships.userId,
      role: memberships.role,
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
    })
    .from(memberships)
    .innerJoin(projects, eq(projects.id, memberships.projectId))
    .where(inArray(memberships.userId, userIds))
    .orderBy(asc(projects.slug))
  const out = new Map<string, MeResponse['memberships']>()
  for (const r of rows) {
    const list = out.get(r.userId) ?? []
    list.push({ project: { id: r.id, slug: r.slug, name: r.name }, role: r.role as ProjectRole })
    out.set(r.userId, list)
  }
  return out
}

/**
 * Serialises every change that could remove the last enabled instance admin, so two concurrent
 * demotions cannot both pass the check.
 */
async function lockAdminSet(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('spoor-instance-admins'))`)
}

async function otherEnabledAdmins(tx: Tx, exceptUserId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.isAdmin, true), isNull(users.disabledAt), ne(users.id, exceptUserId)))
  return row?.n ?? 0
}

const lastAdmin = () =>
  new ApiError('last_admin', {
    message: 'This would remove the last instance admin.',
    hint: 'Make another user an instance admin first.',
  })

export class AuthService {
  constructor(
    private readonly deps: ServerDeps,
    private readonly hasher: PasswordHasher,
  ) {}

  /** Unknown email, wrong password and disabled user look the same (and cost the same). */
  async login(email: string, password: string, userAgent: string | undefined, oldSession?: Buffer) {
    const { db } = this.deps
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1)
    if (!user || user.disabledAt !== null) {
      await this.hasher.dummyVerify(password)
      throw invalidCredentials()
    }
    if (!(await this.hasher.verify(password, user.passwordHash))) throw invalidCredentials()
    if (needsRehash(user.passwordHash)) {
      const fresh = await this.hasher.hash(password)
      await db.update(users).set({ passwordHash: fresh }).where(eq(users.id, user.id))
    }
    if (oldSession) await deleteSession(db, oldSession)
    const sid = await createSession(db, user.id, userAgent)
    return { user: userJson(user), sid }
  }

  async logout(idHash: Buffer | undefined): Promise<void> {
    if (idHash) await deleteSession(this.deps.db, idHash)
  }

  async me(user: AuthUser): Promise<MeResponse> {
    const [row] = await this.deps.db.select().from(users).where(eq(users.id, user.id)).limit(1)
    if (!row) throw new ApiError('unauthenticated')
    const ms = await membershipsOf(this.deps.db, [user.id])
    return { user: userJson(row), memberships: ms.get(user.id) ?? [] }
  }

  async updateMe(ctx: UserContext, name: string): Promise<UserJson> {
    return withTx(this.deps.db, async (tx) => {
      const [row] = await tx.update(users).set({ name }).where(eq(users.id, ctx.user.id)).returning()
      if (!row) throw new ApiError('unauthenticated')
      await writeAudit(tx, webActor(ctx), {
        action: 'user.update',
        summary: `${row.email} changed their name`,
        data: { user_id: row.id, fields: ['name'] },
      })
      return userJson(row)
    })
  }

  /** Every other session of the user is deleted; the current one stays. */
  async changePassword(ctx: UserContext, current: string, next: string, keepSession: Buffer | undefined) {
    const { db } = this.deps
    const [row] = await db.select().from(users).where(eq(users.id, ctx.user.id)).limit(1)
    if (!row) throw new ApiError('unauthenticated')
    if (!(await this.hasher.verify(current, row.passwordHash))) throw invalidCredentials()
    const hash = await this.hasher.hash(next)
    await withTx(db, async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash: hash, passwordChangedAt: sql`now()` })
        .where(eq(users.id, row.id))
      await deleteUserSessions(tx, row.id, keepSession)
      await writeAudit(tx, webActor(ctx), {
        action: 'user.password_change',
        summary: `${row.email} changed their password`,
        data: { user_id: row.id },
      })
    })
  }
}

export interface AdminUserJson extends UserJson {
  disabled_at: string | null
  created_at: string
  memberships: MeResponse['memberships']
}

/** Instance-admin user management (api.md section 2.2). Users are created only through invites. */
export class UserService {
  constructor(private readonly deps: ServerDeps) {}

  async #withMemberships(rows: UserRow[]): Promise<AdminUserJson[]> {
    const ms = await membershipsOf(
      this.deps.db,
      rows.map((r) => r.id),
    )
    return rows.map((r) => ({
      ...userJson(r),
      disabled_at: r.disabledAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
      memberships: ms.get(r.id) ?? [],
    }))
  }

  async list(q: string | undefined, cursor: string | undefined, limit: number) {
    const conds = []
    if (q) {
      const pat = `${escapeLike(q.trim().toLowerCase())}%`
      conds.push(or(ilike(users.email, pat), ilike(users.name, pat)))
    }
    if (cursor) {
      const [email, id] = decodeTypedCursor(cursor, ['string', 'uuid'] as const)
      conds.push(or(gt(users.email, email), and(eq(users.email, email), gt(users.id, id))))
    }
    const rows = await this.deps.db
      .select()
      .from(users)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(users.email), asc(users.id))
      .limit(limit + 1)
    const json = await this.#withMemberships(rows)
    const byId = new Map(json.map((j) => [j.id, j]))
    return page(
      rows,
      limit,
      (r) => [r.email, r.id],
      (r) => byId.get(r.id) as AdminUserJson,
    )
  }

  async get(id: string): Promise<AdminUserJson> {
    const [row] = await this.deps.db.select().from(users).where(eq(users.id, id)).limit(1)
    if (!row) throw new ApiError('not_found')
    const [json] = await this.#withMemberships([row])
    return json as AdminUserJson
  }

  /**
   * Disabling deletes the user's sessions; disabling or demoting revokes the open invites the user no
   * longer backs. Removing the last enabled instance admin is 409 `last_admin`.
   */
  async update(
    ctx: UserContext,
    id: string,
    patch: { name?: string; is_admin?: boolean; shared_editor?: boolean; disabled?: boolean },
  ): Promise<AdminUserJson> {
    await withTx(this.deps.db, async (tx) => {
      await lockAdminSet(tx)
      const [row] = await tx.select().from(users).where(eq(users.id, id)).for('update')
      if (!row) throw new ApiError('not_found')
      const wasActiveAdmin = row.isAdmin && row.disabledAt === null
      const willBeActiveAdmin =
        (patch.is_admin ?? row.isAdmin) &&
        (patch.disabled === undefined ? row.disabledAt === null : !patch.disabled)
      if (wasActiveAdmin && !willBeActiveAdmin && (await otherEnabledAdmins(tx, id)) === 0) throw lastAdmin()

      const set: PgUpdateSetSource<typeof users> = {}
      const fields: string[] = []
      if (patch.name !== undefined && patch.name !== row.name) {
        set.name = patch.name
        fields.push('name')
      }
      if (patch.is_admin !== undefined && patch.is_admin !== row.isAdmin) {
        set.isAdmin = patch.is_admin
        fields.push('is_admin')
      }
      if (patch.shared_editor !== undefined && patch.shared_editor !== row.sharedEditor) {
        set.sharedEditor = patch.shared_editor
        fields.push('shared_editor')
      }
      const disabling = patch.disabled === true && row.disabledAt === null
      if (disabling) {
        set.disabledAt = sql`now()`
        fields.push('disabled')
      }
      if (patch.disabled === false && row.disabledAt !== null) {
        set.disabledAt = null
        fields.push('enabled')
      }
      if (fields.length === 0) return
      await tx.update(users).set(set).where(eq(users.id, id))
      if (disabling) await deleteUserSessions(tx, id)
      // a disabled or demoted creator no longer backs their open invites (accept re-checks it as well)
      const invitesRevoked = disabling || set.isAdmin === false ? await revokeUnbackedInvites(tx, id) : 0
      await writeAudit(tx, webActor(ctx), {
        action: 'user.update',
        summary: `${ctx.user.email} updated ${row.email}: ${fields.join(', ')}`,
        data: {
          user_id: id,
          fields,
          ...(fields.includes('is_admin') ? { is_admin: patch.is_admin } : {}),
          ...(fields.includes('shared_editor') ? { shared_editor: patch.shared_editor } : {}),
          ...(invitesRevoked ? { invites_revoked: invitesRevoked } : {}),
        },
      })
    })
    return this.get(id)
  }

  /**
   * `confirm` must equal the user's email. Tokens, sessions and memberships cascade; the user's open
   * invites are revoked first.
   */
  async delete(ctx: UserContext, id: string, confirm: string | undefined): Promise<void> {
    await withTx(this.deps.db, async (tx) => {
      await lockAdminSet(tx)
      const [row] = await tx.select().from(users).where(eq(users.id, id)).for('update')
      if (!row) throw new ApiError('not_found')
      if ((confirm ?? '').trim().toLowerCase() !== row.email) {
        throw new ApiError('invalid_input', {
          message: 'confirm must equal the user’s email.',
          details: { issues: [{ path: 'confirm', message: 'must equal the email' }] },
        })
      }
      if (row.isAdmin && row.disabledAt === null && (await otherEnabledAdmins(tx, id)) === 0)
        throw lastAdmin()
      const invitesRevoked = await revokeUnbackedInvites(tx, id, true)
      await tx.delete(users).where(eq(users.id, id))
      await writeAudit(tx, webActor(ctx), {
        action: 'user.delete',
        summary: `${ctx.user.email} deleted ${row.email}`,
        data: {
          user_id: id,
          email: row.email,
          ...(invitesRevoked ? { invites_revoked: invitesRevoked } : {}),
        },
      })
    })
  }
}

/** Used by the reset-invite path: revoke every live API token of a user. */
export async function revokeUserTokens(db: DbOrTx, userId: string): Promise<number> {
  const rows = await db
    .update(tokens)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(tokens.userId, userId), isNull(tokens.revokedAt)))
    .returning({ id: tokens.id })
  return rows.length
}

/** Live sessions of a user (tests and the admin UI). */
export async function countSessions(db: DbOrTx, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sessions)
    .where(eq(sessions.userId, userId))
  return row?.n ?? 0
}
