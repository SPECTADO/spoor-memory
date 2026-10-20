// Edges: wikilinks (resolution, claiming, precedence, scope), typed relations, supersede with the sticky
// rule, hard delete with the purge bypass, resolve (data-model.md sections 3 and 7, api.md 5.3 to 5.5).
import { and, eq, inArray, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { testDb } from '../../../test/db.js'
import {
  addMember,
  createAdmin,
  createItem,
  createProject,
  createSharedProject,
  createUser,
} from '../../../test/factories.js'
import { type Client, json, loginAs, testApp } from '../../../test/http.js'
import { stubPorts } from '../../../test/ports.js'
import { auditLog, chunks, edges, itemRevisions, items } from '../../db/schema.js'
import type { AuthContext } from '../../lib/auth-context.js'
import { pgError } from '../../lib/db.js'
import type { Caller } from './writes.js'

const db = () => testDb()

async function seed() {
  const { app, modules } = testApp({ ports: stubPorts() })
  const module = modules.items
  const shared = await createSharedProject(db())
  const acme = await createProject(db(), { slug: 'acme' })
  const other = await createProject(db(), { slug: 'other' })
  const editor = await createUser(db())
  const pa = await createUser(db())
  const se = await createUser(db(), { sharedEditor: true })
  const ia = await createAdmin(db())
  await addMember(db(), acme.id, editor.id, 'editor')
  await addMember(db(), acme.id, pa.id, 'admin')
  await addMember(db(), other.id, editor.id, 'editor')
  const login = (u: { email: string; password: string }) => loginAs(app, u.email, u.password)
  return { app, items: module.items, shared, acme, other, editor, pa, se, ia, login }
}

let s: Awaited<ReturnType<typeof seed>>
let ed: Client
beforeEach(async () => {
  s = await seed()
  ed = await s.login(s.editor)
})

const P = '/api/v1/projects/acme'
const SH = '/api/v1/projects/_shared'
type ItemRes = { item: { id: string; handle: string; revision: number; status: string } }
const mk = async (c: Client, space: string, body: Record<string, unknown>, base = P) => {
  const r = await c.post(`${base}/spaces/${space}/items`, body)
  if (r.status !== 201) throw new Error(`create failed ${r.status} ${await r.text()}`)
  return (await json<ItemRes>(r)).item
}
const wikiEdges = (srcId: string) =>
  db()
    .select({ dstRef: edges.dstRef, dstId: edges.dstId })
    .from(edges)
    .where(and(eq(edges.srcId, srcId), eq(edges.kind, 'wikilink')))
    .orderBy(edges.dstRef)

describe('wikilinks', () => {
  it('dangling links are claimed by a later item; a higher-precedence item takes them over', async () => {
    const doc = await mk(ed, 'docs', { title: 'Overview', body: 'See [[Auth Flow]] and `[[not-a-link]]`.' })
    expect(await wikiEdges(doc.id)).toEqual([{ dstRef: 'auth-flow', dstId: null }])
    const mem = await mk(ed, 'memories', { title: 'Auth flow', type: 'fact' })
    expect(await wikiEdges(doc.id)).toEqual([{ dstRef: 'auth-flow', dstId: mem.id }])
    // a doc source prefers docs: the new doc auth-flow takes the link over from the memory
    const authDoc = await mk(ed, 'docs', { title: 'Auth flow' })
    expect(await wikiEdges(doc.id)).toEqual([{ dstRef: 'auth-flow', dstId: authDoc.id }])
    // a memory source prefers memories: a memory linking [[auth-flow]] resolves to the memory
    const m2 = await mk(ed, 'memories', { title: 'Other', type: 'fact', body: '[[auth-flow]]' })
    expect(await wikiEdges(m2.id)).toEqual([{ dstRef: 'auth-flow', dstId: mem.id }])
  })

  it('handle forms and ADR refs resolve; links are rewritten on every content revision; no self links', async () => {
    const adr = await mk(ed, 'decisions', { title: 'Use Postgres' })
    const m = await mk(ed, 'memories', { title: 'Fact', type: 'fact' })
    const d = await mk(ed, 'docs', {
      title: 'Doc',
      body: `[[ADR-0001]] [[adr-1|again]] [[${m.handle}]] [[doc]] [[d99]]`,
    })
    expect(await wikiEdges(d.id)).toEqual([
      { dstRef: 'adr-1', dstId: adr.id },
      { dstRef: 'd99', dstId: null },
      { dstRef: m.handle, dstId: m.id },
    ])
    await ed.patch(`${P}/items/${d.id}`, { revision: 1, body: `only [[${m.handle}]] now` })
    expect(await wikiEdges(d.id)).toEqual([{ dstRef: m.handle, dstId: m.id }])
    // the item named d99 later claims nothing (it is a doc numbered by the shared counter, so not d99)
    await ed.patch(`${P}/items/${d.id}`, { revision: 2, body: 'no links' })
    expect(await wikiEdges(d.id)).toEqual([])
  })

  it('shared: links resolve into _shared; a shared source never resolves into a project', async () => {
    const m = await mk(ed, 'memories', {
      title: 'Uses style',
      type: 'fact',
      body: 'Follow [[shared:style-guide]].',
    })
    expect(await wikiEdges(m.id)).toEqual([{ dstRef: 'shared:style-guide', dstId: null }])
    const se = await s.login(s.se)
    const guide = await mk(se, 'docs', { title: 'Style guide', body: 'Unlike [[uses-style]] in acme.' }, SH)
    // claimed across projects
    expect(await wikiEdges(m.id)).toEqual([{ dstRef: 'shared:style-guide', dstId: guide.id }])
    // the shared doc's link to a project slug stays dangling (scope)
    expect(await wikiEdges(guide.id)).toEqual([{ dstRef: 'uses-style', dstId: null }])
  })

  it('the scope trigger refuses an edge out of _shared (P0002)', async () => {
    const sharedItem = await createItem(db(), { projectId: s.shared.id })
    const projectItem = await createItem(db(), { projectId: s.acme.id })
    const err = await db()
      .insert(edges)
      .values({
        projectId: s.shared.id,
        srcId: sharedItem.id,
        kind: 'refines',
        dstRef: projectItem.id,
        dstId: projectItem.id,
      })
      .catch((e) => e)
    expect(pgError(err)?.code).toBe('P0002')
  })
})

describe('typed edges', () => {
  it('add is idempotent, conflicts_with is symmetric, shared targets allowed, listing both ways', async () => {
    const a = await createItem(db(), { projectId: s.acme.id })
    const b = await createItem(db(), { projectId: s.acme.id })
    const sh = await createItem(db(), { projectId: s.shared.id, title: 'Shared fact' })
    const add = (from: string, body: Record<string, unknown>) => ed.post(`${P}/items/${from}/edges`, body)
    expect((await add(a.id, { kind: 'refines', to: b.id })).status).toBe(201)
    expect((await add(a.id, { kind: 'refines', to: b.id })).status).toBe(200)
    expect((await add(a.id, { kind: 'conflicts_with', to: b.id })).status).toBe(201)
    expect((await add(b.id, { kind: 'conflicts_with', to: a.id })).status).toBe(200)
    const toShared = await add(a.id, { kind: 'supports', to: 'S:m1' })
    expect(toShared.status).toBe(201)
    const [sharedEdge] = await db()
      .select()
      .from(edges)
      .where(and(eq(edges.srcId, a.id), eq(edges.kind, 'supports')))
    expect(sharedEdge?.dstRef).toBe(`shared:memories/${sh.slug}`)
    expect((await add(a.id, { kind: 'refines', to: a.id })).status).toBe(400)
    expect((await add(a.id, { kind: 'wikilink', to: b.id })).status).toBe(400)
    const listed = await json<{
      outgoing: { kind: string; other: { handle: string } | null; editable: boolean }[]
      incoming: unknown[]
    }>(await ed.get(`${P}/items/${a.id}/edges`))
    expect(listed.outgoing.map((e) => [e.kind, e.other?.handle, e.editable])).toEqual([
      ['refines', `m${b.number}`, true],
      ['conflicts_with', `m${b.number}`, true],
      ['supports', 'S:m1', true],
    ])
    const audit = await db().select().from(auditLog).where(eq(auditLog.action, 'edge.add'))
    expect(audit).toHaveLength(3)
  })

  it('a shared source cannot point into a project; S: in a from position is read_only_space', async () => {
    const projectItem = await createItem(db(), { projectId: s.acme.id })
    const sh = await createItem(db(), { projectId: s.shared.id })
    const se = await s.login(s.se)
    expect(
      (await se.post(`${SH}/items/${sh.id}/edges`, { kind: 'refines', to: projectItem.id })).status,
    ).toBe(404)
    expect((await ed.post(`${P}/items/S:m1/edges`, { kind: 'refines', to: projectItem.id })).status).toBe(403)
  })

  it('DELETE /edges/:id: typed only; system edges are not editable', async () => {
    const a = await createItem(db(), { projectId: s.acme.id })
    const doc = await mk(ed, 'docs', { title: 'D', body: `[[m${a.number}]]` })
    const b = await createItem(db(), { projectId: s.acme.id })
    await ed.post(`${P}/items/${a.id}/edges`, { kind: 'depends_on', to: b.id })
    const [typed] = await db().select().from(edges).where(eq(edges.kind, 'depends_on'))
    const [wiki] = await db().select().from(edges).where(eq(edges.srcId, doc.id))
    expect((await ed.delete(`/api/v1/projects/other/edges/${typed?.id}`)).status).toBe(404)
    expect((await ed.delete(`${P}/edges/${wiki?.id}`)).status).toBe(409)
    expect((await ed.delete(`${P}/edges/${typed?.id}`)).status).toBe(204)
    expect(await db().select().from(edges).where(eq(edges.kind, 'depends_on'))).toEqual([])
  })

  it('on a shared item, links are filtered to the caller’s projects', async () => {
    const sh = await createItem(db(), { projectId: s.shared.id })
    const fromAcme = await createItem(db(), { projectId: s.acme.id })
    const otherUser = await createUser(db())
    const third = await createProject(db(), { slug: 'third' })
    await addMember(db(), third.id, otherUser.id, 'editor')
    const fromThird = await createItem(db(), { projectId: third.id })
    for (const src of [fromAcme, fromThird]) {
      await db()
        .insert(edges)
        .values({ projectId: src.projectId, srcId: src.id, kind: 'supports', dstRef: 'x', dstId: sh.id })
    }
    const view = async (c: Client) =>
      (
        await json<{ incoming: { other: { project: string } }[] }>(await c.get(`${SH}/items/${sh.id}/edges`))
      ).incoming.map((e) => e.other.project)
    expect(await view(ed)).toEqual(['acme'])
    expect((await view(await s.login(s.ia))).sort()).toEqual(['acme', 'third'])
  })
})

describe('supersede and the sticky status', () => {
  it('new: creates the replacement (inheriting type, tags, anchors), old → superseded r2', async () => {
    const old = await createItem(db(), {
      projectId: s.acme.id,
      type: 'procedure',
      tags: ['ops'],
      anchors: ['deploy/'],
    })
    const r = await ed.post(`${P}/items/${old.id}/supersede`, {
      new: { title: 'Deploy with compose v2' },
      revision: 1,
      reason: 'outdated',
    })
    expect(r.status).toBe(200)
    const body = await json<{ new: Record<string, unknown>; old: Record<string, unknown> }>(r)
    expect(body.new).toMatchObject({
      type: 'procedure',
      tags: ['ops'],
      anchors: ['deploy/'],
      status: 'active',
    })
    expect(body.old).toMatchObject({ status: 'superseded', revision: 2, superseded_by: body.new.handle })
    const [rev] = await db()
      .select()
      .from(itemRevisions)
      .where(and(eq(itemRevisions.itemId, old.id), eq(itemRevisions.revision, 2)))
    expect(rev).toMatchObject({ change: 'supersede', status: 'superseded' })
    const [audit] = await db().select().from(auditLog).where(eq(auditLog.action, 'item.supersede'))
    expect(audit?.data).toMatchObject({ by: body.new.handle })
  })

  it('new_id; rules: memories only, exactly one of new/new_id, no shared new_id, revision checked', async () => {
    const old = await createItem(db(), { projectId: s.acme.id })
    const winner = await createItem(db(), { projectId: s.acme.id })
    const adr = await createItem(db(), { projectId: s.acme.id, space: 'decisions' })
    await createItem(db(), { projectId: s.shared.id })
    const sup = (ref: string, b: Record<string, unknown>) => ed.post(`${P}/items/${ref}/supersede`, b)
    expect((await json(await sup(adr.id, { new_id: winner.id }))).error).toBe('wrong_space')
    expect((await sup(old.id, {})).status).toBe(400)
    expect((await sup(old.id, { new_id: winner.id, new: { title: 'x y z' } })).status).toBe(400)
    expect((await json(await sup(old.id, { new_id: 'S:m1' }))).error).toBe('read_only_space')
    const conflict = await sup(old.id, { new_id: winner.id, revision: 5 })
    expect(conflict.status).toBe(409)
    expect(await json(conflict)).toMatchObject({
      error: 'revision_conflict',
      details: { current_revision: 1 },
    })
    expect(await db().select().from(edges).where(eq(edges.kind, 'supersedes'))).toEqual([])
    expect((await sup(old.id, { new_id: winner.id })).status).toBe(200)
    expect((await db().select().from(items).where(eq(items.id, old.id)))[0]?.status).toBe('superseded')
  })

  it('superseded is sticky while a live superseder exists', async () => {
    const old = await createItem(db(), { projectId: s.acme.id })
    const winner = await createItem(db(), { projectId: s.acme.id })
    await ed.post(`${P}/items/${old.id}/supersede`, { new_id: winner.id })
    const r = await ed.patch(`${P}/items/${old.id}`, { revision: 2, status: 'active', body: 'edited' })
    const body = await json<{ item: { status: string; revision: number }; warnings: { code: string }[] }>(r)
    expect(body.item).toMatchObject({ status: 'superseded', revision: 3 })
    expect(body.warnings).toEqual([{ code: 'status_kept_superseded' }])
    // once the superseder is itself superseded, the status may change again
    await db().update(items).set({ status: 'superseded' }).where(eq(items.id, winner.id))
    const r2 = await ed.patch(`${P}/items/${old.id}`, { revision: 3, status: 'active' })
    expect((await json<{ item: { status: string } }>(r2)).item.status).toBe('active')
  })

  it('a decision created with supersedes marks the old ADR superseded', async () => {
    const old = await mk(ed, 'decisions', { title: 'Use MySQL', status: 'accepted' })
    const neu = await mk(ed, 'decisions', { title: 'Use Postgres', supersedes: old.handle })
    const got = await json<{ status: string; superseded_by: string }>(await ed.get(`${P}/items/${old.id}`))
    expect(got).toMatchObject({ status: 'superseded', superseded_by: neu.handle })
    expect((await ed.post(`${P}/spaces/docs/items`, { title: 'D', supersedes: old.handle })).status).toBe(400)
    const mem = await createItem(db(), { projectId: s.acme.id })
    expect((await ed.post(`${P}/spaces/decisions/items`, { title: 'X', supersedes: mem.id })).status).toBe(
      400,
    )
  })
})

describe('hard delete (purge transaction)', () => {
  it('PA only, confirm with the handle; revisions and chunks go, audit stays, links dangle, status reverts', async () => {
    const victim = await mk(ed, 'memories', { title: 'Victim', type: 'fact' })
    const old = await createItem(db(), { projectId: s.acme.id })
    await ed.post(`${P}/items/${old.id}/supersede`, { new_id: victim.id })
    const linker = await mk(ed, 'docs', { title: 'Linker', body: `[[${victim.handle}]]` })
    const other = await createItem(db(), { projectId: s.acme.id })
    await ed.post(`${P}/items/${other.id}/edges`, { kind: 'refines', to: victim.id })
    await db().insert(chunks).values({
      itemId: victim.id,
      projectId: s.acme.id,
      space: 'memories',
      ordinal: 0,
      itemRevision: 1,
      text: 'Victim',
      model: 'm',
      dims: 3,
      embedding: null,
    })

    expect((await ed.delete(`${P}/items/${victim.id}?confirm=${victim.handle}`)).status).toBe(403)
    const pa = await s.login(s.pa)
    expect((await pa.delete(`${P}/items/${victim.id}?confirm=wrong`)).status).toBe(400)
    expect((await pa.delete(`${P}/items/${victim.id}?confirm=${victim.handle}`)).status).toBe(204)

    expect(await db().select().from(items).where(eq(items.id, victim.id))).toEqual([])
    expect(await db().select().from(itemRevisions).where(eq(itemRevisions.itemId, victim.id))).toEqual([])
    expect(await db().select().from(chunks).where(eq(chunks.itemId, victim.id))).toEqual([])
    expect(await wikiEdges(linker.id)).toEqual([{ dstRef: victim.handle, dstId: null }])
    expect(await db().select().from(edges).where(eq(edges.kind, 'refines'))).toEqual([])
    const reverted = (await db().select().from(items).where(eq(items.id, old.id)))[0]
    expect(reverted).toMatchObject({ status: 'active', revision: 3 })
    const [rev3] = await db()
      .select()
      .from(itemRevisions)
      .where(and(eq(itemRevisions.itemId, old.id), eq(itemRevisions.revision, 3)))
    expect(rev3).toMatchObject({ change: 'status', actorLabel: s.pa.email })
    const audit = await db().select().from(auditLog).where(eq(auditLog.action, 'item.delete'))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ itemHandle: victim.handle, itemId: victim.id })
    // append-only outside the purge transaction
    const err = await db()
      .delete(itemRevisions)
      .where(eq(itemRevisions.itemId, old.id))
      .catch((e) => e)
    expect(pgError(err)?.code).toBe('P0001')
  })

  it('shared items: deleted by a shared editor', async () => {
    const sh = await createItem(db(), { projectId: s.shared.id })
    expect((await ed.delete(`${SH}/items/${sh.id}?confirm=m${sh.number}`)).status).toBe(403)
    const se = await s.login(s.se)
    expect((await se.delete(`${SH}/items/${sh.id}?confirm=m${sh.number}`)).status).toBe(204)
    expect(await db().select().from(items).where(eq(items.id, sh.id))).toEqual([])
  })
})

