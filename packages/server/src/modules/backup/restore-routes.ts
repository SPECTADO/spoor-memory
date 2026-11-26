/**
 * Full restore routes (api.md section 13.2, ADR-0039): instance admins on the cookie surface only, like every
 * `/api/v1/backups*` route. While the maintenance gate is on, `GET /backups/restore-status` is answered by the
 * gate itself (maintenance.ts), so the handler here only runs with the gate off.
 */
import { isBackupId, restoreConfirmRequest } from '@spoor/shared'
import { type Context, Hono } from 'hono'
import { ApiError } from '../../lib/errors.js'
import { readJson } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import { assertCan, requireInstanceAdmin, type UserContext, webPrincipal } from '../auth/index.js'
import type { RestoreService } from './restore.js'

function admin(c: Context<AppEnv>): UserContext {
  const ctx = requireInstanceAdmin(c)
  assertCan(webPrincipal(ctx.user, null), 'backups.manage')
  c.header('Cache-Control', 'no-store')
  return ctx
}

function backupId(c: Context<AppEnv>): string {
  const id = c.req.param('id')
  if (!id || !isBackupId(id)) throw new ApiError('not_found', { message: 'No such backup.' })
  return id
}

export function restoreRoutes(service: RestoreService) {
  return new Hono<AppEnv>()
    .get('/backups/restore-status', async (c) => {
      admin(c)
      return c.json(await service.status())
    })
    .post('/backups/:id/restore/prepare', async (c) => {
      const ctx = admin(c)
      return c.json(await service.prepare(ctx, c.get('sessionIdHash'), backupId(c)))
    })
    .post('/backups/:id/restore', async (c) => {
      const ctx = admin(c)
      const id = backupId(c)
      const body = await readJson(c, restoreConfirmRequest)
      return c.json(await service.start(ctx, c.get('sessionIdHash'), id, body), 202)
    })
}
