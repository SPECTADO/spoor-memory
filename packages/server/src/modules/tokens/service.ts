/**
 * API tokens (api.md sections 4.3 and 7.2; auth-and-security.md section 5; data-model.md section 2).
 * Format `spr_` (user) / `sprs_` (service) + 32 random bytes base64url; the DB keeps sha256 and the first 12
 * characters for display. The plaintext exists only in the create response (or the device-flow poll).
 */
import {
  SERVICE_TOKEN_PREFIX,
  TOKEN_DISPLAY_LENGTH,
  type TokenCreateResponse,
  type TokenJson,
  USER_TOKEN_PREFIX,
  type WhoamiResponse,
} from '@spoor/shared'
import { and, desc, eq, isNull, type SQL, sql } from 'drizzle-orm'
import { projects, tokens, users } from '../../db/schema.js'
import { webActor, writeAudit } from '../../lib/audit.js'
import { type AuthContext, actorLabel } from '../../lib/auth-context.js'
import { randomSecret, sha256 } from '../../lib/crypto.js'
import { type DbOrTx, type Tx, withTx } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError } from '../../lib/errors.js'
import { VERSION } from '../../version.js'
import { type ProjectAccess, requireRegularProject } from '../projects/index.js'

type TokenRow = typeof tokens.$inferSelect

export interface MintTokenInput {
  projectId: string
  kind: 'user' | 'service'
  /** Required for user tokens, null for service tokens. */
  userId: string | null
  /** Service: the fixed role. User: optional cap (`null` = inherit the membership role). */
  role: 'editor' | 'viewer' | null
  name: string
  origin: 'web' | 'device'
  /** `null` = no expiry; device-minted tokens pass `now() + 90 days` (deviation I33). */
  expiresAt: Date | SQL | null
  createdBy: string | null
}

/**
 * Insert a token and return its row and the plaintext (shown once). Runs in the caller's transaction; the
 * caller writes the `token.create` audit row. Used by the token routes and by the device flow.
 */
export async function mintToken(
  tx: DbOrTx,
  input: MintTokenInput,
): Promise<{ row: TokenRow; secret: string }> {
  const secret = randomSecret(input.kind === 'service' ? SERVICE_TOKEN_PREFIX : USER_TOKEN_PREFIX)
  const [row] = await tx
    .insert(tokens)
    .values({
      kind: input.kind,
      tokenHash: sha256(secret),
      prefix: secret.slice(0, TOKEN_DISPLAY_LENGTH),
      name: input.name,
      projectId: input.projectId,
      userId: input.kind === 'user' ? input.userId : null,
      role: input.role,
      origin: input.origin,
      expiresAt: input.expiresAt,
      createdBy: input.createdBy,
    })
    .returning()
  return { row: row as TokenRow, secret }
}

const iso = (d: Date | null) => d?.toISOString() ?? null

export function tokenJson(row: TokenRow, userLabel: string | null): TokenJson {
  return {
    id: row.id,
    kind: row.kind,
    origin: row.origin,
    name: row.name,
    prefix: row.prefix,
    role: row.role,
    user: row.userId !== null ? { id: row.userId, label: userLabel ?? '' } : null,
    created_at: row.createdAt.toISOString(),
    last_used_at: iso(row.lastUsedAt),
    expires_at: iso(row.expiresAt),
    revoked_at: iso(row.revokedAt),
  }
}

const tokenNotFound = () => new ApiError('not_found', { message: 'No such token in this project.' })

export class TokenService {
  constructor(private readonly deps: ServerDeps) {}

  /** Members see their own user tokens; project admins and instance admins see every token of the project. */
  async list(access: ProjectAccess, includeRevoked: boolean): Promise<{ items: TokenJson[] }> {
    requireRegularProject(access)
    const all = access.can('service_token.manage')
    const rows = await this.deps.db
      .select({ token: tokens, email: users.email })
      .from(tokens)
      .leftJoin(users, eq(users.id, tokens.userId))
      .where(
        and(
          eq(tokens.projectId, access.project.id),
          all ? undefined : and(eq(tokens.kind, 'user'), eq(tokens.userId, access.ctx.user.id)),
          includeRevoked ? undefined : isNull(tokens.revokedAt),
        ),
      )
      .orderBy(desc(tokens.createdAt), desc(tokens.id))
    return { items: rows.map((r) => tokenJson(r.token, r.email)) }
  }

