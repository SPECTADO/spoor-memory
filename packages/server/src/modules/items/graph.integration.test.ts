// The project graph (`GET …/graph`, ADR-0021): filters, ghosts, dangling edges, focus walk, truncation and
// visibility of shared backlinks, through the assembled app (truncation through the service with a low cap).
import type { GraphResponse } from '@spoor/shared'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
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
import { edges, items } from '../../db/schema.js'
import type { AuthContext } from '../../lib/auth-context.js'
import { graphQuery } from './schemas.js'
import type { Caller } from './writes.js'

const db = () => testDb()

async function seed() {
  const { app, modules } = testApp({ ports: stubPorts() })
  const shared = await createSharedProject(db())
  const acme = await createProject(db(), { slug: 'acme' })
  const third = await createProject(db(), { slug: 'third' })
  const editor = await createUser(db())
  const outsider = await createUser(db())
  const ia = await createAdmin(db())
  await addMember(db(), acme.id, editor.id, 'editor')
  const login = (u: { email: string; password: string }) => loginAs(app, u.email, u.password)
  return { app, items: modules.items.items, shared, acme, third, editor, outsider, ia, login }
}

let s: Awaited<ReturnType<typeof seed>>
let ed: Client
beforeEach(async () => {
  s = await seed()
  ed = await s.login(s.editor)
})

const P = '/api/v1/projects/acme'
const SH = '/api/v1/projects/_shared'

type Kind = (typeof edges.$inferInsert)['kind']
const link = async (src: { id: string; projectId: string }, kind: Kind, dst: { id: string } | string) => {
  const [e] = await db()
    .insert(edges)
    .values({
      projectId: src.projectId,
      srcId: src.id,
      kind,
      dstRef: typeof dst === 'string' ? dst : dst.id,
      dstId: typeof dst === 'string' ? null : dst.id,
    })
    .returning()
  return e as typeof edges.$inferSelect
}
const setItem = (id: string, v: Partial<typeof items.$inferInsert>) =>
  db().update(items).set(v).where(eq(items.id, id))

/** The editor as a service caller in acme (for the low-cap tests that go through the service). */
const editorCaller = (): Caller => ({
  ctx: {
    user: { id: s.editor.id, email: s.editor.email, name: 'e', isAdmin: false, sharedEditor: false },
    project: { id: s.acme.id, slug: 'acme', name: 'acme', kind: 'project' },
    role: 'editor',
    via: 'cookie',
  } as AuthContext,
  via: 'web',
  project: { id: s.acme.id, slug: 'acme', kind: 'project' },
})

const graph = async (c: Client, query = '', base = P) => {
  const r = await c.get(`${base}/graph${query}`)
  expect(r.status, await r.clone().text()).toBe(200)
  return json<GraphResponse>(r)
}
const byId = (g: GraphResponse) => new Map(g.nodes.map((n) => [n.id, n]))
const ids = (nodes: { id: string }[]) => nodes.map((n) => n.id).sort()

/** a refines b; a supports sup (superseded); a depends_on arch (archived); doc → [[nowhere]]; lonely. */
async function project() {
  const a = await createItem(db(), { projectId: s.acme.id, title: 'A', pinned: true })
  const b = await createItem(db(), { projectId: s.acme.id, title: 'B' })
  const lonely = await createItem(db(), { projectId: s.acme.id, title: 'Lonely' })
  const sup = await createItem(db(), { projectId: s.acme.id, title: 'Sup', status: 'superseded' })
  const arch = await createItem(db(), { projectId: s.acme.id, title: 'Arch' })
  await setItem(arch.id, { lifecycle: 'archived', archivedAt: new Date(), archiveReason: 'manual' })
  const doc = await createItem(db(), { projectId: s.acme.id, space: 'docs', title: 'Doc' })
  const ab = await link(a, 'refines', b)
  await link(a, 'supports', sup)
  await link(a, 'depends_on', arch)
  const dangling = await link(doc, 'wikilink', 'nowhere')
  return { a, b, lonely, sup, arch, doc, ab, dangling }
}

