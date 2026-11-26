/**
 * `/api/v1/backups*` (api.md section 13.1, 13.3 list): instance admins on the cookie surface only. The
 * `/api/v1` guards already refuse an Authorization header, so a bearer token never gets here; MCP has no backup
 * tools. Every `:id` must be a backup id (`isBackupId`), anything else is 404 before a path is built.
 */
import { backupPatchRequest, backupSettingsPutRequest, isBackupId } from '@spoor/shared'
import { type Context, Hono } from 'hono'
import { ApiError } from '../../lib/errors.js'
import { readJson } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import { assertCan, requireInstanceAdmin, type UserContext, webPrincipal } from '../auth/index.js'
import type { BackupService } from './service.js'

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

export function backupRoutes(service: BackupService) {
  return new Hono<AppEnv>()
    .get('/backups', async (c) => {
      admin(c)
      return c.json(await service.list())
    })
    .put('/backups/settings', async (c) => {
      const ctx = admin(c)
      const body = await readJson(c, backupSettingsPutRequest)
      return c.json(await service.putSettings(ctx, body))
    })
    .post('/backups', async (c) => {
      const ctx = admin(c)
      return c.json(await service.startManual(ctx), 202)
    })
    .patch('/backups/:id', async (c) => {
      const ctx = admin(c)
      const id = backupId(c)
      const body = await readJson(c, backupPatchRequest)
      return c.json(await service.setPinned(ctx, id, body.pinned))
    })
    .delete('/backups/:id', async (c) => {
      const ctx = admin(c)
      await service.remove(ctx, backupId(c))
      return c.body(null, 204)
    })
    .post('/backups/:id/verify', async (c) => {
      admin(c)
      return c.json(await service.verify(backupId(c)))
    })
    .get('/backups/:id/projects', async (c) => {
      admin(c)
      return c.json(await service.projects(backupId(c)))
    })
}
