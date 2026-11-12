// Concurrent writes of one item (benchmark finding "two simultaneous updates leave two current versions"):
// two supersedes of one old item, with and without `revision`, two creates with `supersedes`, two plain
// updates with the same base revision, and the one-superseder index backstop (data-model.md section 3,
// api.md 5.4). Each race fires both requests at once, several rounds.
import { and, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import { addMember, createItem, createProject, createUser } from '../../../test/factories.js'
import { type Client, json, loginAs, testApp } from '../../../test/http.js'
import { stubPorts } from '../../../test/ports.js'
import { edges, itemRevisions, items } from '../../db/schema.js'
import { pgError } from '../../lib/db.js'
import { ApiError } from '../../lib/errors.js'
import { addEdge } from './links.js'
import { type LoadedItem, loadItem } from './rows.js'

const db = () => testDb()
const P = '/api/v1/projects/acme'
const ROUNDS = 5

let ed: Client
let acme: { id: string }
beforeEach(async () => {
  const { app } = testApp({ ports: stubPorts() })
  acme = await createProject(db(), { slug: 'acme' })
  const editor = await createUser(db())
  await addMember(db(), acme.id, editor.id, 'editor')
  ed = await loginAs(app, editor.email, editor.password)
})

const supersedersOf = (oldId: string) =>
  db()
    .select({ srcId: edges.srcId })
    .from(edges)
    .where(and(eq(edges.dstId, oldId), eq(edges.kind, 'supersedes')))

const memoryCount = async () =>
  (await db().select({ id: items.id }).from(items).where(eq(items.projectId, acme.id))).length

type ErrBody = { error: string; message: string; details: Record<string, unknown> }

describe('concurrent supersedes of one item', () => {
  for (const withRevision of [false, true]) {
    it(`two supersedes ${withRevision ? 'with the same revision' : 'without revision'}: one wins, the other is 409`, async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const old = await createItem(db(), { projectId: acme.id })
        const before = await memoryCount()
        const sup = (title: string) =>
          ed.post(`${P}/items/${old.id}/supersede`, {
            new: { title },
            ...(withRevision ? { revision: 1 } : {}),
          })
        const res = await Promise.all([sup(`Round ${round} writer A`), sup(`Round ${round} writer B`)])
        expect(res.map((r) => r.status).sort()).toEqual([200, 409])
        const winner = await json<{ new: { id: string; handle: string; revision: number } }>(
          res.find((r) => r.status === 200) as Response,
        )
        const loser = await json<ErrBody>(res.find((r) => r.status === 409) as Response)
        expect(loser.error).toBe('revision_conflict')
        if (!withRevision) {
          // without revision the loser waits for the winner and finds the old item superseded
          expect(loser.details.superseded_by).toEqual({
            handle: winner.new.handle,
            revision: winner.new.revision,
          })
          expect(loser.message).toBe(
            `m${old.number} was already superseded by ${winner.new.handle} r${winner.new.revision}: read it and update or supersede ${winner.new.handle} instead.`,
          )
        }
        expect(await supersedersOf(old.id)).toEqual([{ srcId: winner.new.id }])
        // the losing transaction left nothing behind: one new item, not two
        expect(await memoryCount()).toBe(before + 1)
      }
    })
  }

  it('two existing items superseding one item (new_id): one wins', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const old = await createItem(db(), { projectId: acme.id })
      const a = await createItem(db(), { projectId: acme.id })
      const b = await createItem(db(), { projectId: acme.id })
      const sup = (id: string) => ed.post(`${P}/items/${old.id}/supersede`, { new_id: id })
      const res = await Promise.all([sup(a.id), sup(b.id)])
      expect(res.map((r) => r.status).sort()).toEqual([200, 409])
      expect(await supersedersOf(old.id)).toHaveLength(1)
    }
  })

  it('two decisions created with the same supersedes: one wins, no orphan ADR', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const old = await createItem(db(), { projectId: acme.id, space: 'decisions', status: 'accepted' })
      const before = await memoryCount()
      const mk = (title: string) =>
        ed.post(`${P}/spaces/decisions/items`, {
          title,
          supersedes: `ADR-${String(old.adrNumber).padStart(4, '0')}`,
        })
      const res = await Promise.all([mk(`Round ${round} A`), mk(`Round ${round} B`)])
      expect(res.map((r) => r.status).sort()).toEqual([201, 409])
      expect((await json<ErrBody>(res.find((r) => r.status === 409) as Response)).error).toBe(
        'revision_conflict',
      )
      expect(await supersedersOf(old.id)).toHaveLength(1)
      expect(await memoryCount()).toBe(before + 1)
    }
  })
})