describe('GET /api/v1/projects/:slug/graph', () => {
  it('default filters: active+stale core, superseded and archived ends are ghosts, dangling edges carry dst_ref', async () => {
    const t = await project()
    const g = await graph(ed)
    const n = byId(g)
    expect(ids(g.nodes.filter((x) => !x.ghost))).toEqual(ids([t.a, t.b, t.lonely, t.doc]))
    expect(ids(g.nodes.filter((x) => x.ghost))).toEqual(ids([t.sup, t.arch]))
    // core first (memories, then docs, by number), ghosts after
    expect(g.nodes.map((x) => x.title)).toEqual(['A', 'B', 'Lonely', 'Doc', 'Sup', 'Arch'])
    expect(n.get(t.a.id)).toMatchObject({
      handle: `m${t.a.number}`,
      project: 'acme',
      space: 'memories',
      pinned: true,
      degree_out: 3,
      degree_in: 0,
      ghost: false,
    })
    expect(n.get(t.b.id)).toMatchObject({ degree_in: 1, degree_out: 0 })
    expect(n.get(t.doc.id)).toMatchObject({ handle: `d${t.doc.number}`, degree_out: 1 })
    expect(n.get(t.sup.id)).toMatchObject({ ghost: true, status: 'superseded', degree_in: 1 })
    expect(g.edges).toHaveLength(4)
    expect(g.edges.find((e) => e.id === t.ab.id)).toEqual({
      id: t.ab.id,
      kind: 'refines',
      src: t.a.id,
      dst: t.b.id,
      editable: true,
    })
    expect(g.edges.find((e) => e.id === t.dangling.id)).toEqual({
      id: t.dangling.id,
      kind: 'wikilink',
      src: t.doc.id,
      dst: null,
      dst_ref: 'nowhere',
      editable: false,
    })
    expect(g.meta).toEqual({
      truncated: false,
      node_cap: 1500,
      total_nodes: 6,
      unlinked_count: 1,
      dangling_count: 1,
    })
  })

  it('kinds, include_superseded, lifecycle and spaces filters', async () => {
    const t = await project()
    const refines = await graph(ed, '?kinds=refines')
    expect(refines.edges.map((e) => e.id)).toEqual([t.ab.id])
    expect(refines.nodes.some((x) => x.ghost)).toBe(false)
    expect(refines.meta).toMatchObject({ unlinked_count: 2, dangling_count: 0 })

    const withSup = await graph(ed, '?include_superseded=true')
    expect(byId(withSup).get(t.sup.id)?.ghost).toBe(false)
    expect(byId(withSup).get(t.arch.id)?.ghost).toBe(true)

    const withArch = await graph(ed, '?lifecycle=active,stale,archived')
    expect(byId(withArch).get(t.arch.id)?.ghost).toBe(false)

    // docs only: a, b are outside; a's edges have no core end and go; the doc keeps its dangling edge
    const docs = await graph(ed, '?spaces=docs')
    expect(docs.nodes.map((x) => x.id)).toEqual([t.doc.id])
    expect(docs.edges.map((e) => e.id)).toEqual([t.dangling.id])
  })

  it('a shared target is a ghost with an S: handle; _shared shows member projects’ backlinks only', async () => {
    const a = await createItem(db(), { projectId: s.acme.id, title: 'A' })
    const sh = await createItem(db(), { projectId: s.shared.id, space: 'library', title: 'Baseline' })
    const fromThird = await createItem(db(), { projectId: s.third.id, title: 'Third' })
    await link(a, 'supports', sh)
    await link(fromThird, 'supports', sh)
    await createItem(db(), { projectId: s.shared.id, title: 'Unrelated shared' })

    const g = await graph(ed)
    expect(g.nodes).toHaveLength(2) // the rest of _shared is not loaded
    expect(byId(g).get(sh.id)).toMatchObject({
      handle: `S:L${sh.number}`,
      project: '_shared',
      space: 'library',
      ghost: true,
      degree_in: 1,
    })

    const shared = await graph(ed, '', SH)
    const sn = byId(shared)
    expect(sn.get(sh.id)).toMatchObject({ handle: `L${sh.number}`, ghost: false, degree_in: 1 })
    expect(sn.get(a.id)).toMatchObject({ handle: `m${a.number}`, project: 'acme', ghost: true })
    expect(sn.has(fromThird.id)).toBe(false)
    expect(shared.meta.unlinked_count).toBe(1)

    const admin = await graph(await s.login(s.ia), '', SH)
    expect(byId(admin).get(fromThird.id)).toMatchObject({ project: 'third', ghost: true })
    expect(byId(admin).get(sh.id)?.degree_in).toBe(2)
  })

  it('focus: depth 1 vs 2, ghosts are not walked through, both directions', async () => {
    const x = await createItem(db(), { projectId: s.acme.id, title: 'X' })
    const y = await createItem(db(), { projectId: s.acme.id, title: 'Y' })
    const z = await createItem(db(), { projectId: s.acme.id, title: 'Z' })
    const w = await createItem(db(), { projectId: s.acme.id, title: 'W' })
    const far = await createItem(db(), { projectId: s.acme.id, title: 'Far' })
    const old = await createItem(db(), { projectId: s.acme.id, title: 'Old', status: 'superseded' })
    const behind = await createItem(db(), { projectId: s.acme.id, title: 'Behind' })
    await link(x, 'refines', y)
    await link(w, 'supports', y) // incoming to y: reached at hop 2 from x
    await link(y, 'depends_on', z)
    await link(z, 'refines', far) // hop 3: never shown
    await link(x, 'conflicts_with', old)
    await link(old, 'refines', behind) // behind a ghost: not reached
    const zw = await link(z, 'supports', w) // between two hop-2 nodes: kept

    const one = await graph(ed, `?focus=m${x.number}&depth=1`)
    expect(ids(one.nodes)).toEqual(ids([x, y, old]))
    expect(byId(one).get(old.id)?.ghost).toBe(true)
    expect(one.edges).toHaveLength(2)

    const two = await graph(ed, `?focus=${x.id}`)
    expect(ids(two.nodes)).toEqual(ids([x, y, z, w, old]))
    expect(two.edges.map((e) => e.id)).toContain(zw.id)
    expect(two.edges).toHaveLength(5)
    expect(byId(two).get(z.id)).toMatchObject({ degree_in: 1, degree_out: 1, ghost: false })

    // a focus item outside the filters is still core
    const fromOld = await graph(ed, `?focus=m${old.number}&depth=1`)
    expect(byId(fromOld).get(old.id)?.ghost).toBe(false)
    expect(ids(fromOld.nodes)).toEqual(ids([old, x, behind]))

    expect((await ed.get(`${P}/graph?focus=m999`)).status).toBe(404)
    await createItem(db(), { projectId: s.acme.id, slug: 'twin' })
    await createItem(db(), { projectId: s.acme.id, space: 'docs', slug: 'twin' })
    expect((await ed.get(`${P}/graph?focus=twin`)).status).toBe(409)
  })

  it('truncation keeps core before ghosts, then pinned and degree; ghosts left without edges go', async () => {
    const hub = await createItem(db(), { projectId: s.acme.id, title: 'Hub' })
    const pinned = await createItem(db(), { projectId: s.acme.id, title: 'Pinned', pinned: true })
    const leaf = await createItem(db(), { projectId: s.acme.id, title: 'Leaf' })
    const lone = await createItem(db(), { projectId: s.acme.id, title: 'Lone' })
    const ghost = await createItem(db(), { projectId: s.acme.id, title: 'Ghost', status: 'superseded' })
    await link(hub, 'refines', leaf)
    await link(hub, 'supports', ghost)
    const caller = editorCaller()
    const g = await s.items.graph(caller, graphQuery.parse({}), [s.acme.id], 3)
    // core: pinned first, then hub (degree 2), then leaf (degree 1) over lone (0); the ghost is cut
    expect(ids(g.nodes)).toEqual(ids([pinned, hub, leaf]))
    expect(g.edges).toHaveLength(1)
    expect(byId(g).get(hub.id)?.degree_out).toBe(2) // degree is counted before the cap
    expect(g.meta).toEqual({
      truncated: true,
      node_cap: 3,
      total_nodes: 5,
      unlinked_count: 2,
      dangling_count: 0,
    })

    // unlinked: the degree-0 core nodes are picked before the cap, so they are not cut first
    // (without it, pinned, hub and leaf all rank above them)
    await link(pinned, 'refines', hub)
    const lone2 = await createItem(db(), { projectId: s.acme.id, title: 'Lone 2' })
    const capped = await s.items.graph(caller, graphQuery.parse({}), [s.acme.id], 2)
    expect(ids(capped.nodes)).toEqual(ids([pinned, hub]))
    const u = await s.items.graph(caller, graphQuery.parse({ unlinked: 'true' }), [s.acme.id], 2)
    expect(ids(u.nodes)).toEqual(ids([lone, lone2]))
    expect(u.edges).toEqual([])
    expect(u.meta).toEqual({
      truncated: false,
      node_cap: 2,
      total_nodes: 6,
      unlinked_count: 2,
      dangling_count: 0,
    })
    const u1 = await s.items.graph(caller, graphQuery.parse({ unlinked: 'true' }), [s.acme.id], 1)
    expect(u1.nodes).toHaveLength(1)
    expect(u1.meta).toMatchObject({ truncated: true, total_nodes: 6, unlinked_count: 2 })
  })

  it('truncation in focus mode: the focus node always stays, even unpinned and low-degree', async () => {
    const focus = await createItem(db(), { projectId: s.acme.id, title: 'Focus' })
    const pinned = await createItem(db(), { projectId: s.acme.id, title: 'Pinned', pinned: true })
    const hub = await createItem(db(), { projectId: s.acme.id, title: 'Hub' })
    const leaf = await createItem(db(), { projectId: s.acme.id, title: 'Leaf' })
    const pf = await link(pinned, 'refines', focus)
    await link(hub, 'supports', focus)
    await link(hub, 'refines', leaf)
    await link(hub, 'depends_on', pinned)
    const caller = editorCaller()
    const q = graphQuery.parse({ focus: `m${focus.number}`, depth: '1' })

    const one = await s.items.graph(caller, q, [s.acme.id], 1)
    expect(one.nodes.map((x) => x.id)).toEqual([focus.id])
    expect(one.edges).toEqual([])
    expect(one.meta).toMatchObject({ truncated: true, node_cap: 1, total_nodes: 3 })

    // cap 2: focus, then pinned over hub (higher degree)
    const two = await s.items.graph(caller, q, [s.acme.id], 2)
    expect(ids(two.nodes)).toEqual(ids([focus, pinned]))
    expect(two.edges.map((e) => e.id)).toEqual([pf.id])
    expect(two.meta).toMatchObject({ truncated: true, node_cap: 2, total_nodes: 3 })
  })

  it('unlinked=true: only the degree-0 core nodes, no edges or ghosts, meta of the full graph', async () => {
    const t = await project()
    const full = await graph(ed)
    const g = await graph(ed, '?unlinked=true')
    expect(g.nodes.map((x) => x.id)).toEqual([t.lonely.id])
    expect(g.nodes[0]).toMatchObject({ ghost: false, degree_in: 0, degree_out: 0 })
    expect(g.edges).toEqual([])
    expect(g.meta).toEqual(full.meta)
    expect(g.meta).toMatchObject({ total_nodes: 6, unlinked_count: 1, dangling_count: 1 })
    // with other filters: under kinds=refines, doc (only a wikilink) and lonely are unlinked
    const refines = await graph(ed, '?kinds=refines&unlinked=true')
    expect(ids(refines.nodes)).toEqual(ids([t.lonely, t.doc]))
    expect((await graph(ed, '?unlinked=false')).nodes).toHaveLength(6)
  })

  it('dangling_count counts distinct dst_ref', async () => {
    const x = await createItem(db(), { projectId: s.acme.id, space: 'docs', title: 'X' })
    const y = await createItem(db(), { projectId: s.acme.id, space: 'docs', title: 'Y' })
    await link(x, 'wikilink', 'nowhere')
    await link(y, 'wikilink', 'nowhere')
    await link(x, 'wikilink', 'elsewhere')
    const g = await graph(ed)
    expect(g.edges).toHaveLength(3)
    expect(g.meta.dangling_count).toBe(2)
  })

  it('focus on a shared item from a project: its shared neighbours are ghosts at hop 1; the map is unchanged', async () => {
    const a = await createItem(db(), { projectId: s.acme.id, title: 'A' })
    const sh = await createItem(db(), { projectId: s.shared.id, title: 'Shared' })
    const base = await createItem(db(), { projectId: s.shared.id, title: 'Base' })
    const other = await createItem(db(), { projectId: s.shared.id, title: 'Other' })
    const aSh = await link(a, 'supports', sh)
    const shBase = await link(sh, 'refines', base)
    await link(sh, 'depends_on', other)
    await link(base, 'refines', other) // between two ghosts: dropped
    await link(a, 'refines', base) // a ghost-to-ghost path through the project is not walked

    const f = await graph(ed, `?focus=S:m${sh.number}&depth=1`)
    const n = byId(f)
    expect(ids(f.nodes)).toEqual(ids([sh, base, other, a]))
    expect(n.get(sh.id)).toMatchObject({
      handle: `S:m${sh.number}`,
      ghost: false,
      degree_out: 2,
      degree_in: 1,
    })
    expect(n.get(base.id)).toMatchObject({ handle: `S:m${base.number}`, project: '_shared', ghost: true })
    expect(n.get(a.id)).toMatchObject({ ghost: false })
    expect(f.edges.map((e) => e.id)).toContain(shBase.id)
    expect(f.edges.map((e) => e.id)).toContain(aSh.id)
    // base→other (two ghosts) is dropped; a→base is kept (a is core)
    expect(f.edges).toHaveLength(4)
    expect(f.edges.some((e) => e.src === base.id && e.dst === other.id)).toBe(false)

    // the whole-project map: shared-to-shared edges never show (both ends are ghosts)
    const map = await graph(ed)
    expect(ids(map.nodes)).toEqual(ids([a, sh, base]))
    expect(map.edges.map((e) => e.src)).toEqual([a.id, a.id])
    expect(byId(map).get(sh.id)?.degree_out).toBe(0)
  })

  it('a kept edge between two ghosts is dropped in focus mode', async () => {
    const x = await createItem(db(), { projectId: s.acme.id, title: 'X' })
    const old1 = await createItem(db(), { projectId: s.acme.id, title: 'Old 1', status: 'superseded' })
    const old2 = await createItem(db(), { projectId: s.acme.id, title: 'Old 2', status: 'superseded' })
    await link(x, 'refines', old1)
    await link(x, 'refines', old2)
    const between = await link(old1, 'supports', old2)
    const g = await graph(ed, `?focus=m${x.number}`)
    expect(ids(g.nodes)).toEqual(ids([x, old1, old2]))
    expect(g.edges).toHaveLength(2)
    expect(g.edges.map((e) => e.id)).not.toContain(between.id)
    expect(byId(g).get(old1.id)).toMatchObject({ ghost: true, degree_out: 0 })
  })

  it('_shared focus: backlinks only from member projects; an outsider sees no project ghosts', async () => {
    const sh = await createItem(db(), { projectId: s.shared.id, space: 'library', title: 'Baseline' })
    const a = await createItem(db(), { projectId: s.acme.id, title: 'A' })
    const fromThird = await createItem(db(), { projectId: s.third.id, title: 'Third' })
    await link(a, 'supports', sh)
    await link(fromThird, 'supports', sh)

    const f = await graph(ed, `?focus=L${sh.number}&depth=2`, SH)
    expect(ids(f.nodes)).toEqual(ids([sh, a]))
    expect(byId(f).get(sh.id)?.degree_in).toBe(1)

    const admin = await graph(await s.login(s.ia), `?focus=L${sh.number}`, SH)
    expect(ids(admin.nodes)).toEqual(ids([sh, a, fromThird]))

    const out = await s.login(s.outsider)
    const whole = await graph(out, '', SH)
    expect(whole.nodes.map((x) => x.id)).toEqual([sh.id])
    expect(whole.edges).toEqual([])
    expect(whole.meta.unlinked_count).toBe(1)
    const focused = await graph(out, `?focus=L${sh.number}`, SH)
    expect(focused.nodes.map((x) => x.id)).toEqual([sh.id])
  })

  it('access and validation: non-members 404, bad queries 400', async () => {
    const out = await s.login(s.outsider)
    expect((await out.get(`${P}/graph`)).status).toBe(404)
    expect((await out.get(`${SH}/graph`)).status).toBe(200)
    expect((await s.app.request(`${P}/graph`)).status).toBe(401)
    for (const q of [
      '?depth=1',
      '?kinds=bogus',
      '?spaces=x',
      '?lifecycle=gone',
      '?include_superseded=1',
      '?unlinked=1',
      '?unlinked=true&focus=m1',
      '?x=1',
    ])
      expect((await ed.get(`${P}/graph${q}`)).status, q).toBe(400)
  })
})
