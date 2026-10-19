// Review-queue lists (api.md section 8), job status and run-now (api.md section 10) and the bearer
// `decisions/undrafted` list (api.md section 7.2). app.ts does not mount this module yet, so the test builds
// the same chain: request id, the auth module's cookie / bearer guards, these routes, the error mapping.
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import {
  addMember,
  createAdmin,
  createItem,
  createProject,
  createSharedProject,
  createToken,
  createUser,
  DEFAULT_PASSWORD,
} from '../../../test/factories.js'
import { json, loginAs, testConfig } from '../../../test/http.js'
import { stubPorts } from '../../../test/ports.js'
import { auditLog, edges } from '../../db/schema.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError, apiErrorResponse, errorResponse } from '../../lib/errors.js'
import type { AppEnv } from '../../types.js'
import { createAuthModule } from '../auth/index.js'
import { createJobsModule, createScheduler } from './index.js'

const db = () => testDb()
const ago = (days: number) => sql`now() - make_interval(secs => ${days * 86_400}::float8)`

function buildApp(env: Record<string, string> = {}) {
  const config = testConfig(env)
  const logger = pino({ level: 'silent' })
  const deps: ServerDeps = { config, logger, db: db(), ports: stubPorts() }
  const scheduler = createScheduler(deps, { instanceId: 'it:routes' })
  const auth = createAuthModule(deps)
  const jobs = createJobsModule(deps, { scheduler })
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('requestId', 'test')
    c.set('log', logger)
    await next()
  })
  const api = new Hono<AppEnv>()
  api.use('*', ...auth.cookieApiGuards)
  api.route('/', auth.routes)
  api.route('/', jobs.routes)
  app.route('/api/v1', api)
  const bearer = new Hono<AppEnv>()
  bearer.use('*', ...auth.bearerApiGuards)
  bearer.route('/', jobs.bearerRoutes)
  app.route('/p/:slug/api', bearer)
  app.onError((err, c) => {
    if (err instanceof ApiError) return apiErrorResponse(c, err)
    if (err instanceof HTTPException) return err.getResponse()
    return errorResponse(c, 'internal', { message: String(err) })
  })
  return { app, scheduler }
}

async function setup() {
  const { app, scheduler } = buildApp()
  const admin = await createAdmin(db(), { email: 'admin@example.com' })
  const editor = await createUser(db(), { email: 'ed@example.com' })
  const viewer = await createUser(db(), { email: 'vi@example.com' })
  const outsider = await createUser(db(), { email: 'out@example.com' })
  const p = await createProject(db(), {
    slug: 'acme',
    settings: { cleanup: { stale_days: 30, archive_days: 90 } },
  })
  await addMember(db(), p.id, editor.id, 'editor')
  await addMember(db(), p.id, viewer.id, 'viewer')
  const login = (email: string) => loginAs(app, email, DEFAULT_PASSWORD)
  return { app, scheduler, admin, editor, viewer, outsider, p, login }
}

async function setItem(id: string, set: ReturnType<typeof sql>) {
  await db().execute(sql`UPDATE items SET ${set} WHERE id = ${id}`)
}

type Page<T = Record<string, unknown>> = { items: T[]; next_cursor: string | null }

