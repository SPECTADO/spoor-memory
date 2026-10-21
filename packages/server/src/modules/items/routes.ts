/**
 * Items routes. Cookie surface (mounted at /api/v1, api.md section 5): spaces, items, revisions, edges,
 * graph, related, operational actions, resolve, and the review queue's bulk verify / archive (api.md section 8). Bearer
 * surface (mounted at /p/:slug/api, api.md sections 7.2 and 7.3): push, adr/import (`decisions/undrafted` is
 * the jobs module's, next to the review lists). Parsing, permission checks and status codes only; the rules
 * are in the services.
 */
import { reviewBulkRequest } from '@spoor/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError } from '../../lib/errors.js'
import { readJson, readQuery, uuidOr404 } from '../../lib/validate.js'
import type { AppEnv } from '../../types.js'
import { assertCan, bearerPrincipal, requireBearer, requireUser } from '../auth/index.js'
import { loadProjectAccess, type ProjectAccess } from '../projects/index.js'
import type { PushService } from './push.js'
import {
  adrImportRequest,
  deleteQuery,
  edgeCreateRequest,
  graphQuery,
  itemCreateRequest,
  itemPatchRequest,
  listQuery,
  noteRequest,
  pushRequest,
  relatedQuery,
  resolveQuery,
  restoreRequest,
  revisionsQuery,
  spaceParam,
  supersedeRequest,
} from './schemas.js'
import type { Caller, ItemService } from './service.js'

/** A cookie caller carries its rights; the services refuse a library write without `library.write`. */
const webCaller = (a: ProjectAccess): Caller => ({
  ctx: a.ctx,
  via: 'web',
  project: { id: a.project.id, slug: a.project.slug, kind: a.project.kind },
  rights: { item: a.can('item.write'), library: a.can('library.write') },
})

function spaceOf(c: Context<AppEnv>) {
  const s = spaceParam.safeParse(c.req.param('space'))
  if (!s.success) throw new ApiError('not_found', { message: 'No such space.' })
  return s.data
}

