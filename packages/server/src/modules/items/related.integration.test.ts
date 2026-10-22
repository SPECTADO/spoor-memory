// Related items (`GET …/items/:ref/related`, ADR-0022): best-chunk cosine over the project and `_shared` on the
// same model, unlinked/superseded/archived/expired/self excluded, the project floor and its clamp below the
// duplicate threshold, the pending note, access and validation; plus the `dedupe.related_min_cos` setting.
// Vectors come from the deterministic bag-of-words FakeEmbeddingProvider: n shared words of 5 give cos n/5.
import { RELATED_PENDING_NOTE, type RelatedResponse } from '@spoor/shared'
import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import {
  addMember,
  createAdmin,
  createItem,
  createProject,
  createUser,
  type ItemOpts,
} from '../../../test/factories.js'
import { type Client, json, loginAs, testApp } from '../../../test/http.js'
import { FakeEmbeddingProvider, StaticEmbeddingRegistry, stubPorts } from '../../../test/ports.js'
import { edges, items, projects } from '../../db/schema.js'
import type { AuthContext } from '../../lib/auth-context.js'
import { withTx } from '../../lib/db.js'
import { RELATED_KNN } from '../search/index.js'
import type { Caller } from './writes.js'

const db = () => testDb()
const fake = new FakeEmbeddingProvider()
const other = new FakeEmbeddingProvider({ model: 'fake/other', dims: 8 })

async function seed(settings: Record<string, unknown> = {}) {
  const ports = stubPorts({ embeddings: new StaticEmbeddingRegistry(fake, [other]) })
  const { app, modules } = testApp({ ports })
  ports.search = modules.search.search
  const shared = await createProject(db(), { kind: 'shared', embeddingModel: fake.tag })
  const acme = await createProject(db(), { slug: 'acme', embeddingModel: fake.tag, settings })
  const editor = await createUser(db())
  const outsider = await createUser(db())
  const ia = await createAdmin(db())
  await addMember(db(), acme.id, editor.id, 'editor')
  const login = (u: { email: string; password: string }) => loginAs(app, u.email, u.password)
  return {
    app,
    search: modules.search.search,
    items: modules.items.items,
    shared,
    acme,
    editor,
    outsider,
    ia,
    login,
  }
}

let s: Awaited<ReturnType<typeof seed>>
let ed: Client
beforeEach(async () => {
  s = await seed()
  ed = await s.login(s.editor)
})

const P = '/api/v1/projects/acme'

/** An item with its chunks embedded by the real search module. */
async function add(opts: ItemOpts) {
  const item = await createItem(db(), opts)
  const prepared = await s.search.prepareChunks({
    projectId: item.projectId,
    space: item.space,
    title: item.title,
    tags: item.tags,
    body: item.body,
  })
  await withTx(db(), (tx) =>
    s.search.indexItemChunks(
      tx,
      { id: item.id, projectId: item.projectId, space: item.space, revision: item.revision },
      prepared,
    ),
  )
  return item
}

const setItem = (id: string, v: Partial<typeof items.$inferInsert>) =>
  db().update(items).set(v).where(eq(items.id, id))
const link = (src: { id: string; projectId: string }, dst: { id: string }) =>
  db()
    .insert(edges)
    .values({ projectId: src.projectId, srcId: src.id, kind: 'refines', dstRef: dst.id, dstId: dst.id })

/** Give `item` n more chunks, each a copy of `like`'s first chunk vector (cos 1 to it): a long near doc. */
const pad = (item: { id: string }, like: { id: string }, n: number) =>
  db().execute(sql`
    INSERT INTO chunks (item_id, project_id, space, ordinal, item_revision, text, model, dims, embedding)
    SELECT ${item.id}::uuid, t.project_id, t.space, 1000 + g, t.item_revision, 'pad', c.model, c.dims, c.embedding
    FROM chunks c, generate_series(1, ${n}::int) g,
         (SELECT project_id, space, item_revision FROM chunks WHERE item_id = ${item.id}::uuid LIMIT 1) t
    WHERE c.item_id = ${like.id}::uuid AND c.ordinal = 0`)

