/**
 * Device login, RFC 8628 adapted (auth-and-security.md section 6, api.md section 3, deviations I33, I39, X4).
 *
 * - `requestCode`: public, slug-scoped. Stores only sha256(device_code), the normalised user code, the
 *   cleaned client name and the requester IP. Codes live 10 minutes. Storage is bounded instance-wide at
 *   `maxRows` (10,000): an insert at the cap first evicts finished rows (expired, consumed or denied), then
 *   the oldest pending rows; only when nothing can be evicted (every row an approved, unconsumed live code)
 *   it is 503 `too_many_pending`. One advisory lock serialises inserts, so the cap holds under concurrency.
 * - `poll`: public. `invalid_grant` for unknown, consumed or other-project codes, then `expired_token`,
 *   `access_denied`, `slow_down` (pending and polled sooner than `interval_s` after the last poll; the
 *   interval grows by 5 s for good), `authorization_pending`. An approved code is consumed in one
 *   transaction that mints the user token (origin `device`, 90 days, the approval's role cap) and audits
 *   `token.create` with the requester IP. The plaintext token exists only in that response.
 * - `lookup` / `approve` / `deny`: cookie users who are members of the code's project (or instance admins).
 *   A wrong code, an expired one and a code of a project the user is not a member of are the same 404 and
 *   count as a miss; 5 misses in 10 minutes lock the user out of all three for 10 minutes (403 `forbidden`).
 */
import type { ProjectRole } from '@spoor/shared'
import {
  DEVICE_GRANT_TYPE,
  type DeviceApproveResponse,
  type DeviceCodeResponse,
  type DeviceDenyResponse,
  type DeviceLookupResponse,
  type DeviceTokenResponse,
} from '@spoor/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { deviceCodes, memberships, projects, users } from '../../db/schema.js'
import { type AuditActor, writeAudit } from '../../lib/audit.js'
import { type AuthContext, capRole, effectiveRole } from '../../lib/auth-context.js'
import { randomSecret, sha256 } from '../../lib/crypto.js'
import { type Tx, withTx } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError } from '../../lib/errors.js'
import type { UserContext } from '../auth/index.js'
import { accessFor } from '../projects/index.js'
import { mintToken } from '../tokens/index.js'
import { cleanClientName, displayIp, formatUserCode, generateUserCode, normalizeUserCode } from './codes.js'
import { MissLimiter, type MissLimiterOptions } from './limiter.js'

export const DEVICE_CODE_TTL_S = 600
export const DEVICE_POLL_INTERVAL_S = 5
export const SLOW_DOWN_STEP_S = 5
export const DEVICE_TOKEN_DAYS = 90
export const MAX_DEVICE_ROWS = 10_000

/** Two-int advisory key (its own key space): serialises code inserts instance-wide. */
const LOCK_KEY = sql`8628, 1`

export interface DeviceServiceOptions {
  /** Storage cap of `device_codes` (default 10,000). */
  maxRows?: number
  limiter?: MissLimiterOptions
}

type DeviceRow = typeof deviceCodes.$inferSelect

const notFound = () =>
  new ApiError('not_found', {
    message: 'No pending login request with this code.',
    hint: 'Check the code your terminal shows; codes expire after 10 minutes.',
  })

export class DeviceService {
  readonly misses: MissLimiter
  private readonly maxRows: number

  constructor(
    private readonly deps: ServerDeps,
    opts: DeviceServiceOptions = {},
  ) {
    this.maxRows = opts.maxRows ?? MAX_DEVICE_ROWS
    this.misses = new MissLimiter(opts.limiter)
  }

  private get db() {
    return this.deps.db
  }

  /** A regular project by slug, or 404 (`_shared` and unknown slugs alike; slugs are not secret). */
  private async projectBySlug(slug: string) {
    const [p] = await this.db
      .select({ id: projects.id, slug: projects.slug, name: projects.name })
      .from(projects)
      .where(and(eq(projects.slug, slug), eq(projects.kind, 'project')))
      .limit(1)
    if (!p) throw new ApiError('not_found', { message: 'No such project.' })
    return p
  }

  // ---- CLI side (public) ------------------------------------------------------------------------------

