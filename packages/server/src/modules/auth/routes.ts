/**
 * Cookie routes of the auth module, mounted at /api/v1 (api.md sections 1, 2.1, 2.2).
 * Parsing and status codes only; the logic is in service.ts and invites.ts.
 */
import {
  INVITE_STATUSES,
  inviteAcceptRequest,
  inviteCreateRequest,
  invitePreviewRequest,
  loginRequest,
  mePatchRequest,
  passwordChangeRequest,
  userPatchRequest,
} from '@spoor/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ServerDeps } from '../../lib/deps.js'
import { paginationQuery } from '../../lib/pagination.js'
import { readJson, readQuery, uuidOr404 } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import type { InviteService } from './invites.js'
import { requireInstanceAdmin, requireUser } from './middleware.js'
import type { AuthService, UserService } from './service.js'
import { clearSessionCookie, setSessionCookie } from './sessions.js'

export interface AuthRouteServices {
  auth: AuthService
  invites: InviteService
  users: UserService
}

const inviteListQuery = z.strictObject({ status: z.enum(INVITE_STATUSES).optional(), ...paginationQuery })
const userListQuery = z.strictObject({ q: z.string().max(200).optional(), ...paginationQuery })
const userDeleteQuery = z.strictObject({ confirm: z.string().max(320).optional() })

export function authRoutes(deps: ServerDeps, s: AuthRouteServices) {
  const { config } = deps
  return (
    new Hono<AppEnv>()
      // ---- 1. auth ----
      .post('/auth/login', async (c) => {
        const body = await readJson(c, loginRequest)
        const { user, sid } = await s.auth.login(
          body.email,
          body.password,
          c.req.header('user-agent'),
          c.get('sessionIdHash'),
        )
        setSessionCookie(c, config, sid)
        return c.json({ user })
      })
      .post('/auth/logout', async (c) => {
        requireUser(c)
        await s.auth.logout(c.get('sessionIdHash'))
        clearSessionCookie(c, config)
        return c.body(null, 204)
      })
      .get('/me', async (c) => c.json(await s.auth.me(requireUser(c).user)))
      .patch('/me', async (c) => {
        const ctx = requireUser(c)
        const body = await readJson(c, mePatchRequest)
        return c.json({ user: await s.auth.updateMe(ctx, body.name) })
      })
      .post('/me/password', async (c) => {
        const ctx = requireUser(c)
        const body = await readJson(c, passwordChangeRequest)
        await s.auth.changePassword(ctx, body.current_password, body.new_password, c.get('sessionIdHash'))
        return c.body(null, 204)
      })

      // ---- 2.1 invites ----
      .post('/invites/preview', async (c) => {
        const body = await readJson(c, invitePreviewRequest)
        return c.json(await s.invites.preview(body.token))
      })
      .post('/invites/accept', async (c) => {
        const body = await readJson(c, inviteAcceptRequest)
        const { user, sid } = await s.invites.accept(body, c.req.header('user-agent'))
        if (sid) setSessionCookie(c, config, sid)
        return c.json({ user }, 201)
      })
      .get('/invites', async (c) => {
        const ctx = requireUser(c)
        return c.json(await s.invites.list(ctx, readQuery(c, inviteListQuery)))
      })
      .post('/invites', async (c) => {
        const ctx = requireUser(c)
        const body = await readJson(c, inviteCreateRequest)
        return c.json(await s.invites.create(ctx, body), 201)
      })
      .delete('/invites/:id', async (c) => {
        const ctx = requireUser(c)
        await s.invites.revoke(ctx, uuidOr404(c.req.param('id')))
        return c.body(null, 204)
      })

      // ---- 2.2 users (instance admin) ----
      .get('/users', async (c) => {
        requireInstanceAdmin(c)
        const q = readQuery(c, userListQuery)
        return c.json(await s.users.list(q.q, q.cursor, q.limit))
      })
      .get('/users/:id', async (c) => {
        requireInstanceAdmin(c)
        return c.json(await s.users.get(uuidOr404(c.req.param('id'))))
      })
      .patch('/users/:id', async (c) => {
        const ctx = requireInstanceAdmin(c)
        const body = await readJson(c, userPatchRequest)
        return c.json(await s.users.update(ctx, uuidOr404(c.req.param('id')), body))
      })
      .delete('/users/:id', async (c) => {
        const ctx = requireInstanceAdmin(c)
        const q = readQuery(c, userDeleteQuery)
        await s.users.delete(ctx, uuidOr404(c.req.param('id')), q.confirm)
        return c.body(null, 204)
      })
  )
}