const related = async (ref: string, query = '', c = ed) => {
  const r = await c.get(`${P}/items/${ref}/related${query}`)
  expect(r.status, await r.clone().text()).toBe(200)
  return json<RelatedResponse>(r)
}
/** The editor as an in-process caller of the items service. */
const callerOf = (): Caller => ({
  ctx: {
    user: { id: s.editor.id, email: s.editor.email, name: 'e', isAdmin: false, sharedEditor: false },
    project: { id: s.acme.id, slug: 'acme', name: 'acme', kind: 'project' },
    role: 'editor',
    via: 'cookie',
  } as AuthContext,
  via: 'web',
  project: { id: s.acme.id, slug: 'acme', kind: 'project' },
})
const handles = (r: RelatedResponse) => r.items.map((x) => x.item.handle)

/** probe m1 and candidates at cos 0.8 (m2), 0.8 in docs (d3), 0.6 (m4), ~0 (m5). */
async function project() {
  const probe = await add({ projectId: s.acme.id, title: 'orbital rocket engine thrust nozzle' })
  const near = await add({ projectId: s.acme.id, title: 'orbital rocket engine thrust valve' })
  const doc = await add({ projectId: s.acme.id, space: 'docs', title: 'orbital rocket engine thrust manual' })
  const mid = await add({ projectId: s.acme.id, title: 'orbital rocket engine pump valve' })
  const far = await add({ projectId: s.acme.id, title: 'banana bread recipe oven sugar' })
  return { probe, near, doc, mid, far }
}