describe('revisions and resolve', () => {
  it('lists newest first with cursors and returns full snapshots', async () => {
    const m = await createItem(db(), { projectId: s.acme.id, title: 'v1' })
    for (let r = 1; r <= 3; r++) await ed.patch(`${P}/items/${m.id}`, { revision: r, title: `v${r + 1}` })
    const p1 = await json<{
      items: { revision: number; actor: { label: string; via: string } }[]
      next_cursor: string
    }>(await ed.get(`${P}/items/${m.id}/revisions?limit=3`))
    expect(p1.items.map((r) => r.revision)).toEqual([4, 3, 2])
    expect(p1.items[0]?.actor).toMatchObject({ label: s.editor.email, via: 'web' })
    const p2 = await json<{ items: { revision: number }[]; next_cursor: null }>(
      await ed.get(`${P}/items/${m.id}/revisions?limit=3&cursor=${p1.next_cursor}`),
    )
    expect(p2).toMatchObject({ items: [{ revision: 1 }], next_cursor: null })
    const snap = await json<{ title: string; frontmatter: { title: string }; change: string }>(
      await ed.get(`${P}/items/${m.id}/revisions/2`),
    )
    expect(snap).toMatchObject({ title: 'v2', frontmatter: { title: 'v2' }, change: 'update' })
    expect((await ed.get(`${P}/items/${m.id}/revisions/9`)).status).toBe(404)
  })

  it('resolve uses wikilink rules', async () => {
    const mem = await mk(ed, 'memories', { title: 'Auth flow', type: 'fact' })
    const r = await json<{ item: { id: string } }>(await ed.get(`${P}/resolve?ref=Auth%20Flow`))
    expect(r.item.id).toBe(mem.id)
    const doc = await mk(ed, 'docs', { title: 'Auth flow' })
    expect((await json<{ item: { id: string } }>(await ed.get(`${P}/resolve?ref=auth-flow`))).item.id).toBe(
      doc.id,
    )
    const sh = await createItem(db(), { projectId: s.shared.id })
    await db().update(items).set({ slug: 'style-guide' }).where(eq(items.id, sh.id))
    expect(
      (await json<{ item: { handle: string } }>(await ed.get(`${P}/resolve?ref=shared:style-guide`))).item
        .handle,
    ).toBe('S:m1')
    expect((await ed.get(`${P}/resolve?ref=nothing-here`)).status).toBe(404)
    void sql
  })
})

