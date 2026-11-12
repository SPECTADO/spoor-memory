// The project dashboard (api.md section 4.1, web-ui.md `/projects/:slug`): counts per space and lifecycle,
// the review counts, the last 15 content or lifecycle changes, the activity overview (`stats`) and the
// admin-only request rows (`activity`), through the assembled app.
import type { DashboardResponse } from '@spoor/shared'
import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import {
  addMember,
  createAdmin,
  createItem,
  createProject,
  createSharedProject,
  createUser,
  DEFAULT_PASSWORD,
} from '../../../test/factories.js'
import { type Client, json, loginAs, testApp } from '../../../test/http.js'
import { auditLog, edges, items, jobLocks, requestLog } from '../../db/schema.js'

const db = () => testDb()
const P = '/api/v1/projects/acme'

async function seed() {
  const { app } = testApp()
  const shared = await createSharedProject(db())
  const acme = await createProject(db(), { slug: 'acme' })
  const editor = await createUser(db())
  const viewer = await createUser(db())
  const outsider = await createUser(db())
  const admin = await createAdmin(db())
  await addMember(db(), acme.id, editor.id, 'editor')
  await addMember(db(), acme.id, viewer.id, 'viewer')
  const login = (u: { email: string }) => loginAs(app, u.email, DEFAULT_PASSWORD)
  return { app, shared, acme, editor, viewer, outsider, admin, login }
}

let s: Awaited<ReturnType<typeof seed>>
let ed: Client
beforeEach(async () => {
  s = await seed()
  ed = await s.login(s.editor)
})

type Created = { item: { id: string; handle: string; revision: number } }
const create = async (space: string, body: Record<string, unknown>) => {
  const r = await ed.post(`${P}/spaces/${space}/items`, body)
  if (r.status !== 201) throw new Error(`create failed ${r.status} ${await r.text()}`)
  return (await json<Created>(r)).item
}
const dashboard = async (c: Client, path = P) => {
  const r = await c.get(`${path}/dashboard`)
  expect(r.status).toBe(200)
  return json<DashboardResponse>(r)
}

