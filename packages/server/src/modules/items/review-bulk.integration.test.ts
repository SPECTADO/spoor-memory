// The review queue's bulk action (api.md section 8, cleanup-and-jobs.md section 6): verify or archive up to
// 100 refs, one transaction and one audit row per item, skipped refs reported instead of failing.
import type { ReviewBulkResponse } from '@spoor/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import {
  addMember,
  createItem,
  createProject,
  createSharedProject,
  createUser,
  DEFAULT_PASSWORD,
} from '../../../test/factories.js'
import { type Client, json, loginAs, TEST_ORIGIN, testApp } from '../../../test/http.js'
import { auditLog, items } from '../../db/schema.js'

const db = () => testDb()
const P = '/api/v1/projects/acme'
const SH = '/api/v1/projects/_shared'

async function seed() {
  const { app } = testApp()
  const shared = await createSharedProject(db())
  const acme = await createProject(db(), { slug: 'acme' })
  const editor = await createUser(db())
  const viewer = await createUser(db())
  const outsider = await createUser(db())
  const se = await createUser(db(), { sharedEditor: true })
  await addMember(db(), acme.id, editor.id, 'editor')
  await addMember(db(), acme.id, viewer.id, 'viewer')
  const login = (u: { email: string }) => loginAs(app, u.email, DEFAULT_PASSWORD)
  return { app, shared, acme, editor, viewer, outsider, se, login }
}

let s: Awaited<ReturnType<typeof seed>>
let ed: Client
beforeEach(async () => {
  s = await seed()
  ed = await s.login(s.editor)
})

const handle = (i: { number: number }) => `m${i.number}`
const row = async (id: string) => (await db().select().from(items).where(eq(items.id, id)))[0]
const setStale = (id: string) =>
  db()
    .update(items)
    .set({ lifecycle: 'stale', staleSince: sql`now()`, lastVerifiedAt: sql`now() - interval '90 days'` })
    .where(eq(items.id, id))
const setArchived = (id: string) =>
  db()
    .update(items)
    .set({ lifecycle: 'archived', archivedAt: sql`now()`, archiveReason: 'stale' })
    .where(eq(items.id, id))
const bulk = async (c: Client, body: unknown, base = P) => {
  const r = await c.post(`${base}/review/bulk`, body)
  expect(r.status, await r.clone().text()).toBe(200)
  return json<ReviewBulkResponse>(r)
}
const auditOf = (action: string, ids: string[]) =>
  db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), inArray(auditLog.itemId, ids)))