describe('GET /api/v1/projects/:slug/review', () => {
  it('counts every section; members only (404 for outsiders), viewers included', async () => {
    const { p, login } = await setup()
    const stale = await createItem(db(), { projectId: p.id })
    await setItem(stale.id, sql`lifecycle = 'stale', stale_since = ${ago(5)}`)
    const archived = await createItem(db(), { projectId: p.id })
    await setItem(archived.id, sql`lifecycle = 'archived', archived_at = ${ago(3)}, archive_reason = 'stale'`)
    const oldArchived = await createItem(db(), { projectId: p.id })
    await setItem(
      oldArchived.id,
      sql`lifecycle = 'archived', archived_at = ${ago(31)}, archive_reason = 'manual'`,
    )
    const obs = await createItem(db(), { projectId: p.id, type: 'observation' })
    await setItem(obs.id, sql`expires_at = now() + interval '20 hours'`)
    await createItem(db(), { projectId: p.id, type: 'observation' }) // 7 days left: not expiring
    const adr = await createItem(db(), { projectId: p.id, space: 'decisions', status: 'accepted' })
    await setItem(adr.id, sql`push_conflict_at = now(), source_path = 'docs/adr/0001-x.md'`)
    const a = await createItem(db(), { projectId: p.id })
    const b = await createItem(db(), { projectId: p.id })
    await db()
      .insert(edges)
      .values({ projectId: p.id, srcId: a.id, kind: 'conflicts_with', dstRef: `m${b.number}`, dstId: b.id })

    const vi = await login('vi@example.com')
    const res = await vi.get('/api/v1/projects/acme/review')
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      counts: { stale: 1, archived: 1, expiring: 1, conflicts: 1, push_conflicts: 1 },
    })
    const out = await login('out@example.com')
    expect((await out.get('/api/v1/projects/acme/review')).status).toBe(404)
  })

  it('the shared project is readable by every logged-in user', async () => {
    const { login } = await setup()
    await createSharedProject(db())
    const out = await login('out@example.com')
    const res = await out.get('/api/v1/projects/_shared/review')
    expect(res.status).toBe(200)
  })

  it('lists of _shared itself carry plain handles, like the items lists (no S: prefix)', async () => {
    const { login } = await setup()
    const shared = await createSharedProject(db())
    const row = await createItem(db(), { projectId: shared.id, title: 'Shared stale' })
    await setItem(row.id, sql`lifecycle = 'stale', stale_since = ${ago(10)}`)
    const out = await login('out@example.com')
    const body = await json<Page>(await out.get('/api/v1/projects/_shared/review/stale'))
    expect(body.items.map((i) => i.handle)).toEqual([`m${row.number}`])
  })
})