describe('GET /api/v1/projects/:slug/dashboard', () => {
  it('counts items per space and lifecycle and carries the review counts', async () => {
    const fact = await create('memories', { title: 'Sessions live in Postgres', type: 'fact' })
    await create('memories', { title: 'Deploy with compose', type: 'procedure' })
    const stale = await create('memories', { title: 'Old claim', type: 'fact' })
    await create('decisions', { title: 'Use Postgres' })
    await create('docs', { title: 'Architecture' })
    const lib = await createItem(db(), { projectId: s.acme.id, space: 'library' })
    const libArchived = await createItem(db(), { projectId: s.acme.id, space: 'library' })
    await db()
      .update(items)
      .set({ lifecycle: 'archived', archivedAt: sql`now()`, archiveReason: 'manual' })
      .where(eq(items.id, libArchived.id))
    expect(lib.id).toBeTruthy()
    expect((await ed.post(`${P}/items/${fact.id}/archive`)).status).toBe(200)
    await db().update(items).set({ lifecycle: 'stale', staleSince: sql`now()` }).where(eq(items.id, stale.id))

    const d = await dashboard(ed)
    expect(d.counts).toEqual({
      memories: { active: 1, stale: 1, archived: 1 },
      decisions: { active: 1, stale: 0, archived: 0 },
      docs: { active: 1, stale: 0, archived: 0 },
      library: { active: 1, stale: 0, archived: 1 },
    })
    expect(d.review).toEqual({
      stale: 1,
      archived: 1,
      expiring: 0,
      conflicts: 0,
      duplicates: 0,
      push_conflicts: 0,
    })
    // the same numbers as GET …/review
    expect(d.review).toEqual((await json<{ counts: unknown }>(await ed.get(`${P}/review`))).counts)
  })

  it('recent: content and lifecycle changes, newest first, with actor and the item as it is now', async () => {
    const a = await create('memories', { title: 'First', type: 'fact' })
    const b = await create('docs', { title: 'Runbook' })
    const patched = await ed.patch(`${P}/items/${a.id}`, { revision: 1, body: 'more detail' })
    expect(patched.status).toBe(200)
    // verify and pin are operational, not listed
    expect((await ed.post(`${P}/items/${b.id}/verify`)).status).toBe(200)
    expect((await ed.post(`${P}/items/${b.id}/pin`)).status).toBe(200)
    expect((await ed.post(`${P}/items/${b.id}/archive`)).status).toBe(200)
    expect((await ed.post(`${P}/items/${b.id}/restore`)).status).toBe(200)
    // a cleanup transition is written by the system
    await db().insert(auditLog).values({
      projectId: s.acme.id,
      actorLabel: 'system',
      via: 'system',
      action: 'item.stale',
      itemId: a.id,
      itemHandle: a.handle,
      summary: 'stale',
    })

    const d = await dashboard(ed)
    expect(d.recent.map((r) => [r.change, r.item.handle])).toEqual([
      ['stale', a.handle],
      ['restore', b.handle],
      ['archive', b.handle],
      ['update', a.handle],
      ['create', b.handle],
      ['create', a.handle],
    ])
    const [stale, , , update] = d.recent
    expect(stale?.actor).toEqual({ user_id: null, label: 'system', via: 'system', client_name: null })
    expect(update?.actor).toMatchObject({ user_id: s.editor.id, label: s.editor.email, via: 'web' })
    // the item is the current row: revision 2 even on the create entry
    expect(d.recent.find((r) => r.change === 'create' && r.item.id === a.id)?.item.revision).toBe(2)
    for (const r of d.recent) expect(Date.parse(r.at)).not.toBeNaN()
  })

  it('recent: at most 15 rows; deleted items and other projects are left out', async () => {
    const other = await createProject(db(), { slug: 'other' })
    await addMember(db(), other.id, s.editor.id, 'editor')
    expect(
      (await ed.post('/api/v1/projects/other/spaces/memories/items', { title: 'Elsewhere', type: 'fact' }))
        .status,
    ).toBe(201)
    const created = []
    for (let i = 0; i < 17; i++)
      created.push(await create('memories', { title: `Fact number ${i}`, type: 'fact' }))
    let d = await dashboard(ed)
    expect(d.recent).toHaveLength(15)
    expect(d.recent[0]?.item.title).toBe('Fact number 16')
    expect(d.recent.every((r) => r.item.project === 'acme')).toBe(true)

    const pa = await createUser(db())
    await addMember(db(), s.acme.id, pa.id, 'admin')
    const admin = await s.login(pa)
    const last = created[16] as { id: string; handle: string }
    expect((await admin.delete(`${P}/items/${last.id}?confirm=${last.handle}`)).status).toBe(204)
    d = await dashboard(ed)
    expect(d.recent).toHaveLength(15)
    expect(d.recent.map((r) => r.item.id)).not.toContain(last.id)
    expect(d.recent[0]?.item.title).toBe('Fact number 15')
  })

  it('links: live items without any edge, distinct dangling refs of live items', async () => {
    const a = await create('memories', { title: 'Alpha', type: 'fact' })
    const b = await create('memories', { title: 'Beta', type: 'fact' })
    await create('memories', { title: 'Lonely', type: 'fact' })
    // a dangling wikilink counts as a link; two refs, one of them twice
    await create('docs', { title: 'Doc one', body: '[[nowhere]] and [[gone]]' })
    await create('docs', { title: 'Doc two', body: '[[nowhere]]' })
    const archived = await create('memories', { title: 'Archived lonely', type: 'fact' })
    await ed.post(`${P}/items/${archived.id}/archive`)
    const sup = await createItem(db(), { projectId: s.acme.id, status: 'superseded', body: '' })
    await db()
      .insert(edges)
      .values({ projectId: s.acme.id, srcId: sup.id, kind: 'wikilink', dstRef: 'ignored', dstId: null })
    expect((await dashboard(ed)).links).toEqual({ unlinked_items: 3, dangling_refs: 2 })
    // a typed edge links both ends
    expect((await ed.post(`${P}/items/${a.id}/edges`, { kind: 'refines', to: b.id })).status).toBe(201)
    expect((await dashboard(ed)).links).toEqual({ unlinked_items: 1, dangling_refs: 2 })
    // _shared: an incoming edge from a project counts
    const sh = await createItem(db(), { projectId: s.shared.id })
    await createItem(db(), { projectId: s.shared.id })
    await db()
      .insert(edges)
      .values({ projectId: s.acme.id, srcId: a.id, kind: 'supports', dstRef: 'x', dstId: sh.id })
    expect((await dashboard(ed, '/api/v1/projects/_shared')).links).toEqual({
      unlinked_items: 1,
      dangling_refs: 0,
    })
  })

  it('members only: viewers read it, outsiders get 404, no session is 401; _shared is readable by everyone', async () => {
    await createItem(db(), { projectId: s.shared.id, title: 'Shared fact' })
    expect((await dashboard(await s.login(s.viewer))).counts.memories.active).toBe(0)
    const out = await s.login(s.outsider)
    expect((await out.get(`${P}/dashboard`)).status).toBe(404)
    const anon = await s.app.request(`${P}/dashboard`)
    expect(anon.status).toBe(401)
    const sh = await dashboard(out, '/api/v1/projects/_shared')
    expect(sh.counts.memories).toEqual({ active: 1, stale: 0, archived: 0 })
    expect((await (await s.login(s.admin)).get(`${P}/dashboard`)).status).toBe(200)
  })
})

