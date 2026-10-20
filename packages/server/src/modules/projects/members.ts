/**
 * Memberships (api.md section 4.2; auth-and-security.md section 7). Project admins and instance admins
 * manage them; a member may remove themselves. The last project admin can be neither demoted nor removed
 * (409 `last_admin`). `_shared` has no members (404). Removing a membership revokes that user's tokens for
 * the project (a later re-add must not revive them); losing the admin role (removal or demotion) revokes the
 * user's open invites into the project that they no longer back.
 */
import type { MemberJson, ProjectRole } from '@spoor/shared'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { memberships, projects, tokens, users } from '../../db/schema.js'
import { webActor, writeAudit } from '../../lib/audit.js'
import { type DbOrTx, isUniqueViolation, type Tx, withTx } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError } from '../../lib/errors.js'
import { revokeUnbackedInvites } from '../auth/index.js'
import { type ProjectAccess, requireRegularProject } from './access.js'

const memberNotFound = () => new ApiError('not_found', { message: 'No such member in this project.' })

const lastAdmin = () =>
  new ApiError('last_admin', {
    message: 'This would leave the project without a project admin.',
    hint: 'Make another member a project admin first.',
  })

async function memberJson(db: DbOrTx, projectId: string, userId: string): Promise<MemberJson | undefined> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: memberships.role,
      libraryEditor: memberships.libraryEditor,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.projectId, projectId), eq(memberships.userId, userId)))
    .limit(1)
  if (!row) return undefined
  return {
    user: { id: row.id, email: row.email, name: row.name },
    role: row.role as ProjectRole,
    library_editor: row.libraryEditor,
    created_at: row.createdAt.toISOString(),
  }
}

/** Serialises membership changes of one project, so two demotions cannot both pass the last-admin check. */
async function lockProject(tx: Tx, projectId: string): Promise<void> {
  await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update')
}

async function adminCount(tx: Tx, projectId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.projectId, projectId), eq(memberships.role, 'admin')))
  return row?.n ?? 0
}

export class MemberService {
  constructor(private readonly deps: ServerDeps) {}

  async list(access: ProjectAccess): Promise<{ items: MemberJson[] }> {
    requireRegularProject(access)
    access.assert('members.manage')
    const rows = await this.deps.db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: memberships.role,
        libraryEditor: memberships.libraryEditor,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.projectId, access.project.id))
      .orderBy(asc(users.email))
    return {
      items: rows.map((r) => ({
        user: { id: r.id, email: r.email, name: r.name },
        role: r.role as ProjectRole,
        library_editor: r.libraryEditor,
        created_at: r.createdAt.toISOString(),
      })),
    }
  }

  /** Add an existing user by email: 404 `user_not_found` (create an invite instead), 409 `already_exists`. */
  async add(
    access: ProjectAccess,
    email: string,
    role: ProjectRole,
    libraryEditor = false,
  ): Promise<MemberJson> {
    requireRegularProject(access)
    access.assert('members.manage')
    const { ctx, project } = access
    // the stored flag is false whenever role = admin (admin implies the right)
    const flag = role === 'admin' ? false : libraryEditor
    return withTx(this.deps.db, async (tx) => {
      const [user] = await tx
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
      if (!user) {
        throw new ApiError('user_not_found', {
          message: 'No account has this email.',
          hint: 'create an invite instead',
        })
      }
      try {
        await tx
          .insert(memberships)
          .values({ projectId: project.id, userId: user.id, role, libraryEditor: flag })
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ApiError('already_exists', { message: `${user.email} is already a member.` })
        }
        throw err
      }
      await writeAudit(tx, webActor(ctx), {
        projectId: project.id,
        action: 'member.set',
        summary: `${ctx.user.email} added ${user.email} as ${role}${flag ? ' with library editing' : ''}`,
        data: { user_id: user.id, role, library_editor: flag, previous: null, previous_library_editor: null },
      })
      return (await memberJson(tx, project.id, user.id)) as MemberJson
    })
  }

  /** Change the role, the library-editor flag, or both; the flag is false whenever the role is admin. */
  async update(
    access: ProjectAccess,
    userId: string,
    patch: { role?: ProjectRole; library_editor?: boolean },
  ): Promise<MemberJson> {
    requireRegularProject(access)
    access.assert('members.manage')
    const { ctx, project } = access
    return withTx(this.deps.db, async (tx) => {
      await lockProject(tx, project.id)
      const cur = await memberJson(tx, project.id, userId)
      if (!cur) throw memberNotFound()
      const role = patch.role ?? cur.role
      let flag: boolean
      if (role === 'admin') flag = false
      else if (cur.role === 'admin') flag = patch.library_editor ?? false
      else flag = patch.library_editor ?? cur.library_editor
      if (cur.role === role && cur.library_editor === flag) return cur
      if (cur.role === 'admin' && role !== 'admin' && (await adminCount(tx, project.id)) <= 1) {
        throw lastAdmin()
      }
      await tx
        .update(memberships)
        .set({ role, libraryEditor: flag })
        .where(and(eq(memberships.projectId, project.id), eq(memberships.userId, userId)))
      const invitesRevoked =
        cur.role === 'admin' && role !== 'admin' ? await revokeUnbackedInvites(tx, userId) : 0
      const parts: string[] = []
      if (cur.role !== role) parts.push(`changed ${cur.user.email} from ${cur.role} to ${role}`)
      if (cur.library_editor !== flag) {
        const implied = patch.library_editor === undefined || role === 'admin'
        parts.push(
          `${flag ? 'granted' : 'revoked'} library editing for ${cur.user.email}${implied ? ' (implied by role change)' : ''}`,
        )
      }
      await writeAudit(tx, webActor(ctx), {
        projectId: project.id,
        action: 'member.set',
        summary: `${ctx.user.email} ${parts.join(' and ')}`,
        data: {
          user_id: userId,
          role,
          previous: cur.role,
          library_editor: flag,
          previous_library_editor: cur.library_editor,
          ...(invitesRevoked ? { invites_revoked: invitesRevoked } : {}),
        },
      })
      return { ...cur, role, library_editor: flag }
    })
  }

  /** PA / IA, or the member themselves. */
  async remove(access: ProjectAccess, userId: string): Promise<void> {
    requireRegularProject(access)
    const self = userId === access.ctx.user.id && access.membership !== null
    if (!self) access.assert('members.manage')
    const { ctx, project } = access
    await withTx(this.deps.db, async (tx) => {
      await lockProject(tx, project.id)
      const cur = await memberJson(tx, project.id, userId)
      if (!cur) throw memberNotFound()
      if (cur.role === 'admin' && (await adminCount(tx, project.id)) <= 1) throw lastAdmin()
      await tx
        .delete(memberships)
        .where(and(eq(memberships.projectId, project.id), eq(memberships.userId, userId)))
      const revoked = await tx
        .update(tokens)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(tokens.projectId, project.id), eq(tokens.userId, userId), isNull(tokens.revokedAt)))
        .returning({ id: tokens.id })
      const invitesRevoked = cur.role === 'admin' ? await revokeUnbackedInvites(tx, userId) : 0
      await writeAudit(tx, webActor(ctx), {
        projectId: project.id,
        action: 'member.remove',
        summary: self
          ? `${ctx.user.email} left the project`
          : `${ctx.user.email} removed ${cur.user.email} (${cur.role})`,
        data: {
          user_id: userId,
          role: cur.role,
          self,
          tokens_revoked: revoked.length,
          ...(invitesRevoked ? { invites_revoked: invitesRevoked } : {}),
        },
      })
    })
  }
}
