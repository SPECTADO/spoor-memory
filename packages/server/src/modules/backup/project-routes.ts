/**
 * `/api/v1/backups/:id/projects/:projectId/{restore,exports}` (api.md section 13.3): one project from a backup.
 * Instance admins on the cookie surface only, like every backup route (routes.ts). `:id` must be a backup id and
 * `:projectId` a uuid; anything else is 404 before a path is built.
 */
import { exportTaskCreateRequest, isBackupId, projectRestoreRequest } from '@spoor/shared'
import { type Context, Hono } from 'hono'
import { ApiError } from '../../lib/errors.js'
import { readJson } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import { assertCan, requireInstanceAdmin, type UserContext, webPrincipal } from '../auth/index.js'
import type { ProjectRestoreService } from './project-restore.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function admin(c: Context<AppEnv>): UserContext {
  const ctx = requireInstanceAdmin(c)
  assertCan(webPrincipal(ctx.user, null), 'backups.manage')
  c.header('Cache-Control', 'no-store')
  return ctx
}

function params(c: Context<AppEnv>): { backupId: string; projectId: string } {
  const backupId = c.req.param('id')
  if (!backupId || !isBackupId(backupId)) throw new ApiError('not_found', { message: 'No such backup.' })
  const projectId = c.req.param('projectId')?.toLowerCase()
  if (!projectId || !UUID_RE.test(projectId)) {
    throw new ApiError('not_found', { message: 'That project is not in this backup.' })
  }
  return { backupId, projectId }
}

export function backupProjectRoutes(service: ProjectRestoreService) {
  return new Hono<AppEnv>()
    .post('/backups/:id/projects/:projectId/restore', async (c) => {
      const ctx = admin(c)
      const { backupId, projectId } = params(c)
      const body = await readJson(c, projectRestoreRequest)
      return c.json(await service.restore(ctx, backupId, projectId, body))
    })
    .post('/backups/:id/projects/:projectId/exports', async (c) => {
      const ctx = admin(c)
      const { backupId, projectId } = params(c)
      await readJson(c, exportTaskCreateRequest)
      return c.json(await service.createExport(ctx, backupId, projectId), 202)
    })
}