describe('supersede of an already superseded item (sequential)', () => {
  it('a different successor is 409 naming the existing one; a retry by the same successor is OK', async () => {
    const old = await createItem(db(), { projectId: acme.id })
    const first = await createItem(db(), { projectId: acme.id })
    const second = await createItem(db(), { projectId: acme.id })
    expect((await ed.post(`${P}/items/${old.id}/supersede`, { new_id: first.id })).status).toBe(200)
    // the same successor again: idempotent
    const retry = await ed.post(`${P}/items/${old.id}/supersede`, { new_id: first.id })
    expect(retry.status).toBe(200)
    expect((await json<{ old: { revision: number } }>(retry)).old.revision).toBe(2)
    const other = await ed.post(`${P}/items/${old.id}/supersede`, { new_id: second.id })
    expect(other.status).toBe(409)
    expect(await json<ErrBody>(other)).toMatchObject({
      error: 'revision_conflict',
      details: {
        current_revision: 2,
        superseded_by: { handle: `m${first.number}`, revision: 1 },
      },
    })
    const created = await ed.post(`${P}/items/${old.id}/supersede`, { new: { title: 'A third claim' } })
    expect(created.status).toBe(409)
    expect(await supersedersOf(old.id)).toEqual([{ srcId: first.id }])
  })
})

describe('supersede of an item set back to active', () => {
  it('A superseded by B, B by C, A set active: D supersedes A; the stale B edge becomes refines', async () => {
    const a = await createItem(db(), { projectId: acme.id })
    const b = await createItem(db(), { projectId: acme.id })
    const c = await createItem(db(), { projectId: acme.id })
    const d = await createItem(db(), { projectId: acme.id })
    expect((await ed.post(`${P}/items/${a.id}/supersede`, { new_id: b.id })).status).toBe(200)
    expect((await ed.post(`${P}/items/${b.id}/supersede`, { new_id: c.id })).status).toBe(200)
    // no live item supersedes A any more, so the status write is not kept at `superseded`
    const back = await ed.patch(`${P}/items/${a.id}`, { revision: 2, status: 'active' })
    expect(back.status).toBe(200)
    const [reverted] = await db().select({ status: items.status }).from(items).where(eq(items.id, a.id))
    expect(reverted?.status).toBe('active')
    const res = await ed.post(`${P}/items/${a.id}/supersede`, { new_id: d.id })
    expect(res.status).toBe(200)
    expect(await supersedersOf(a.id)).toEqual([{ srcId: d.id }])
    const fromB = await db()
      .select({ kind: edges.kind })
      .from(edges)
      .where(and(eq(edges.srcId, b.id), eq(edges.dstId, a.id)))
    expect(fromB).toEqual([{ kind: 'refines' }])
    const [row] = await db().select({ status: items.status }).from(items).where(eq(items.id, a.id))
    expect(row?.status).toBe('superseded')
  })
})

describe('concurrent plain updates with the same base revision', () => {
  it('one PATCH wins, the other is 409 revision_conflict; no lost revision', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const item = await createItem(db(), { projectId: acme.id })
      const patch = (body: string) => ed.patch(`${P}/items/${item.id}`, { revision: 1, body })
      const res = await Promise.all([patch(`A ${round}`), patch(`B ${round}`)])
      expect(res.map((r) => r.status).sort()).toEqual([200, 409])
      expect((await json<ErrBody>(res.find((r) => r.status === 409) as Response)).details).toMatchObject({
        current_revision: 2,
      })
      const revs = await db()
        .select({ revision: itemRevisions.revision, body: itemRevisions.body })
        .from(itemRevisions)
        .where(eq(itemRevisions.itemId, item.id))
        .orderBy(itemRevisions.revision)
      expect(revs.map((r) => r.revision)).toEqual([1, 2])
      const [row] = await db().select().from(items).where(eq(items.id, item.id))
      expect(row?.revision).toBe(2)
      expect(row?.body).toBe(revs[1]?.body)
    }
  })
})

describe('the one-superseder index (backstop)', () => {
  it('refuses a second supersedes edge into one item', async () => {
    const old = await createItem(db(), { projectId: acme.id })
    const a = await createItem(db(), { projectId: acme.id })
    const b = await createItem(db(), { projectId: acme.id })
    const ins = (src: string) =>
      db().execute(
        sql`INSERT INTO edges (project_id, src_id, kind, dst_ref, dst_id) VALUES (${acme.id}, ${src}, 'supersedes', ${old.id}, ${old.id})`,
      )
    await ins(a.id)
    const err = await ins(b.id).then(
      () => null,
      (e: unknown) => e,
    )
    expect(pgError(err)).toMatchObject({ code: '23505', constraint: 'edges_one_superseder_uq' })
    // a dangling supersedes edge (target deleted) does not count
    await db().execute(
      sql`INSERT INTO edges (project_id, src_id, kind, dst_ref, dst_id) VALUES (${acme.id}, ${b.id}, 'supersedes', 'gone', NULL)`,
    )
  })
})

describe('addEdge maps the index violation', () => {
  it('a second superseder that skipped the locked check is 409 revision_conflict, not a 500', async () => {
    const old = await createItem(db(), { projectId: acme.id })
    const a = await createItem(db(), { projectId: acme.id })
    const b = await createItem(db(), { projectId: acme.id })
    const load = async (id: string) => (await loadItem(db(), id)) as LoadedItem
    const actor = { userId: null, label: 'test', clientName: null }
    await db().transaction(async (tx) =>
      addEdge(tx, await load(a.id), 'supersedes', await load(old.id), actor),
    )
    const err = await db()
      .transaction(async (tx) => addEdge(tx, await load(b.id), 'supersedes', await load(old.id), actor))
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'revision_conflict', details: { current_revision: 1 } })
  })
})