describe('GET …/items/:ref/related', () => {
  it('ranks similar unlinked items across spaces by cos above the default floor (0.70)', async () => {
    const { near, doc } = await project()
    await setItem(doc.id, { updatedAt: new Date(Date.now() + 60_000) }) // the cos tie breaks on updated_at
    const r = await related('m1')
    expect(r.note).toBeUndefined()
    expect(handles(r)).toEqual(['d3', 'm2'])
    expect(r.items[0]?.item).toMatchObject({ id: doc.id, project: 'acme', space: 'docs' })
    expect(r.items[1]?.item.id).toBe(near.id)
    expect(r.items[0]?.cos).toBeCloseTo(0.8, 3)
    // limit
    expect(handles(await related('m1', '?limit=1'))).toEqual(['d3'])
  })

  it('excludes self, linked (either direction), superseded, deprecated, archived and expired items', async () => {
    const { probe, near, doc } = await project()
    const more = await add({ projectId: s.acme.id, title: 'orbital rocket engine thrust gauge' })
    const dec = await add({
      projectId: s.acme.id,
      space: 'decisions',
      title: 'orbital rocket engine thrust plan',
    })
    const obs = await add({
      projectId: s.acme.id,
      type: 'observation',
      title: 'orbital rocket engine thrust today',
    })
    const sup = await add({ projectId: s.acme.id, title: 'orbital rocket engine thrust old' })
    expect(handles(await related('m1', '?limit=10'))).toHaveLength(6)
    await link(probe, near) // outgoing
    await link(doc, probe) // incoming
    await setItem(sup.id, { status: 'superseded' })
    await setItem(dec.id, { status: 'deprecated' })
    await setItem(more.id, { lifecycle: 'archived', archivedAt: new Date(), archiveReason: 'manual' })
    await setItem(obs.id, { expiresAt: new Date(Date.now() - 60_000) })
    expect((await related('m1')).items).toEqual([])
    // a stale item is still suggested
    await setItem(more.id, {
      lifecycle: 'stale',
      archivedAt: null,
      archiveReason: null,
      staleSince: new Date(),
    })
    expect(handles(await related('m1'))).toEqual([`m${more.number}`])
  })

  it('excluded items never use up the per-probe-chunk kNN slots', async () => {
    const { probe, near, doc } = await project()
    // a linked long doc and an archived one, each with more chunks at cos 1 than RELATED_KNN
    const linked = await add({
      projectId: s.acme.id,
      space: 'docs',
      title: 'orbital rocket engine thrust book',
    })
    const archived = await add({ projectId: s.acme.id, title: 'orbital rocket engine thrust copy' })
    await pad(linked, probe, RELATED_KNN + 20)
    await pad(archived, probe, RELATED_KNN + 20)
    await link(probe, linked)
    await setItem(archived.id, { lifecycle: 'archived', archivedAt: new Date(), archiveReason: 'manual' })
    const r = await related('m1', '?limit=2')
    expect(r.note).toBeUndefined()
    expect(r.items.map((x) => x.item.id).sort()).toEqual([near.id, doc.id].sort())
    // the same through excludeIds and superseded
    await db().delete(edges).where(eq(edges.srcId, probe.id))
    await setItem(archived.id, {
      lifecycle: 'active',
      archivedAt: null,
      archiveReason: null,
      status: 'superseded',
    })
    const caller = callerOf()
    const row = await s.items.load(caller, 'm1', 'read')
    const ex = await s.items.relatedByProbe(caller, { item: row, excludeIds: [linked.id] }, 2)
    expect(ex.items.map((x) => x.item.id).sort()).toEqual([near.id, doc.id].sort())
  })

  it('K grows with the limit: limit=20 returns every qualifying item beyond a long unlinked doc', async () => {
    const { probe, near, doc } = await project()
    const long = await add({
      projectId: s.acme.id,
      space: 'docs',
      title: 'orbital rocket engine thrust book',
    })
    await pad(long, probe, RELATED_KNN + 50) // more near chunks than the minimum K, fewer than 20 × 20
    const r = await related('m1', '?limit=20')
    expect(r.items[0]?.item.id).toBe(long.id)
    expect(r.items.map((x) => x.item.id).sort()).toEqual([long.id, near.id, doc.id].sort())
    expect(r.items[0]?.cos).toBeCloseTo(1, 3)
  })

  it('respects the project floor and clamps it below the duplicate threshold', async () => {
    await project()
    const patch = (dedupe: Record<string, number>) =>
      db().update(projects).set({ settings: { dedupe } }).where(eq(projects.id, s.acme.id))
    await patch({ related_min_cos: 0.5 })
    expect(handles(await related('m1'))).toEqual(expect.arrayContaining(['m2', 'd3', 'm4']))
    expect((await related('m1')).items).toHaveLength(3)
    await patch({ related_min_cos: 0.85 })
    expect((await related('m1')).items).toEqual([]) // nothing reaches the floor: no note either
    expect((await related('m1')).note).toBeUndefined()
    // related 0.90 with threshold 0.80 reads as 0.79: the 0.8 items come back
    await patch({ related_min_cos: 0.9, threshold: 0.8 })
    expect((await related('m1')).items).toHaveLength(2)
  })

  it('includes _shared items only while _shared runs the same model, with S: handles', async () => {
    await project()
    const lib = await add({
      projectId: s.shared.id,
      space: 'library',
      title: 'orbital rocket engine thrust guide',
    })
    const r = await related('m1')
    expect(handles(r)).toContain(`S:L${lib.number}`)
    expect(r.items.find((x) => x.item.id === lib.id)?.item.project).toBe('_shared')
    await db().update(projects).set({ embeddingModel: other.tag }).where(eq(projects.id, s.shared.id))
    expect(handles(await related('m1'))).not.toContain(`S:L${lib.number}`)
  })

  it('a shared item only gets _shared candidates', async () => {
    await project()
    const a = await add({
      projectId: s.shared.id,
      space: 'docs',
      title: 'orbital rocket engine thrust nozzle',
    })
    const b = await add({
      projectId: s.shared.id,
      space: 'docs',
      title: 'orbital rocket engine thrust valve',
    })
    const r = await related(`S:d${a.number}`)
    expect(r.items.map((x) => x.item.id)).toEqual([b.id])
    expect(r.items[0]?.item.handle).toBe(`S:d${b.number}`)
  })

  it('answers with the pending note while the item has no vector', async () => {
    await project()
    const bare = await createItem(db(), { projectId: s.acme.id, title: 'orbital rocket engine thrust bare' })
    expect(await related(`m${bare.number}`)).toEqual({ items: [], note: RELATED_PENDING_NOTE })
    fake.failNext = true
    const failed = await add({ projectId: s.acme.id, title: 'orbital rocket engine thrust failed' })
    expect((await related(`m${failed.number}`)).note).toBe(RELATED_PENDING_NOTE)
  })

  it('access and validation: non-members 404, unknown ref 404, bad limit 400', async () => {
    await project()
    const out = await s.login(s.outsider)
    expect((await out.get(`${P}/items/m1/related`)).status).toBe(404)
    expect((await ed.get(`${P}/items/m999/related`)).status).toBe(404)
    expect((await ed.get(`${P}/items/m1/related?limit=21`)).status).toBe(400)
    expect((await ed.get(`${P}/items/m1/related?limit=0`)).status).toBe(400)
    expect((await ed.get(`${P}/items/m1/related?limit=x`)).status).toBe(400)
    expect((await ed.get(`${P}/items/m1/related?nope=1`)).status).toBe(400)
    expect((await ed.get(`${P}/items/m1/related?limit=20`)).status).toBe(200)
    const anon = await s.app.request(`${P}/items/m1/related`)
    expect(anon.status).toBe(401)
  })
})