describe('conflicts_with races (phase-2 review)', () => {
  it('concurrent relate(a, b) and relate(b, a) store one edge', async () => {
    for (let round = 0; round < 5; round++) {
      const a = await createItem(db(), { projectId: s.acme.id })
      const b = await createItem(db(), { projectId: s.acme.id })
      const add = (from: string, to: string) =>
        ed.post(`${P}/items/${from}/edges`, { kind: 'conflicts_with', to })
      const res = await Promise.all([add(a.id, b.id), add(b.id, a.id)])
      expect(res.map((r) => r.status).sort()).toEqual([200, 201])
      const rows = await db()
        .select()
        .from(edges)
        .where(and(eq(edges.kind, 'conflicts_with'), inArray(edges.srcId, [a.id, b.id])))
      expect(rows).toHaveLength(1)
    }
  })
})

describe('update with relations (deviations.md H3: one transaction)', () => {
  const mcpCaller = (user: { id: string; email: string; name: string }): Caller => {
    const project = { id: s.acme.id, slug: 'acme', kind: 'project' as const }
    const ctx: AuthContext = {
      user: { id: user.id, email: user.email, name: user.name, isAdmin: false, sharedEditor: false },
      project: { ...project, name: 'acme' },
      role: 'editor',
      via: 'bearer',
      tokenId: '00000000-0000-4000-8000-000000000001',
      clientName: 'claude-code/2.1.303',
    }
    return { ctx, via: 'mcp', project }
  }
  const typed = (srcId: string) =>
    db()
      .select({ kind: edges.kind, dstId: edges.dstId })
      .from(edges)
      .where(and(eq(edges.srcId, srcId), sql`${edges.kind} <> 'wikilink'`))

  it('content and edges commit together; relations alone add edges without a revision', async () => {
    const a = await createItem(db(), { projectId: s.acme.id })
    const b = await createItem(db(), { projectId: s.acme.id })
    const sh = await createItem(db(), { projectId: s.shared.id })
    const caller = mcpCaller(s.editor)
    const r = await s.items.update(
      caller,
      a.id,
      { revision: 1, body: 'new body' },
      {
        relations: [
          { kind: 'refines', to: b.id },
          { kind: 'supports', to: 'S:m1' },
        ],
      },
    )
    expect(r.changed).toBe(true)
    expect(r.item.revision).toBe(2)
    expect(r.relations.map((x) => [x.kind, x.to.id, x.changed])).toEqual([
      ['refines', b.id, true],
      ['supports', sh.id, true],
    ])
    expect(await typed(a.id)).toHaveLength(2)
    // the same relation again with no content change: idempotent, still revision 2
    const again = await s.items.update(
      caller,
      a.id,
      { revision: 2 },
      { relations: [{ kind: 'refines', to: b.id }] },
    )
    expect(again.changed).toBe(false)
    expect(again.item.revision).toBe(2)
    expect(again.relations.map((x) => x.changed)).toEqual([false])
    // relations only, a new edge: written, no revision
    const c = await createItem(db(), { projectId: s.acme.id })
    const only = await s.items.update(
      caller,
      a.id,
      { revision: 2 },
      { relations: [{ kind: 'depends_on', to: c.id }] },
    )
    expect(only.relations.map((x) => x.changed)).toEqual([true])
    const revs = await db().select().from(itemRevisions).where(eq(itemRevisions.itemId, a.id))
    expect(revs).toHaveLength(2)
    expect(await db().select().from(auditLog).where(eq(auditLog.action, 'edge.add'))).toHaveLength(3)
  })

  it('a failing edge write rolls the content update back; bad targets write nothing', async () => {
    const a = await createItem(db(), { projectId: s.acme.id, body: 'old body' })
    const b = await createItem(db(), { projectId: s.acme.id })
    const caller = mcpCaller(s.editor)
    // an unknown target: not_found naming the position, before anything is written
    await expect(
      s.items.update(
        caller,
        a.id,
        { revision: 1, body: 'x' },
        {
          relations: [
            { kind: 'refines', to: b.id },
            { kind: 'refines', to: 'm999' },
          ],
        },
      ),
    ).rejects.toMatchObject({ code: 'not_found', publicMessage: expect.stringContaining('relations.1.to') })
    // a self link: invalid_input, nothing written
    await expect(
      s.items.update(
        caller,
        a.id,
        { revision: 1, body: 'x' },
        { relations: [{ kind: 'refines', to: a.id }] },
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    // the edge insert fails after the content write: the whole transaction rolls back
    const spy = vi
      .spyOn(s.items as unknown as { addRelation: () => Promise<unknown> }, 'addRelation')
      .mockRejectedValueOnce(new Error('edge write failed'))
    try {
      await expect(
        s.items.update(
          caller,
          a.id,
          { revision: 1, body: 'new body' },
          { relations: [{ kind: 'refines', to: b.id }] },
        ),
      ).rejects.toThrow('edge write failed')
    } finally {
      spy.mockRestore()
    }
    const [after] = await db().select().from(items).where(eq(items.id, a.id))
    expect(after).toMatchObject({ revision: 1, body: 'old body' })
    expect(await db().select().from(itemRevisions).where(eq(itemRevisions.itemId, a.id))).toHaveLength(1)
    expect(await typed(a.id)).toHaveLength(0)
    expect(
      await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.itemId, a.id), eq(auditLog.action, 'item.update'))),
    ).toHaveLength(0)
  })
})