describe('GET /api/v1/projects/:slug/review/:section', () => {
  it('stale: oldest first, with days_to_archive and the used-since-stale badge (D9)', async () => {
    const { p, login } = await setup()
    const older = await createItem(db(), { projectId: p.id, title: 'Older' })
    await setItem(older.id, sql`lifecycle = 'stale', stale_since = ${ago(80.5)}`)
    const used = await createItem(db(), { projectId: p.id, title: 'Used' })
    await setItem(used.id, sql`lifecycle = 'stale', stale_since = ${ago(85.5)}, last_used_at = ${ago(10.5)}`)
    const ed = await login('ed@example.com')
    const body = await json<Page>(await ed.get('/api/v1/projects/acme/review/stale'))
    expect(body.items.map((i) => i.title)).toEqual(['Used', 'Older'])
    expect(body.items[0]).toMatchObject({
      handle: `m${used.number}`,
      project: 'acme',
      lifecycle: 'stale',
      used_since_stale: true,
      days_to_archive: 20, // last use + 30 days, not stale_since + 90
    })
    expect(body.items[1]).toMatchObject({ used_since_stale: false, days_to_archive: 10 })
    expect(body.next_cursor).toBeNull()
    expect(body.items[0]).not.toHaveProperty('body')
  })

  it('paginates with a stable cursor', async () => {
    const { p, login } = await setup()
    for (let i = 0; i < 5; i++) {
      const it = await createItem(db(), { projectId: p.id, title: `S${i}` })
      await setItem(it.id, sql`lifecycle = 'stale', stale_since = ${ago(10 - i)}`)
    }
    const vi = await login('vi@example.com')
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const q: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2'
      const page: Page = await json<Page>(await vi.get(`/api/v1/projects/acme/review/stale${q}`))
      seen.push(...page.items.map((i) => String(i.title)))
      cursor = page.next_cursor
    } while (cursor)
    expect(seen).toEqual(['S0', 'S1', 'S2', 'S3', 'S4'])
    expect((await vi.get('/api/v1/projects/acme/review/stale?cursor=bogus')).status).toBe(400)
  })

  it('archived: only the last 30 days, newest first, with the reason', async () => {
    const { p, login } = await setup()
    const a = await createItem(db(), { projectId: p.id, title: 'A' })
    await setItem(a.id, sql`lifecycle = 'archived', archived_at = ${ago(2)}, archive_reason = 'expired'`)
    const b = await createItem(db(), { projectId: p.id, title: 'B' })
    await setItem(b.id, sql`lifecycle = 'archived', archived_at = ${ago(1)}, archive_reason = 'stale'`)
    const c = await createItem(db(), { projectId: p.id, title: 'C' })
    await setItem(c.id, sql`lifecycle = 'archived', archived_at = ${ago(40)}, archive_reason = 'manual'`)
    const vi = await login('vi@example.com')
    const body = await json<Page>(await vi.get('/api/v1/projects/acme/review/archived'))
    expect(body.items.map((i) => [i.title, i.archive_reason])).toEqual([
      ['B', 'stale'],
      ['A', 'expired'],
    ])
  })

  it('expiring: active observations within 48 h, soonest first, with expires_in_s', async () => {
    const { p, login } = await setup()
    const soon = await createItem(db(), { projectId: p.id, type: 'observation', title: 'soon' })
    await setItem(soon.id, sql`expires_at = now() + interval '2 hours'`)
    const later = await createItem(db(), { projectId: p.id, type: 'observation', title: 'later' })
    await setItem(later.id, sql`expires_at = now() + interval '30 hours'`)
    await createItem(db(), { projectId: p.id, type: 'observation', title: 'week' })
    const vi = await login('vi@example.com')
    const body = await json<Page<{ title: string; expires_in_s: number }>>(
      await vi.get('/api/v1/projects/acme/review/expiring'),
    )
    expect(body.items.map((i) => i.title)).toEqual(['soon', 'later'])
    expect(body.items[0]?.expires_in_s).toBeGreaterThan(7100)
    expect(body.items[0]?.expires_in_s).toBeLessThanOrEqual(7200)
  })

  it('conflicts: live edges only, both ends as summaries; a shared end has the S: handle', async () => {
    const { p, login } = await setup()
    const shared = await createSharedProject(db())
    const a = await createItem(db(), { projectId: p.id, title: 'A' })
    const b = await createItem(db(), { projectId: p.id, title: 'B' })
    const s = await createItem(db(), { projectId: shared.id, title: 'S' })
    const dead = await createItem(db(), { projectId: p.id, title: 'Dead' })
    await setItem(dead.id, sql`lifecycle = 'archived', archived_at = now(), archive_reason = 'manual'`)
    await db()
      .insert(edges)
      .values([
        { projectId: p.id, srcId: a.id, kind: 'conflicts_with', dstRef: `m${b.number}`, dstId: b.id },
        { projectId: p.id, srcId: a.id, kind: 'conflicts_with', dstRef: `s-${s.number}`, dstId: s.id },
        { projectId: p.id, srcId: b.id, kind: 'conflicts_with', dstRef: `m${dead.number}`, dstId: dead.id },
        { projectId: p.id, srcId: b.id, kind: 'supports', dstRef: `m${a.number}`, dstId: a.id },
      ])
    const vi = await login('vi@example.com')
    const body = await json<
      Page<{ edge_id: string; a: { title: string }; b: { title: string; handle: string } }>
    >(await vi.get('/api/v1/projects/acme/review/conflicts'))
    expect(body.items).toHaveLength(2)
    const pairs = body.items.map((i) => `${i.a.title}-${i.b.title}`).sort()
    expect(pairs).toEqual(['A-B', 'A-S'])
    expect(body.items.find((i) => i.b.title === 'S')?.b.handle).toBe(`S:m${s.number}`)
  })

  it('push_conflicts: newest first, with who edited it in Spoor', async () => {
    const { p, login } = await setup()
    const adr = await createItem(db(), {
      projectId: p.id,
      space: 'decisions',
      status: 'accepted',
      title: 'Use PG',
    })
    await setItem(
      adr.id,
      sql`push_conflict_at = now(), source_path = 'docs/adr/0001-use-pg.md', updated_by_label = 'ann@example.com', client_name = 'web'`,
    )
    const vi = await login('vi@example.com')
    const body = await json<Page>(await vi.get('/api/v1/projects/acme/review/push_conflicts'))
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({
      handle: `ADR-${String(adr.adrNumber).padStart(4, '0')}`,
      source_path: 'docs/adr/0001-use-pg.md',
      edited_by: { label: 'ann@example.com', via: 'web', client_name: 'web' },
    })
  })

  it('an unknown section is 404', async () => {
    const { login } = await setup()
    const vi = await login('vi@example.com')
    expect((await vi.get('/api/v1/projects/acme/review/nope')).status).toBe(404)
  })
})