  /**
   * User token: any member, always for themselves, optional read-only cap. Service token: PA / IA, fixed
   * role `editor` or `viewer` (never admin). Optional expiry, which must lie in the future.
   */
  async create(
    access: ProjectAccess,
    input: { kind: 'user' | 'service'; name: string; role?: 'editor' | 'viewer'; expires_at?: string },
  ): Promise<TokenCreateResponse> {
    requireRegularProject(access)
    access.assert(input.kind === 'service' ? 'service_token.manage' : 'token.create_own')
    const role = input.role ?? null
    if (input.kind === 'service' && role === null) {
      throw new ApiError('invalid_input', {
        message: 'A service token needs a role.',
        details: { issues: [{ path: 'role', message: 'editor or viewer' }] },
      })
    }
    const expiresAt = input.expires_at === undefined ? null : new Date(input.expires_at)
    if (expiresAt !== null && !(expiresAt.getTime() > Date.now())) {
      throw new ApiError('invalid_input', {
        message: 'expires_at must lie in the future.',
        details: { issues: [{ path: 'expires_at', message: 'must lie in the future' }] },
      })
    }
    const { ctx, project } = access
    return withTx(this.deps.db, async (tx) => {
      const { row, secret } = await mintToken(tx, {
        projectId: project.id,
        kind: input.kind,
        userId: input.kind === 'user' ? ctx.user.id : null,
        role,
        name: input.name,
        origin: 'web',
        expiresAt,
        createdBy: ctx.user.id,
      })
      await writeAudit(tx, webActor(ctx), {
        projectId: project.id,
        action: 'token.create',
        summary: `${ctx.user.email} created ${input.kind} token "${row.name}"${role ? ` (${role})` : ''}`,
        data: { token_id: row.id, kind: row.kind, role, origin: 'web', expires_at: iso(row.expiresAt) },
      })
      return { token: tokenJson(row, input.kind === 'user' ? ctx.user.email : null), secret }
    })
  }

  /** Owner, PA or IA. Sets `revoked_at`; the row stays for the audit trail. Revoking twice is a no-op. */
  async revoke(access: ProjectAccess, tokenId: string): Promise<void> {
    requireRegularProject(access)
    const { ctx, project } = access
    await withTx(this.deps.db, async (tx: Tx) => {
      const [row] = await tx
        .select()
        .from(tokens)
        .where(and(eq(tokens.id, tokenId), eq(tokens.projectId, project.id)))
        .for('update')
      if (!row) throw tokenNotFound()
      const owns = row.kind === 'user' && row.userId === ctx.user.id
      // a member who may not see the token (not theirs) learns nothing about it
      if (!owns && !access.can('service_token.manage')) throw tokenNotFound()
      access.assert('token.revoke', { ownsToken: owns })
      if (row.revokedAt !== null) return
      await tx.update(tokens).set({ revokedAt: sql`now()` }).where(eq(tokens.id, row.id))
      await writeAudit(tx, webActor(ctx), {
        projectId: project.id,
        action: 'token.revoke',
        summary: `${ctx.user.email} revoked ${row.kind} token "${row.name}"`,
        data: { token_id: row.id, kind: row.kind, own: owns },
      })
    })
  }

  /** `GET /p/:slug/api/whoami`: the token, its effective role and the next free ADR number (deviation X6). */
  async whoami(ctx: AuthContext & { project: NonNullable<AuthContext['project']> }): Promise<WhoamiResponse> {
    const [p] = await this.deps.db
      .select({ slug: projects.slug, name: projects.name, nextAdrNumber: projects.nextAdrNumber })
      .from(projects)
      .where(eq(projects.id, ctx.project.id))
      .limit(1)
    if (!p || ctx.role === null || ctx.tokenId === undefined) throw new ApiError('invalid_token')
    const [t] = await this.deps.db
      .select({ expiresAt: tokens.expiresAt })
      .from(tokens)
      .where(eq(tokens.id, ctx.tokenId))
      .limit(1)
    return {
      project: { slug: p.slug, name: p.name, next_adr_number: p.nextAdrNumber },
      token: {
        id: ctx.tokenId,
        name: ctx.tokenName ?? '',
        kind: ctx.tokenKind ?? (ctx.user ? 'user' : 'service'),
        prefix: ctx.tokenPrefix ?? '',
        role: ctx.role,
        expires_at: t?.expiresAt ? t.expiresAt.toISOString() : null,
      },
      user: { label: actorLabel(ctx) },
      server: { version: VERSION },
    }
  }
}