  /** `POST /p/:slug/device/code`. */
  async requestCode(
    slug: string,
    input: { clientName?: string; requesterIp?: string | null },
  ): Promise<DeviceCodeResponse> {
    const project = await this.projectBySlug(slug)
    const deviceCode = randomSecret()
    const clientName = cleanClientName(input.clientName)
    const ip = displayIp(input.requesterIp)
    const userCode = await withTx(this.db, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`)
      await this.makeRoom(tx)
      // inserts are serialised by the lock, so a free code checked here stays free until the insert
      let code: string | null = null
      for (let i = 0; i < 8 && code === null; i++) {
        const candidate = generateUserCode()
        const [taken] = await tx
          .select({ id: deviceCodes.id })
          .from(deviceCodes)
          .where(
            and(eq(deviceCodes.userCode, candidate), inArray(deviceCodes.status, ['pending', 'approved'])),
          )
          .limit(1)
        if (!taken) code = candidate
      }
      if (code === null) throw new ApiError('too_many_pending', { message: 'Try again in a moment.' })
      await tx.insert(deviceCodes).values({
        deviceCodeHash: sha256(deviceCode),
        userCode: code,
        projectId: project.id,
        clientName,
        requesterIp: ip,
        intervalS: DEVICE_POLL_INTERVAL_S,
        expiresAt: sql`now() + make_interval(secs => ${DEVICE_CODE_TTL_S})`,
      })
      return code
    })
    return {
      device_code: deviceCode,
      user_code: formatUserCode(userCode),
      verification_uri: `${this.deps.config.publicOrigin}/device`,
      expires_in: DEVICE_CODE_TTL_S,
      interval: DEVICE_POLL_INTERVAL_S,
    }
  }

  /** Under the insert lock: keep the table below the cap (finished rows first, then the oldest pending). */
  private async makeRoom(tx: Tx): Promise<void> {
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(deviceCodes)
    let need = (row?.n ?? 0) - this.maxRows + 1
    if (need <= 0) return
    const evict = async (where: ReturnType<typeof sql>, limit: number) => {
      const res = await tx.execute(sql`DELETE FROM device_codes WHERE id IN (
          SELECT id FROM device_codes WHERE ${where} ORDER BY created_at, id LIMIT ${limit})`)
      return res.rowCount ?? 0
    }
    need -= await evict(sql`expires_at <= now() OR status IN ('consumed', 'denied')`, need)
    if (need > 0) need -= await evict(sql`status = 'pending'`, need)
    if (need > 0) {
      throw new ApiError('too_many_pending', {
        message: 'Too many login requests are waiting for approval on this instance.',
        hint: 'Try again in a few minutes.',
      })
    }
  }

  /** `POST /p/:slug/device/token`. */
  async poll(slug: string, input: { grantType: string; deviceCode: string }): Promise<DeviceTokenResponse> {
    const project = await this.projectBySlug(slug)
    if (input.grantType !== DEVICE_GRANT_TYPE) {
      throw new ApiError('unsupported_grant_type', { message: `grant_type must be ${DEVICE_GRANT_TYPE}.` })
    }
    const invalidGrant = () =>
      new ApiError('invalid_grant', {
        message: 'Unknown or already used device code.',
        hint: 'Run spoor login again.',
      })
    if (input.deviceCode === '') throw invalidGrant()

    const decided = await withTx(this.db, async (tx) => {
      const [row] = await tx
        .select({
          row: deviceCodes,
          expired: sql<boolean>`${deviceCodes.expiresAt} <= now()`,
          tooSoon: sql<boolean>`${deviceCodes.lastPolledAt} IS NOT NULL
            AND ${deviceCodes.lastPolledAt} > now() - make_interval(secs => ${deviceCodes.intervalS})`,
        })
        .from(deviceCodes)
        .where(eq(deviceCodes.deviceCodeHash, sha256(input.deviceCode)))
        .for('update')
      if (!row || row.row.projectId !== project.id || row.row.status === 'consumed')
        return { error: invalidGrant() }
      if (row.expired)
        return {
          error: new ApiError('expired_token', { message: 'The code expired; run spoor login again.' }),
        }
      if (row.row.status === 'denied') {
        return {
          error: new ApiError('access_denied', { message: 'The login request was denied in the browser.' }),
        }
      }
      if (row.row.status === 'pending') {
        const slow = row.tooSoon
        const interval = slow ? row.row.intervalS + SLOW_DOWN_STEP_S : row.row.intervalS
        await tx
          .update(deviceCodes)
          .set({ lastPolledAt: sql`now()`, intervalS: interval })
          .where(eq(deviceCodes.id, row.row.id))
        return {
          error: slow
            ? new ApiError('slow_down', {
                message: `Poll at most every ${interval} seconds.`,
                details: { interval },
              })
            : new ApiError('authorization_pending', { message: 'Waiting for approval in the browser.' }),
        }
      }
      return { approved: row.row }
    })
    // errors are returned, not thrown, so the poll bookkeeping above commits
    if ('error' in decided) throw decided.error
    return this.consume(decided.approved, project)
  }

  /** Approved → consumed + one new user token, in one transaction. */
  private async consume(
    approved: DeviceRow,
    project: { id: string; slug: string; name: string },
  ): Promise<DeviceTokenResponse> {
    const out = await withTx(this.db, async (tx): Promise<DeviceTokenResponse | ApiError> => {
      const [row] = await tx
        .update(deviceCodes)
        .set({ status: 'consumed' })
        .where(and(eq(deviceCodes.id, approved.id), eq(deviceCodes.status, 'approved')))
        .returning()
      if (!row || row.userId === null) {
        throw new ApiError('invalid_grant', { message: 'Unknown or already used device code.' })
      }
      // the approver must still have access now: disabled, removed or demoted to nothing → denied
      const [u] = await tx
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          isAdmin: users.isAdmin,
          sharedEditor: users.sharedEditor,
          disabled: sql<boolean>`${users.disabledAt} IS NOT NULL`,
          membership: memberships.role,
          today: sql<string>`to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
        })
        .from(users)
        .leftJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.projectId, project.id)))
        .where(eq(users.id, row.userId))
        .limit(1)
      const role =
        u && !u.disabled
          ? capRole(effectiveRole(u.isAdmin, u.membership as ProjectRole | null), row.roleCap)
          : null
      if (!u || role === null) {
        // committed as denied (no token), so the CLI stops polling
        await tx.update(deviceCodes).set({ status: 'denied' }).where(eq(deviceCodes.id, row.id))
        return new ApiError('access_denied', {
          message: 'The approving account no longer has access to this project.',
        })
      }
      const name = `${row.clientName} (device ${u.today})`
      const { row: token, secret } = await mintToken(tx, {
        projectId: project.id,
        kind: 'user',
        userId: u.id,
        role: row.roleCap,
        name,
        origin: 'device',
        expiresAt: sql`now() + make_interval(days => ${DEVICE_TOKEN_DAYS})`,
        createdBy: u.id,
      })
      await tx.update(deviceCodes).set({ tokenId: token.id }).where(eq(deviceCodes.id, row.id))
      const ctx: AuthContext = {
        user: { id: u.id, email: u.email, name: u.name, isAdmin: u.isAdmin, sharedEditor: u.sharedEditor },
        project: { ...project, kind: 'project' },
        role,
        via: 'bearer',
        tokenId: token.id,
        clientName: row.clientName,
      }
      const actor: AuditActor = { ctx, via: 'cli' }
      await writeAudit(tx, actor, {
        projectId: project.id,
        action: 'token.create',
        summary: `${u.email} logged in a device: user token "${name}"${row.roleCap ? ` (${row.roleCap})` : ''}`,
        data: {
          token_id: token.id,
          kind: 'user',
          role: row.roleCap,
          origin: 'device',
          expires_at: token.expiresAt?.toISOString() ?? null,
          requester_ip: row.requesterIp,
          device_code_id: row.id,
        },
      })
      return { access_token: secret, token_type: 'Bearer', project: project.slug, role, token_name: name }
    })
    if (out instanceof ApiError) throw out
    return out
  }

  // ---- browser side (cookie) -----------------------------------------------------------------------------

  /**
   * The pending, unexpired code `raw` of a project the user may approve for, or a 404 that counts as a miss.
   * A locked user gets 403 before anything is looked up.
   */
  private async findForUser(ctx: UserContext, raw: string) {
    const left = this.misses.lockedFor(ctx.user.id)
    if (left > 0) throw this.locked(left)
    const code = normalizeUserCode(raw)
    const row = code === null ? undefined : await this.pendingByCode(code, ctx.user.id)
    if (row) {
      const access = accessFor(ctx, row.project, (row.membership ?? null) as ProjectRole | null)
      if (
        row.project.kind === 'project' &&
        (row.membership !== null || ctx.user.isAdmin) &&
        access.can('device.approve')
      ) {
        return { ...row, access }
      }
    }
    const lockedNow = this.misses.miss(ctx.user.id)
    if (lockedNow) throw this.locked(this.misses.lockedFor(ctx.user.id))
    throw notFound()
  }

  private locked(ms: number) {
    const minutes = Math.max(1, Math.ceil(ms / 60_000))
    return new ApiError('forbidden', {
      message: 'Too many wrong codes.',
      hint: `Code lookup is locked for your account for ${minutes} more minute${minutes === 1 ? '' : 's'}.`,
    })
  }

  private async pendingByCode(code: string, userId: string) {
    const [row] = await this.db
      .select({
        code: deviceCodes,
        project: projects,
        membership: memberships.role,
        ageS: sql<number>`greatest(0, floor(extract(epoch from now() - ${deviceCodes.createdAt})))::int`,
      })
      .from(deviceCodes)
      .innerJoin(projects, eq(projects.id, deviceCodes.projectId))
      .leftJoin(memberships, and(eq(memberships.projectId, projects.id), eq(memberships.userId, userId)))
      .where(
        and(
          eq(deviceCodes.userCode, code),
          eq(deviceCodes.status, 'pending'),
          sql`${deviceCodes.expiresAt} > now()`,
        ),
      )
      .limit(1)
    return row
  }

  /** `GET /api/v1/device/lookup?code=`. */
  async lookup(ctx: UserContext, raw: string): Promise<DeviceLookupResponse> {
    const { code, project, ageS, access } = await this.findForUser(ctx, raw)
    return {
      project: { slug: project.slug, name: project.name },
      client_name: code.clientName,
      requester_ip: code.requesterIp,
      requested_at: code.createdAt.toISOString(),
      age_s: ageS,
      your_role: access.role,
    }
  }

  /** `POST /api/v1/device/approve`: `read_only` caps the token that the poll will mint at `viewer`. */
  async approve(ctx: UserContext, raw: string, readOnly: boolean): Promise<DeviceApproveResponse> {
    const roleCap = readOnly ? 'viewer' : null
    await this.decide(ctx, raw, 'approved', roleCap)
    return { status: 'approved', role_cap: roleCap }
  }

  /** `POST /api/v1/device/deny`. */
  async deny(ctx: UserContext, raw: string): Promise<DeviceDenyResponse> {
    await this.decide(ctx, raw, 'denied', null)
    return { status: 'denied' }
  }

  private async decide(
    ctx: UserContext,
    raw: string,
    status: 'approved' | 'denied',
    roleCap: 'viewer' | null,
  ): Promise<void> {
    const found = await this.findForUser(ctx, raw)
    await withTx(this.db, async (tx) => {
      const [row] = await tx
        .update(deviceCodes)
        .set({ status, userId: ctx.user.id, roleCap, decidedAt: sql`now()` })
        .where(
          and(
            eq(deviceCodes.id, found.code.id),
            eq(deviceCodes.status, 'pending'),
            sql`${deviceCodes.expiresAt} > now()`,
          ),
        )
        .returning()
      // decided or expired meanwhile (another tab): the same 404 as an unknown code
      if (!row) throw notFound()
      await writeAudit(
        tx,
        { ctx: { ...ctx, clientName: 'web' }, via: 'web' },
        {
          projectId: found.project.id,
          action: status === 'approved' ? 'device.approve' : 'device.deny',
          summary:
            status === 'approved'
              ? `${ctx.user.email} approved a device login${roleCap ? ' (read-only)' : ''} for "${row.clientName}"`
              : `${ctx.user.email} denied a device login for "${row.clientName}"`,
          data: {
            device_code_id: row.id,
            role_cap: roleCap,
            requester_ip: row.requesterIp,
            client_name: row.clientName,
          },
        },
      )
    })
  }
}