describe('POST /api/v1/projects/:slug/review/bulk', () => {
  it('verify: stale items return to active, archived ones and bad refs are skipped with a reason', async () => {
    const a = await createItem(db(), { projectId: s.acme.id })
    const b = await createItem(db(), { projectId: s.acme.id })
    const archived = await createItem(db(), { projectId: s.acme.id })
    await createItem(db(), { projectId: s.shared.id })
    await setStale(a.id)
    await setStale(b.id)
    await setArchived(archived.id)

    const res = await bulk(ed, {
      action: 'verify',
      refs: [handle(a), b.id, handle(archived), 'm999', 'S:m1'],
    })
    expect(res.done).toEqual([handle(a), handle(b)])
    expect(res.skipped).toEqual([
      { handle: handle(archived), reason: 'archived' },
      { handle: 'm999', reason: 'not_found' },
      { handle: 'S:m1', reason: 'read_only_space' },
    ])
    for (const id of [a.id, b.id]) {
      expect(await row(id)).toMatchObject({ lifecycle: 'active', staleSince: null, provenance: 'human' })
    }
    expect((await row(archived.id))?.lifecycle).toBe('archived')
    const audit = await auditOf('item.verify', [a.id, b.id, archived.id])
    expect(audit).toHaveLength(2)
    expect(audit.every((r) => r.via === 'web' && r.actorUserId === s.editor.id)).toBe(true)
  })

  it('archive: manual reason, one audit row each; already archived items are skipped', async () => {
    const a = await createItem(db(), { projectId: s.acme.id })
    const d = await createItem(db(), { projectId: s.acme.id, space: 'docs' })
    const done = await createItem(db(), { projectId: s.acme.id })
    await setArchived(done.id)
    const res = await bulk(ed, { action: 'archive', refs: [a.id, d.id, done.id] })
    expect(res.done).toHaveLength(2)
    expect(res.done[0]).toBe(handle(a))
    expect(res.skipped).toEqual([{ handle: handle(done), reason: 'already_archived' }])
    expect(await row(a.id)).toMatchObject({ lifecycle: 'archived', archiveReason: 'manual' })
    expect((await row(done.id))?.archiveReason).toBe('stale')
    expect(await auditOf('item.archive', [a.id, d.id, done.id])).toHaveLength(2)
    // archiving again is a no-op with a reason, no new audit row
    const again = await bulk(ed, { action: 'archive', refs: [a.id] })
    expect(again).toEqual({ done: [], skipped: [{ handle: handle(a), reason: 'already_archived' }] })
    expect(await auditOf('item.archive', [a.id])).toHaveLength(1)
  })

  it('validates the body: action, 1 to 100 refs, no unknown fields', async () => {
    const one = await createItem(db(), { projectId: s.acme.id })
    for (const body of [
      {},
      { action: 'delete', refs: [one.id] },
      { action: 'verify', refs: [] },
      { action: 'verify', refs: Array.from({ length: 101 }, (_, i) => `m${i + 1}`) },
      { action: 'verify', refs: [one.id], note: 'x' },
    ]) {
      const r = await ed.post(`${P}/review/bulk`, body)
      expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(400)
      expect((await json<{ error: string }>(r)).error).toBe('invalid_input')
    }
    expect(
      (await bulk(ed, { action: 'verify', refs: Array.from({ length: 100 }, () => one.id) })).done,
    ).toHaveLength(100)
  })

  it('editors only: viewers 403, outsiders 404, no session 401; _shared needs a shared editor', async () => {
    const one = await createItem(db(), { projectId: s.acme.id })
    const body = { action: 'verify', refs: [one.id] }
    expect((await (await s.login(s.viewer)).post(`${P}/review/bulk`, body)).status).toBe(403)
    expect((await (await s.login(s.outsider)).post(`${P}/review/bulk`, body)).status).toBe(404)
    const anon = await s.app.request(`${P}/review/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: TEST_ORIGIN },
      body: JSON.stringify(body),
    })
    expect(anon.status).toBe(401)

    const sh = await createItem(db(), { projectId: s.shared.id })
    await setStale(sh.id)
    expect((await ed.post(`${SH}/review/bulk`, { action: 'verify', refs: ['m1'] })).status).toBe(403)
    const res = await bulk(await s.login(s.se), { action: 'verify', refs: [handle(sh)] }, SH)
    expect(res).toEqual({ done: [handle(sh)], skipped: [] })
    expect((await row(sh.id))?.lifecycle).toBe('active')
  })
})

describe('library pages in the review queue (ADR-0014)', () => {
  it('bulk refs to a library page are skipped: read_only_space without the right, wrong_space with it', async () => {
    const page = await createItem(db(), { projectId: s.acme.id, space: 'library' }) // L1
    const mem = await createItem(db(), { projectId: s.acme.id })
    await setStale(mem.id)
    expect(await bulk(ed, { action: 'verify', refs: ['L1', handle(mem)] })).toEqual({
      done: [handle(mem)],
      skipped: [{ handle: 'L1', reason: 'read_only_space' }],
    })
    expect(await bulk(ed, { action: 'archive', refs: ['L1'] })).toEqual({
      done: [],
      skipped: [{ handle: 'L1', reason: 'read_only_space' }],
    })
    const pa = await createUser(db())
    await addMember(db(), s.acme.id, pa.id, 'admin')
    const admin = await s.login(pa)
    expect(await bulk(admin, { action: 'verify', refs: ['L1'] })).toEqual({
      done: [],
      skipped: [{ handle: 'L1', reason: 'wrong_space' }],
    })
    expect((await row(page.id))?.lifecycle).toBe('active')
    expect(await bulk(admin, { action: 'archive', refs: ['L1'] })).toEqual({ done: ['L1'], skipped: [] })
    expect((await row(page.id))?.lifecycle).toBe('archived')
  })

  it('a viewer with the library flag is refused by the route', async () => {
    const lv = await createUser(db())
    await addMember(db(), s.acme.id, lv.id, 'viewer', { libraryEditor: true })
    await createItem(db(), { projectId: s.acme.id, space: 'library' })
    const r = await (await s.login(lv)).post(`${P}/review/bulk`, { action: 'archive', refs: ['L1'] })
    expect(r.status).toBe(403)
    expect((await json<{ error: string }>(r)).error).toBe('forbidden')
  })

  it('an archived library page is in no review list and no count', async () => {
    const page = await createItem(db(), { projectId: s.acme.id, space: 'library' })
    await setArchived(page.id)
    const mem = await createItem(db(), { projectId: s.acme.id })
    await setArchived(mem.id)
    const counts = await json<{ counts: Record<string, number> }>(await ed.get(`${P}/review`))
    expect(counts.counts.archived).toBe(1)
    const list = await json<{ items: { id: string }[] }>(await ed.get(`${P}/review/archived`))
    expect(list.items.map((i) => i.id)).toEqual([mem.id])
  })
})
