// The project dashboard (api.md section 4.1, web-ui.md `/projects/:slug`): counts per space and lifecycle,
// the review counts and the last 15 content or lifecycle changes, through the assembled app.
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
import { auditLog, items } from '../../db/schema.js'

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
    expect((await ed.post(`${P}/items/${fact.id}/archive`)).status).toBe(200)
    await db().update(items).set({ lifecycle: 'stale', staleSince: sql`now()` }).where(eq(items.id, stale.id))

    const d = await dashboard(ed)
    expect(d.counts).toEqual({
      memories: { active: 1, stale: 1, archived: 1 },
      decisions: { active: 1, stale: 0, archived: 0 },
      docs: { active: 1, stale: 0, archived: 0 },
    })
    expect(d.review).toEqual({ stale: 1, archived: 1, expiring: 0, conflicts: 0, push_conflicts: 0 })
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