describe('job status and run now', () => {
  it('GET /api/v1/jobs: instance admins only; every job with cadence, lease state and recent runs', async () => {
    const { scheduler, login } = await setup()
    await scheduler.seed()
    await scheduler.runNow('purge-ephemeral')
    await scheduler.idle()
    const ia = await login('admin@example.com')
    const res = await ia.get('/api/v1/jobs')
    expect(res.status).toBe(200)
    const body = await json<{
      scheduler: { enabled: boolean }
      jobs: { name: string; every_s: number; last_status: string | null; locked_until: string | null }[]
      recent: { name: string; status: string }[]
    }>(res)
    expect(body.scheduler.enabled).toBe(true)
    expect(body.jobs.map((j) => j.name)).toEqual(['cleanup', 'embed-pending', 'purge-ephemeral', 'reembed'])
    expect(body.jobs.find((j) => j.name === 'cleanup')).toMatchObject({ every_s: 3600, locked_until: null })
    expect(body.jobs.find((j) => j.name === 'purge-ephemeral')).toMatchObject({ last_status: 'ok' })
    expect(body.recent).toMatchObject([{ name: 'purge-ephemeral', status: 'ok' }])
    const ed = await login('ed@example.com')
    expect((await ed.get('/api/v1/jobs')).status).toBe(403)
  })

  it('POST /api/v1/jobs/:name/run: 202 and an audit row; 200 started:false while it runs; 404 unknown', async () => {
    const { scheduler, login } = await setup()
    const ia = await login('admin@example.com')
    const res = await ia.post('/api/v1/jobs/cleanup/run')
    expect(res.status).toBe(202)
    expect(await json(res)).toEqual({ name: 'cleanup', started: true })
    await scheduler.idle()
    const [row] = await db().select().from(auditLog).where(sql`${auditLog.action} = 'job.run'`)
    expect(row).toMatchObject({
      projectId: null,
      actorLabel: 'admin@example.com',
      via: 'web',
      data: { name: 'cleanup', started: true },
    })
    expect((await ia.post('/api/v1/jobs/nope/run')).status).toBe(404)
    const ed = await login('ed@example.com')
    expect((await ed.post('/api/v1/jobs/cleanup/run')).status).toBe(403)
  })

  it('with SPOOR_JOBS=off run now does nothing and says so', async () => {
    const { app } = buildApp({ SPOOR_JOBS: 'off' })
    await createAdmin(db(), { email: 'root@example.com' })
    const ia = await loginAs(app, 'root@example.com', DEFAULT_PASSWORD)
    const res = await ia.post('/api/v1/jobs/cleanup/run')
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ name: 'cleanup', started: false, reason: 'disabled' })
  })

  it('GET /api/v1/projects/:slug/jobs: project admins; re-embed progress and the project runs', async () => {
    const { p, admin, login } = await setup()
    await createItem(db(), { projectId: p.id })
    await db().execute(sql`UPDATE projects SET embedding_target = 'openai:x/8' WHERE id = ${p.id}`)
    await db().execute(sql`INSERT INTO job_runs (name, project_id, finished_at, status, stats) VALUES
      ('cleanup', ${p.id}, now(), 'ok', '{"staled":2}'), ('purge-ephemeral', ${p.id}, now(), 'ok', '{}')`)
    const pa = await createUser(db(), { email: 'pa@example.com' })
    await addMember(db(), p.id, pa.id, 'admin')
    const c = await login('pa@example.com')
    const res = await c.get('/api/v1/projects/acme/jobs')
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({
      embedding: { target: 'openai:x/8', remaining: 1, providers_enabled: ['local'] },
      runs: [{ name: 'cleanup', status: 'ok', stats: { staled: 2 } }],
    })
    const ed = await login('ed@example.com')
    expect((await ed.get('/api/v1/projects/acme/jobs')).status).toBe(403)
    expect(admin.isAdmin).toBe(true)
  })
})