describe('ItemService.relatedByProbe', () => {
  it('takes prepared chunks as the probe and skips excludeIds', async () => {
    const { probe, near, doc } = await project()
    const caller = callerOf()
    const row = await s.items.load(caller, 'm1', 'read')
    // a probe text unlike the stored one: the far item becomes the match
    const prepared = await s.search.prepareChunks({
      projectId: s.acme.id,
      space: 'memories',
      title: 'banana bread recipe oven flour',
      tags: [],
      body: '',
    })
    const r = await s.items.relatedByProbe(caller, { item: row, chunks: prepared.chunks }, 5)
    expect(handles(r)).toEqual(['m5'])
    const ex = await s.items.relatedByProbe(caller, { item: row, excludeIds: [doc.id] }, 5)
    expect(ex.items.map((x) => x.item.id)).toEqual([near.id])
    expect(probe.id).toBe(row.id)
  })
})

describe('setting dedupe.related_min_cos', () => {
  it('defaults to 0.70, accepts 0.50-0.90, rejects values outside', async () => {
    const ia = await s.login(s.ia)
    const get = async () =>
      (await json<{ settings: { dedupe: { related_min_cos: number } } }>(await ia.get(P))).settings.dedupe
    expect((await get()).related_min_cos).toBe(0.7)
    const set = (v: number) => ia.patch(P, { settings: { dedupe: { related_min_cos: v } } })
    expect((await set(0.45)).status).toBe(400)
    expect((await set(0.95)).status).toBe(400)
    expect((await set(0.75)).status).toBe(200)
    expect(await get()).toMatchObject({ threshold: 0.87, related_min_cos: 0.75 })
    // above the threshold is stored as is; reads clamp (see the floor test)
    expect(
      (await ia.patch(P, { settings: { dedupe: { threshold: 0.85, related_min_cos: 0.9 } } })).status,
    ).toBe(200)
    // editors may not change settings
    expect((await ed.patch(P, { settings: { dedupe: { related_min_cos: 0.6 } } })).status).toBe(403)
  })
})