const DAY = 86_400_000
const utcMidnight = (daysAgo: number) => Math.floor(Date.now() / DAY) * DAY - daysAgo * DAY
const isoDay = (daysAgo: number) => new Date(utcMidnight(daysAgo)).toISOString().slice(0, 10)
/** A time inside the UTC day `daysAgo` days back (today: one second ago). */
const inDay = (daysAgo: number) =>
  new Date(daysAgo === 0 ? Date.now() - 1000 : utcMidnight(daysAgo) + 3_600_000)

type ReqRow = {
  daysAgo: number
  kind?: 'read' | 'write'
  token?: string | null
  client?: string | null
  user?: string | null
  label?: string
  projectId?: string
  operation?: string
  outcome?: string
}
async function seedRequests(projectId: string, rows: ReqRow[]) {
  await db()
    .insert(requestLog)
    .values(
      rows.map((r) => ({
        at: inDay(r.daysAgo),
        projectId: r.projectId ?? projectId,
        kind: r.kind ?? 'read',
        surface: 'mcp' as const,
        operation: r.operation ?? (r.kind === 'write' ? 'spoor_remember' : 'spoor_search'),
        actorUserId: r.user ?? null,
        actorLabel: r.label ?? 'dev@example.com',
        tokenId: r.token ?? null,
        tokenName: r.token ? 'laptop' : null,
        clientName: r.client ?? null,
        query: 'secret query text',
        handles: ['m1'],
        outcome: r.outcome ?? 'ok',
        durationMs: 3,
      })),
    )
}
async function seedChange(
  projectId: string,
  daysAgo: number,
  o: { itemId?: string; user?: string | null; via?: 'web' | 'system'; action?: string } = {},
) {
  await db()
    .insert(auditLog)
    .values({
      at: inDay(daysAgo),
      projectId,
      actorUserId: o.user ?? null,
      actorLabel: o.via === 'system' ? 'system' : 'someone@example.com',
      via: o.via ?? 'web',
      action: o.action ?? 'item.update',
      itemId: o.itemId ?? null,
      itemHandle: 'm1',
      summary: 'changed',
    })
}