describe('GET /p/:slug/api/decisions/undrafted', () => {
  const bearer = (app: Hono<AppEnv>, path: string, token: string) =>
    app.request(`http://localhost:3000${path}`, { headers: { authorization: `Bearer ${token}` } })

  it("lists the owner's decision memories of the last 14 days that no live ADR was drafted from", async () => {
    const { app, p, editor, viewer } = await setup()
    const token = await createToken(db(), { projectId: p.id, userId: editor.id })
    const mk = (title: string, opts: { by?: string; type?: 'decision' | 'fact' } = {}) =>
      createItem(db(), {
        projectId: p.id,
        type: opts.type ?? 'decision',
        title,
        createdBy: opts.by ?? editor.id,
      })
    const open = await mk('Open decision')
    const drafted = await mk('Drafted')
    const redraft = await mk('ADR superseded, draft again')
    const old = await mk('Too old')
    await setItem(old.id, sql`created_at = ${ago(15)}`)
    await mk('A fact', { type: 'fact' })
    await mk('Someone else', { by: viewer.id })
    const adr = await createItem(db(), { projectId: p.id, space: 'decisions', status: 'accepted' })
    const deadAdr = await createItem(db(), { projectId: p.id, space: 'decisions', status: 'superseded' })
    await db()
      .insert(edges)
      .values([
        {
          projectId: p.id,
          srcId: adr.id,
          kind: 'drafted_from',
          dstRef: `m${drafted.number}`,
          dstId: drafted.id,
        },
        {
          projectId: p.id,
          srcId: deadAdr.id,
          kind: 'drafted_from',
          dstRef: `m${redraft.number}`,
          dstId: redraft.id,
        },
      ])
    const res = await bearer(app, '/p/acme/api/decisions/undrafted', token.secret)
    expect(res.status).toBe(200)
    const body = await json<{ items: { handle: string; spoor_id: string; title: string }[] }>(res)
    expect(body.items.map((i) => i.title)).toEqual(['Open decision', 'ADR superseded, draft again'])
    expect(body.items[0]).toMatchObject({ handle: `m${open.number}`, spoor_id: open.id })

    const all = await json<{ items: unknown[] }>(
      await bearer(app, '/p/acme/api/decisions/undrafted?mine=false', token.secret),
    )
    expect(all.items).toHaveLength(3)
    // `since` narrows but never reaches past the 14-day floor
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
    const floored = await json<{ items: unknown[] }>(
      await bearer(app, `/p/acme/api/decisions/undrafted?mine=false&since=${since}`, token.secret),
    )
    expect(floored.items).toHaveLength(3)
    const future = new Date(Date.now() + 60_000).toISOString()
    const none = await json<{ items: unknown[] }>(
      await bearer(app, `/p/acme/api/decisions/undrafted?since=${encodeURIComponent(future)}`, token.secret),
    )
    expect(none.items).toHaveLength(0)
  })

  it('a service token sees the items created through it (its item.create audit rows)', async () => {
    const { app, p } = await setup()
    const svc = await createToken(db(), { projectId: p.id, role: 'editor' })
    const mine = await createItem(db(), { projectId: p.id, type: 'decision', title: 'via CI' })
    await createItem(db(), { projectId: p.id, type: 'decision', title: 'by hand' })
    await db()
      .insert(auditLog)
      .values({
        projectId: p.id,
        actorLabel: `service:${svc.name}`,
        tokenId: svc.id,
        via: 'mcp',
        action: 'item.create',
        itemId: mine.id,
        itemHandle: `m${mine.number}`,
        summary: 'created',
      })
    const body = await json<{ items: { title: string }[] }>(
      await bearer(app, '/p/acme/api/decisions/undrafted', svc.secret),
    )
    expect(body.items.map((i) => i.title)).toEqual(['via CI'])
  })

  it('rejects a token of another project', async () => {
    const { app, editor } = await setup()
    const other = await createProject(db(), { slug: 'other' })
    await addMember(db(), other.id, editor.id, 'editor')
    const t = await createToken(db(), { projectId: other.id, userId: editor.id })
    expect((await bearer(app, '/p/acme/api/decisions/undrafted', t.secret)).status).toBe(403)
  })
})

describe('GET /api/v1/projects/:slug/decisions/undrafted (cookie twin, review queue)', () => {
  it('lists every member’s undrafted decisions by default, mine=true the caller’s; members only', async () => {
    const { p, editor, viewer, login } = await setup()
    await createItem(db(), {
      projectId: p.id,
      type: 'decision',
      title: 'Editor decision',
      createdBy: editor.id,
    })
    await createItem(db(), {
      projectId: p.id,
      type: 'decision',
      title: 'Viewer decision',
      createdBy: viewer.id,
    })
    await createItem(db(), { projectId: p.id, type: 'fact', title: 'A fact', createdBy: editor.id })
    const vi = await login('vi@example.com')
    const all = await vi.get('/api/v1/projects/acme/decisions/undrafted')
    expect(all.status).toBe(200)
    const body = await json<{ items: { title: string; handle: string; created_at: string }[] }>(all)
    expect(body.items.map((i) => i.title)).toEqual(['Editor decision', 'Viewer decision'])
    expect(body.items[0]?.handle).toMatch(/^m\d+$/)
    const mine = await json<{ items: { title: string }[] }>(
      await vi.get('/api/v1/projects/acme/decisions/undrafted?mine=true'),
    )
    expect(mine.items.map((i) => i.title)).toEqual(['Viewer decision'])
    expect((await vi.get('/api/v1/projects/acme/decisions/undrafted?bogus=1')).status).toBe(400)
    const out = await login('out@example.com')
    expect((await out.get('/api/v1/projects/acme/decisions/undrafted')).status).toBe(404)
  })
})