export function itemRoutes(deps: ServerDeps, items: ItemService) {
  const access = (c: Context<AppEnv>) => loadProjectAccess(deps.db, requireUser(c), c.req.param('slug') ?? '')
  const reader = async (c: Context<AppEnv>) => {
    const a = await access(c)
    a.assert('project.read')
    return webCaller(a)
  }
  // either right opens the write routes; which item a caller may write is the services' (assertWritable)
  const writer = async (c: Context<AppEnv>) => {
    const a = await access(c)
    if (!a.can('library.write')) a.assert('item.write')
    return webCaller(a)
  }
  // the review queue's bulk actions: item editors only (a flagged viewer is refused here)
  const itemWriter = async (c: Context<AppEnv>) => {
    const a = await access(c)
    a.assert('item.write')
    return webCaller(a)
  }
  const ref = (c: Context<AppEnv>) => c.req.param('ref') ?? ''

  return (
    new Hono<AppEnv>()
      // ---- 5.1 lists and create ----
      .get('/projects/:slug/spaces/:space/items', async (c) => {
        const caller = await reader(c)
        return c.json(await items.list(caller, spaceOf(c), readQuery(c, listQuery)))
      })
      .post('/projects/:slug/spaces/:space/items', async (c) => {
        const caller = await writer(c)
        const space = spaceOf(c)
        const body = await readJson(c, itemCreateRequest)
        const r = await items.create(caller, space, body, { dedupe: 'warn' })
        return c.json({ item: r.item, warnings: r.warnings }, 201)
      })

      // ---- 5.2 one item ----
      .get('/projects/:slug/items/:ref', async (c) => c.json(await items.get(await reader(c), ref(c))))
      .patch('/projects/:slug/items/:ref', async (c) => {
        const caller = await writer(c)
        const body = await readJson(c, itemPatchRequest)
        const r = await items.update(caller, ref(c), body)
        return c.json({ item: r.item, warnings: r.warnings })
      })
      .delete('/projects/:slug/items/:ref', async (c) => {
        const a = await access(c)
        a.assert('item.delete')
        const q = readQuery(c, deleteQuery)
        await items.delete(webCaller(a), ref(c), q.confirm)
        return c.body(null, 204)
      })

      // ---- 5.3 operational actions and supersede ----
      .post('/projects/:slug/items/:ref/pin', async (c) => {
        const caller = await writer(c)
        const b = await readJson(c, noteRequest)
        return c.json({ item: await items.pin(caller, ref(c), true, b.note) })
      })
      .post('/projects/:slug/items/:ref/unpin', async (c) => {
        const caller = await writer(c)
        const b = await readJson(c, noteRequest)
        return c.json({ item: await items.pin(caller, ref(c), false, b.note) })
      })
      .post('/projects/:slug/items/:ref/verify', async (c) => {
        const caller = await writer(c)
        const b = await readJson(c, noteRequest)
        return c.json({ item: await items.verify(caller, ref(c), b.note) })
      })
      .post('/projects/:slug/items/:ref/archive', async (c) => {
        const caller = await writer(c)
        const b = await readJson(c, noteRequest)
        return c.json({ item: await items.archive(caller, ref(c), b.note) })
      })
      .post('/projects/:slug/items/:ref/restore', async (c) => {
        const caller = await writer(c)
        const b = await readJson(c, restoreRequest)
        return c.json({ item: await items.restore(caller, ref(c), b) })
      })
      .post('/projects/:slug/items/:ref/supersede', async (c) => {
        const caller = await writer(c)
        const b = await readJson(c, supersedeRequest)
        const r = await items.supersede(caller, ref(c), b)
        return c.json({ new: r.new, old: r.old, warnings: r.warnings })
      })

      // ---- 5.4 revisions ----
      .get('/projects/:slug/items/:ref/revisions', async (c) => {
        const caller = await reader(c)
        return c.json(await items.revisions(caller, ref(c), readQuery(c, revisionsQuery)))
      })
      .get('/projects/:slug/items/:ref/revisions/:n', async (c) => {
        const caller = await reader(c)
        const n = Number(c.req.param('n'))
        if (!Number.isSafeInteger(n) || n < 1) throw new ApiError('not_found')
        return c.json(await items.revision(caller, ref(c), n))
      })

      // ---- 5.5 edges and links ----
      .get('/projects/:slug/items/:ref/edges', async (c) => {
        const a = await access(c)
        a.assert('project.read')
        const members = await items.memberProjectIds(a.ctx.user.id, a.ctx.user.isAdmin)
        return c.json(await items.edges(webCaller(a), ref(c), members))
      })
      .get('/projects/:slug/graph', async (c) => {
        const a = await access(c)
        a.assert('project.read')
        const q = readQuery(c, graphQuery)
        const members = await items.memberProjectIds(a.ctx.user.id, a.ctx.user.isAdmin)
        return c.json(await items.graph(webCaller(a), q, members))
      })
      .get('/projects/:slug/items/:ref/related', async (c) => {
        const caller = await reader(c)
        const q = readQuery(c, relatedQuery)
        return c.json(await items.related(caller, ref(c), q.limit))
      })
      .post('/projects/:slug/items/:ref/edges', async (c) => {
        const caller = await writer(c)
        const b = await readJson(c, edgeCreateRequest)
        const r = await items.relate(caller, ref(c), b.kind, b.to)
        return c.json({ edge: r.edge }, r.changed ? 201 : 200)
      })
      .delete('/projects/:slug/edges/:id', async (c) => {
        const caller = await writer(c)
        await items.removeEdge(caller, uuidOr404(c.req.param('id')))
        return c.body(null, 204)
      })
      .get('/projects/:slug/resolve', async (c) => {
        const caller = await reader(c)
        const q = readQuery(c, resolveQuery)
        return c.json(await items.resolveText(caller, q.ref, q.from))
      })

      // ---- 8 review queue: the bulk action (the lists are the jobs module's) ----
      .post('/projects/:slug/review/bulk', async (c) => {
        const caller = await itemWriter(c)
        const b = await readJson(c, reviewBulkRequest)
        return c.json(await items.reviewBulk(caller, b.action, b.refs))
      })
  )
}

/** Mounted under `/p/:slug/api` after the bearer guards (writes always carry `via='cli'`). */
export function itemBearerRoutes(push: PushService) {
  const caller = (c: Context<AppEnv>, write: boolean): Caller => {
    const ctx = requireBearer(c)
    assertCan(bearerPrincipal(ctx, 'rest'), write ? 'item.write' : 'project.read', { shared: false })
    return {
      ctx,
      via: 'cli',
      project: { id: ctx.project.id, slug: ctx.project.slug, kind: ctx.project.kind },
    }
  }
  return new Hono<AppEnv>()
    .post('/push', async (c) => {
      const call = caller(c, true)
      return c.json(await push.push(call, await readJson(c, pushRequest)))
    })
    .post('/adr/import', async (c) => {
      const call = caller(c, true)
      return c.json(await push.adrImport(call, await readJson(c, adrImportRequest)))
    })
}