describe('dashboard stats', () => {
  it('counts requests and item changes per UTC day and the totals', async () => {
    const t1 = '00000000-0000-4000-8000-000000000001'
    const t2 = '00000000-0000-4000-8000-000000000002'
    const u1 = s.editor.id
    const u2 = s.viewer.id
    await seedRequests(s.acme.id, [
      { daysAgo: 0, kind: 'read', token: t1, client: 'claude-code/2.1', user: u1 },
      { daysAgo: 0, kind: 'write', token: t1, client: 'claude-code/2.1', user: u1 },
      { daysAgo: 3, kind: 'read', token: t1, client: 'codex/1.0', user: u1 },
      { daysAgo: 8, kind: 'read', token: t2, client: 'claude-code/2.1', user: u2 },
      // outside the window and in another project: not counted
      { daysAgo: 20, kind: 'read', token: t2, user: u2 },
    ])
    const other = await createProject(db(), { slug: 'other' })
    await seedRequests(other.id, [{ daysAgo: 0, token: t2, user: u2 }])

    const a = await createItem(db(), { projectId: s.acme.id })
    const b = await createItem(db(), { projectId: s.acme.id })
    const outsider = s.outsider.id
    await seedChange(s.acme.id, 0, { itemId: a.id, user: u1 })
    await seedChange(s.acme.id, 1, { itemId: a.id, user: u1 })
    await seedChange(s.acme.id, 6, { itemId: b.id, via: 'system', action: 'item.stale' })
    await seedChange(s.acme.id, 10, { itemId: b.id, user: outsider })
    // not an item change (verify is operational) and outside the window: not counted
    await seedChange(s.acme.id, 0, { itemId: a.id, user: u1, action: 'item.verify' })
    await seedChange(s.acme.id, 30, { itemId: a.id, user: u2 })
    await seedChange(other.id, 0, { user: u2 })

    const lastRun = new Date(Date.now() - 600_000)
    await db()
      .insert(jobLocks)
      .values({ name: 'cleanup', lastRunAt: lastRun, lastStatus: 'ok' })
      .onConflictDoUpdate({ target: jobLocks.name, set: { lastRunAt: lastRun } })

    const st = (await dashboard(await s.login(s.viewer))).stats
    if (!st) throw new Error('no stats')
    expect(st.window).toEqual({ days: 14, from: isoDay(13), to: isoDay(0) })
    expect(st.per_day.map((d) => d.day)).toEqual(Array.from({ length: 14 }, (_, i) => isoDay(13 - i)))
    const day = (n: number) => st.per_day.find((d) => d.day === isoDay(n))
    expect(day(0)).toEqual({ day: isoDay(0), reads: 1, writes: 1, changes: 1 })
    expect(day(1)).toMatchObject({ reads: 0, writes: 0, changes: 1 })
    expect(day(3)).toMatchObject({ reads: 1, writes: 0, changes: 0 })
    expect(day(6)).toMatchObject({ changes: 1 })
    expect(day(8)).toMatchObject({ reads: 1, changes: 0 })
    expect(day(10)).toMatchObject({ changes: 1 })
    expect(st.requests).toEqual({ today: 2, last_7_days: 3, agents_14_days: 3 })
    // u1 and u2 (requests) and the outsider (a web change); the system is not a person
    expect(st.people_14_days).toBe(3)
    // a (today, yesterday) and b (stale 6 days ago); b's change 10 days ago is outside the 7 days
    expect(st.items_changed_7_days).toBe(2)
    expect(st.last_cleanup_at).toBe(lastRun.toISOString())
  })

  it('is all zeros for a new project, and leaves out the request parts on _shared', async () => {
    await db().delete(jobLocks)
    const st = (await dashboard(ed)).stats
    expect(st?.per_day).toHaveLength(14)
    expect(st?.per_day.every((d) => d.reads + d.writes + d.changes === 0)).toBe(true)
    expect(st?.requests).toEqual({ today: 0, last_7_days: 0, agents_14_days: 0 })
    expect(st?.people_14_days).toBe(0)
    expect(st?.items_changed_7_days).toBe(0)
    expect(st?.last_cleanup_at).toBeNull()

    const item = await createItem(db(), { projectId: s.shared.id })
    await seedChange(s.shared.id, 2, { itemId: item.id, user: s.admin.id })
    const sh = (await dashboard(ed, '/api/v1/projects/_shared')).stats
    expect(sh?.requests).toBeNull()
    expect(sh?.per_day.find((d) => d.day === isoDay(2))).toMatchObject({ reads: 0, writes: 0, changes: 1 })
    expect(sh?.people_14_days).toBe(1)
    expect(sh?.items_changed_7_days).toBe(1)
  })
})

describe('dashboard activity (ADR-0018)', () => {
  it('gives project and instance admins the newest 8 requests, without query or handles', async () => {
    const rows: ReqRow[] = Array.from({ length: 10 }, (_, i) => ({
      daysAgo: 0,
      kind: i % 2 ? 'write' : 'read',
      token: '00000000-0000-4000-8000-000000000001',
      client: 'claude-code/2.1',
      operation: `op_${i}`,
      outcome: i === 9 ? 'conflict' : 'ok',
    }))
    for (const r of rows) await seedRequests(s.acme.id, [r]) // ids in order
    const pa = await createUser(db())
    await addMember(db(), s.acme.id, pa.id, 'admin')
    for (const c of [await s.login(pa), await s.login(s.admin)]) {
      const act = (await dashboard(c)).activity
      expect(act).toHaveLength(8)
      expect(act?.map((r) => r.operation)).toEqual([
        'op_9',
        'op_8',
        'op_7',
        'op_6',
        'op_5',
        'op_4',
        'op_3',
        'op_2',
      ])
      expect(act?.[0]).toEqual({
        id: expect.any(Number),
        at: expect.any(String),
        kind: 'write',
        surface: 'mcp',
        operation: 'op_9',
        actor: { label: 'dev@example.com', client_name: 'claude-code/2.1', token_name: 'laptop' },
        outcome: 'conflict',
      })
      expect(JSON.stringify(act)).not.toContain('secret query text')
    }
  })

  it('leaves the field out for editors and viewers, and on _shared', async () => {
    await seedRequests(s.acme.id, [{ daysAgo: 0 }])
    for (const c of [ed, await s.login(s.viewer)]) {
      const d = await dashboard(c)
      expect(d).not.toHaveProperty('activity')
      // members still see the last read and write
      expect(d.last_requests.read).not.toBeNull()
    }
    expect(await dashboard(await s.login(s.admin), '/api/v1/projects/_shared')).not.toHaveProperty('activity')
  })
})