describe('library edges (ADR-0014)', () => {
  const agent = (): Caller => ({
    ctx: {
      user: {
        id: s.editor.id,
        email: s.editor.email,
        name: s.editor.name,
        isAdmin: false,
        sharedEditor: false,
      },
      project: { id: s.acme.id, slug: 'acme', name: 'acme', kind: 'project' },
      role: 'editor',
      via: 'bearer',
      clientName: 'claude-code/2.1.303',
    } as AuthContext,
    via: 'mcp',
    project: { id: s.acme.id, slug: 'acme', kind: 'project' },
  })
  const code = async (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e: { code?: string }) => e.code ?? 'error',
    )
  const lib = (slug: string) => createItem(db(), { projectId: s.acme.id, space: 'library', slug })

  it('m1 → L is allowed through the web and MCP; L → m1 refines only for a human with the right', async () => {
    const m = await createItem(db(), { projectId: s.acme.id })
    const page = await lib('guide')
    const other = await lib('style')
    expect((await ed.post(`${P}/items/${m.id}/edges`, { kind: 'refines', to: page.id })).status).toBe(201)
    expect(await code(s.items.relate(agent(), m.id, 'depends_on', page.id))).toBe('ok')
    const pa = await s.login(s.pa)
    expect((await pa.post(`${P}/items/${page.id}/edges`, { kind: 'refines', to: m.id })).status).toBe(201)
    expect((await pa.post(`${P}/items/${page.id}/edges`, { kind: 'supports', to: other.id })).status).toBe(
      201,
    )
    expect(await code(s.items.relate(agent(), page.id, 'refines', m.id))).toBe('read_only_space')
    // an agent may unlink from its own side, even an edge a human made
    expect(await code(s.items.relate(agent(), m.id, 'refines', page.id, true))).toBe('ok')
  })

  it('conflicts_with with a library page is wrong_space either way; so are supersedes / drafted_from into one', async () => {
    const m = await createItem(db(), { projectId: s.acme.id })
    const page = await lib('guide')
    const pa = await s.login(s.pa)
    const r1 = await pa.post(`${P}/items/${m.id}/edges`, { kind: 'conflicts_with', to: page.id })
    expect(await json(r1)).toMatchObject({ error: 'wrong_space' })
    const r2 = await pa.post(`${P}/items/${page.id}/edges`, { kind: 'conflicts_with', to: m.id })
    expect(await json(r2)).toMatchObject({ error: 'wrong_space' })
    expect(await code(s.items.relate(agent(), m.id, 'conflicts_with', page.id))).toBe('wrong_space')
    // library ↔ library conflicts are fine
    const other = await lib('style')
    expect(
      (await pa.post(`${P}/items/${page.id}/edges`, { kind: 'conflicts_with', to: other.id })).status,
    ).toBe(201)
    // the DB backstop says the same (SPL01) for every refused shape
    for (const [src, kind, dst] of [
      [m, 'supersedes', page],
      [m, 'drafted_from', page],
      [m, 'conflicts_with', page],
      [page, 'conflicts_with', m],
    ] as const) {
      const err = await db()
        .insert(edges)
        .values({ projectId: s.acme.id, srcId: src.id, kind, dstRef: dst.id, dstId: dst.id })
        .catch((e) => e)
      expect(pgError(err)?.code, kind).toBe('SPL01')
    }
    // and allows a library page's other outgoing links, wikilinks included
    for (const kind of ['refines', 'supports', 'depends_on', 'wikilink'] as const) {
      await db()
        .insert(edges)
        .values({
          projectId: s.acme.id,
          srcId: page.id,
          kind,
          dstRef: kind === 'wikilink' ? 'x' : m.id,
          dstId: m.id,
        })
    }
  })

  it('a library body resolves [[some-doc]] and [[m5]]; its dangling links are not claimed by an agent memory', async () => {
    const pa = await s.login(s.pa)
    const doc = await mk(pa, 'docs', { title: 'Some doc' })
    const m = await mk(pa, 'memories', { title: 'A fact', type: 'fact' })
    const page = await mk(pa, 'library', {
      title: 'Guide',
      body: `See [[some-doc]], [[${m.handle}]] and [[deploy-steps]].`,
    })
    expect(await wikiEdges(page.id)).toEqual([
      { dstRef: 'deploy-steps', dstId: null },
      { dstRef: m.handle, dstId: m.id },
      { dstRef: 'some-doc', dstId: doc.id },
    ])
    const res = await s.items.create(agent(), 'memories', { title: 'Deploy steps', type: 'procedure' })
    expect(res.item?.handle).toMatch(/^m\d+$/)
    expect((await wikiEdges(page.id)).find((e) => e.dstRef === 'deploy-steps')?.dstId).toBeNull()
    // a memory's own link to that slug is claimed as always
    const m2 = await mk(ed, 'memories', { title: 'Notes', type: 'fact', body: '[[runbook]]' })
    const runbook = await s.items.create(agent(), 'memories', { title: 'Runbook', type: 'procedure' })
    expect(await wikiEdges(m2.id)).toEqual([{ dstRef: 'runbook', dstId: runbook.item?.id }])
  })

  it('a memory link resolved to a library page is not taken over by a later same-slug memory', async () => {
    const pa = await s.login(s.pa)
    const page = await mk(pa, 'library', { title: 'Guide' })
    const m = await mk(ed, 'memories', { title: 'Uses guide', type: 'fact', body: '[[guide]]' })
    expect(await wikiEdges(m.id)).toEqual([{ dstRef: 'guide', dstId: page.id }])
    await mk(ed, 'memories', { title: 'Guide', type: 'fact' })
    expect(await wikiEdges(m.id)).toEqual([{ dstRef: 'guide', dstId: page.id }])
  })

  it('resolve?from=library ranks a library page first and still resolves other spaces', async () => {
    const pa = await s.login(s.pa)
    const doc = await mk(pa, 'docs', { title: 'Guide' })
    const page = await mk(pa, 'library', { title: 'Guide' })
    const mem = await mk(pa, 'memories', { title: 'Only memory', type: 'fact' })
    const get = async (q: string) =>
      (await json<{ item: { id: string } }>(await pa.get(`${P}/resolve?${q}`))).item.id
    expect(await get('ref=guide&from=library')).toBe(page.id)
    expect(await get('ref=guide')).toBe(page.id)
    expect(await get('ref=only-memory&from=library')).toBe(mem.id)
    expect(await get(`ref=${doc.handle}&from=library`)).toBe(doc.id)
    expect((await pa.get(`${P}/resolve?ref=guide&from=nowhere`)).status).toBe(400)
  })
})
