// Item service and routes: create, update (revision check), get, list, operational actions, lifecycle,
// provenance, last_used, dedupe, chunks, shared-space write rule (data-model.md 3 and 6, api.md 5,
// cleanup-and-jobs.md 1 to 3, search-and-digest.md 5, auth-and-security.md 7 and 13).
import { and, eq, sql } from 'drizzle-orm'
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
import { MemoryJobsPort, stubPorts } from '../../../test/ports.js'
import { auditLog, itemRevisions, items, projects } from '../../db/schema.js'
import type { AuthContext } from '../../lib/auth-context.js'
import type { DbOrTx, Tx } from '../../lib/db.js'
import { ApiError } from '../../lib/errors.js'
import type {
  ChunkSource,
  DedupeCandidate,
  DedupeQuery,
  IndexedItem,
  PreparedChunks,
  SearchPort,
} from '../../ports.js'
import type { Caller } from './writes.js'

const db = () => testDb()

class FakeSearch implements SearchPort {
  failPrepare = false
  prepared: ChunkSource[] = []
  dedupeCalls: DedupeQuery[] = []
  candidates: DedupeCandidate[] = []
  skipped = false
  calls: { item: IndexedItem; pending: boolean }[] = []
  async prepareChunks(source: ChunkSource): Promise<PreparedChunks> {
    if (this.failPrepare) throw new Error('provider down')
    this.prepared.push(source)
    return { source, models: ['fake'], chunks: [], pending: false }
  }
  async dedupeCandidates(_db: DbOrTx, q: DedupeQuery) {
    this.dedupeCalls.push(q)
    return { candidates: this.candidates, skipped: this.skipped }
  }
  async indexItemChunks(_tx: Tx, item: IndexedItem, prepared: PreparedChunks) {
    this.calls.push({ item, pending: prepared.pending })
    return { embeddingPending: prepared.pending }
  }
  async relatedCandidates() {
    return { candidates: [], pending: true }
  }
}

async function seed() {
  const search = new FakeSearch()
  const jobs = new MemoryJobsPort()
  const { app, modules } = testApp({ ports: stubPorts({ search, jobs }) })
  const module = modules.items
  const shared = await createSharedProject(db())
  const acme = await createProject(db(), { slug: 'acme', settings: { cleanup: { observation_days: 3 } } })
  const editor = await createUser(db())
  const viewer = await createUser(db())
  const pa = await createUser(db())
  const se = await createUser(db(), { sharedEditor: true })
  const outsider = await createUser(db())
  await addMember(db(), acme.id, editor.id, 'editor')
  await addMember(db(), acme.id, viewer.id, 'viewer')
  await addMember(db(), acme.id, pa.id, 'admin')
  const login = (u: { email: string; password: string }) => loginAs(app, u.email, u.password)
  return { app, items: module.items, search, jobs, shared, acme, editor, viewer, pa, se, outsider, login }
}

let s: Awaited<ReturnType<typeof seed>>
let ed: Client
beforeEach(async () => {
  s = await seed()
  ed = await s.login(s.editor)
})

const P = '/api/v1/projects/acme'
const create = (c: Client, space: string, body: Record<string, unknown>, project = 'acme') =>
  c.post(`/api/v1/projects/${project}/spaces/${space}/items`, body)

/** A service-level caller as the MCP tools build it. */
function mcpCaller(
  user: { id: string; email: string; name: string },
  project: { id: string; slug: string; kind: 'project' | 'shared' },
): Caller {
  const ctx: AuthContext = {
    user: { id: user.id, email: user.email, name: user.name, isAdmin: false, sharedEditor: false },
    project: { ...project, name: project.slug },
    role: 'editor',
    via: 'bearer',
    tokenId: '00000000-0000-4000-8000-000000000001',
    clientName: 'claude-code/2.1.303',
  }
  return { ctx, via: 'mcp', project }
}

const row = async (id: string) =>
  (await db().select().from(items).where(eq(items.id, id)))[0] as typeof items.$inferSelect

describe('create', () => {
  it('a memory: handle, revision 1, provenance human, audit, chunks indexed', async () => {
    const res = await create(ed, 'memories', {
      title: 'Sessions live in Postgres',
      type: 'fact',
      tags: ['auth'],
    })
    expect(res.status).toBe(201)
    const { item, warnings } = await json<{ item: Record<string, unknown>; warnings: unknown[] }>(res)
    expect(item).toMatchObject({
      handle: 'm1',
      project: 'acme',
      space: 'memories',
      slug: 'sessions-live-in-postgres',
      type: 'fact',
      confidence: 'medium',
      status: 'active',
      lifecycle: 'active',
      revision: 1,
      provenance: 'human',
      client_name: 'web',
      updated_by: s.editor.email,
      created_by: { id: s.editor.id, label: s.editor.email },
      superseded_by: null,
    })
    expect(warnings).toEqual([])
    const revs = await db()
      .select()
      .from(itemRevisions)
      .where(eq(itemRevisions.itemId, item.id as string))
    expect(revs).toHaveLength(1)
    expect(revs[0]).toMatchObject({ revision: 1, change: 'create', via: 'web', actorLabel: s.editor.email })
    expect(revs[0]?.frontmatter).toMatchObject({
      spoor_id: item.id,
      title: 'Sessions live in Postgres',
      type: 'fact',
      tags: ['auth'],
    })
    const audit = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.itemId, item.id as string))
    expect(audit.map((a) => [a.action, a.itemHandle, a.via])).toEqual([['item.create', 'm1', 'web']])
    expect(s.search.calls).toEqual([
      { item: { id: item.id, projectId: s.acme.id, space: 'memories', revision: 1 }, pending: false },
    ])
  })

  it('observations expire after the project observation_days', async () => {
    const res = await create(ed, 'memories', { title: 'CI is flaky today', type: 'observation' })
    const { item } = await json<{ item: { id: string } }>(res)
    const [{ days }] = (
      await db().execute<{ days: number }>(
        sql`SELECT extract(epoch FROM (expires_at - now())) / 86400 AS days FROM items WHERE id = ${item.id}`,
      )
    ).rows as [{ days: number }]
    expect(Number(days)).toBeGreaterThan(2.99)
    expect(Number(days)).toBeLessThan(3.01)
  })

  it('validates per space and cleans one-line text', async () => {
    expect((await create(ed, 'memories', { title: 'no type' })).status).toBe(400)
    expect((await create(ed, 'docs', { title: 'Doc', type: 'fact' })).status).toBe(400)
    expect((await create(ed, 'memories', { title: 'x', type: 'fact', tags: ['Bad Tag'] })).status).toBe(400)
    expect((await create(ed, 'memories', { title: 'x', type: 'fact', anchors: ['../etc'] })).status).toBe(400)
    expect((await create(ed, 'memories', { title: '‮\u0007', type: 'fact' })).status).toBe(400)
    expect((await create(ed, 'nope', { title: 'x' })).status).toBe(404)
    const r = await create(ed, 'memories', {
      title: 'Line‮ one\u0007',
      type: 'fact',
      anchors: ['./src//auth/', 'src/**/**/x.ts'],
      extra: { owner: 'ann' },
    })
    const { item } = await json<{ item: Record<string, unknown> }>(r)
    expect(item).toMatchObject({
      title: 'Line one',
      anchors: ['src/auth/', 'src/**/x.ts'],
      extra: { owner: 'ann' },
    })
    expect((await create(ed, 'memories', { title: 'x', type: 'fact', extra: { title: 'dup' } })).status).toBe(
      400,
    )
  })

  it('slugs: derived with -2 on collision, explicit must be free, reserved shapes', async () => {
    const a = await json<{ item: { slug: string } }>(await create(ed, 'docs', { title: 'Auth flow' }))
    const b = await json<{ item: { slug: string } }>(await create(ed, 'docs', { title: 'Auth flow' }))
    expect([a.item.slug, b.item.slug]).toEqual(['auth-flow', 'auth-flow-2'])
    // same slug in another space is fine
    expect(
      (
        await json<{ item: { slug: string } }>(
          await create(ed, 'memories', { title: 'Auth flow', type: 'fact' }),
        )
      ).item.slug,
    ).toBe('auth-flow')
    const taken = await create(ed, 'docs', { title: 'Other', slug: 'auth-flow' })
    expect(taken.status).toBe(409)
    expect(await json(taken)).toMatchObject({ error: 'slug_taken', details: { handle: 'd1', revision: 1 } })
    expect((await create(ed, 'docs', { title: 'X', slug: 'm42' })).status).toBe(400)
    expect((await create(ed, 'docs', { title: 'X', slug: 'Not A Slug' })).status).toBe(400)
    expect(
      (await json<{ item: { slug: string } }>(await create(ed, 'docs', { title: 'ADR-7' }))).item.slug,
    ).toBe('x-adr-7')
  })

  it('decisions: ADR numbering, explicit numbers, collisions, defaults', async () => {
    const one = await json<{ item: Record<string, unknown> }>(
      await create(ed, 'decisions', { title: 'Use Postgres' }),
    )
    expect(one.item).toMatchObject({
      handle: 'ADR-0001',
      adr_number: 1,
      status: 'proposed',
      type: null,
      confidence: null,
    })
    expect(one.item.decided_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const five = await json<{ item: Record<string, unknown> }>(
      await create(ed, 'decisions', {
        title: 'Five',
        adr_number: 5,
        status: 'accepted',
        decided_on: '2026-01-02',
      }),
    )
    expect(five.item).toMatchObject({ handle: 'ADR-0005', status: 'accepted', decided_on: '2026-01-02' })
    const next = await json<{ item: Record<string, unknown> }>(
      await create(ed, 'decisions', { title: 'Next' }),
    )
    expect(next.item.handle).toBe('ADR-0006')
    const clash = await create(ed, 'decisions', { title: 'Clash', adr_number: 5 })
    expect(clash.status).toBe(409)
    expect(await json(clash)).toMatchObject({ error: 'already_exists', details: { handle: 'ADR-0005' } })
    // numbers are never reused, and m/d numbers come from one counter
    const [p] = await db().select().from(projects).where(eq(projects.id, s.acme.id))
    expect(p).toMatchObject({ nextAdrNumber: 7 })
    expect((await create(ed, 'decisions', { title: 'Bad', adr_number: 100000 })).status).toBe(400)
    expect((await create(ed, 'memories', { title: 'x', type: 'fact', adr_number: 3 })).status).toBe(400)
  })

  it('roles: viewer 403, outsider 404', async () => {
    const v = await s.login(s.viewer)
    expect((await create(v, 'memories', { title: 'x', type: 'fact' })).status).toBe(403)
    const o = await s.login(s.outsider)
    expect((await create(o, 'memories', { title: 'x', type: 'fact' })).status).toBe(404)
    expect((await v.get(`${P}/spaces/memories/items`)).status).toBe(200)
  })
})

describe('update', () => {
  it('requires the revision; a mismatch is revision_conflict with the current item; nothing written', async () => {
    const m = await createItem(db(), { projectId: s.acme.id, title: 'Old' })
    const missing = await ed.patch(`${P}/items/m${m.number}`, { title: 'New' })
    expect(missing.status).toBe(400)
    expect((await json(missing)).error).toBe('revision_required')
    const ok = await ed.patch(`${P}/items/m${m.number}`, { revision: 1, title: 'New', body: 'b' })
    expect(ok.status).toBe(200)
    expect((await json<{ item: Record<string, unknown> }>(ok)).item).toMatchObject({
      title: 'New',
      revision: 2,
      body: 'b',
    })
    const stale = await ed.patch(`${P}/items/m${m.number}`, { revision: 1, title: 'Lost' })
    expect(stale.status).toBe(409)
    const body = await json<{
      error: string
      details: { current_revision: number; current: { title: string } }
    }>(stale)
    expect(body.error).toBe('revision_conflict')
    expect(body.details.current_revision).toBe(2)
    expect(body.details.current.title).toBe('New')
    expect((await row(m.id)).title).toBe('New')
    const revs = await db().select().from(itemRevisions).where(eq(itemRevisions.itemId, m.id))
    expect(revs.map((r) => [r.revision, r.change])).toEqual([
      [1, 'create'],
      [2, 'update'],
    ])
  })

  it('immutable fields are rejected; identical content is a no-op', async () => {
    const m = await createItem(db(), { projectId: s.acme.id, title: 'Same' })
    for (const f of [{ slug: 'x' }, { space: 'docs' }, { number: 9 }, { adr_number: 3 }]) {
      expect((await ed.patch(`${P}/items/${m.id}`, { revision: 1, ...f })).status).toBe(400)
    }
    const r = await ed.patch(`${P}/items/${m.id}`, { revision: 1, title: 'Same' })
    expect((await json<{ item: { revision: number } }>(r)).item.revision).toBe(1)
  })

  it('a stale item becomes active; type to observation sets expires_at, away clears it', async () => {
    const m = await createItem(db(), { projectId: s.acme.id })
    await db().update(items).set({ lifecycle: 'stale', staleSince: sql`now()` }).where(eq(items.id, m.id))
    await ed.patch(`${P}/items/${m.id}`, { revision: 1, type: 'observation' })
    let r = await row(m.id)
    expect(r).toMatchObject({ lifecycle: 'active', staleSince: null, type: 'observation' })
    expect(r.expiresAt).not.toBeNull()
    const firstExpiry = r.expiresAt?.getTime()
    await ed.patch(`${P}/items/${m.id}`, { revision: 2, body: 'still an observation' })
    expect((await row(m.id)).expiresAt?.getTime()).toBe(firstExpiry)
    await ed.patch(`${P}/items/${m.id}`, { revision: 3, type: 'fact' })
    r = await row(m.id)
    expect(r.expiresAt).toBeNull()
  })

  it('space rules: type only on memories, status per space', async () => {
    const d = await createItem(db(), { projectId: s.acme.id, space: 'docs' })
    expect((await ed.patch(`${P}/items/${d.id}`, { revision: 1, type: 'fact' })).status).toBe(400)
    expect((await ed.patch(`${P}/items/${d.id}`, { revision: 1, status: 'accepted' })).status).toBe(400)
    const a = await createItem(db(), { projectId: s.acme.id, space: 'decisions' })
    const r = await ed.patch(`${P}/items/${a.id}`, {
      revision: 1,
      status: 'accepted',
      decided_on: '2026-02-03',
    })
    expect((await json<{ item: Record<string, unknown> }>(r)).item).toMatchObject({
      status: 'accepted',
      decided_on: '2026-02-03',
    })
  })

  it('mirrored items: web edit saved with a warning; an MCP edit is refused', async () => {
    const d = await createItem(db(), { projectId: s.acme.id, space: 'docs' })
    await db().update(items).set({ sourcePath: 'ARCHITECTURE.md' }).where(eq(items.id, d.id))
    const r = await ed.patch(`${P}/items/${d.id}`, { revision: 1, body: 'web edit' })
    expect(await json(r)).toMatchObject({
      warnings: [{ code: 'mirrored_item', source_path: 'ARCHITECTURE.md' }],
    })
    const caller = mcpCaller(s.editor, { id: s.acme.id, slug: 'acme', kind: 'project' })
    // an ApiError like every other refusal (review C9): any HTTP path that lets it escape renders 409
    await expect(s.items.update(caller, d.id, { revision: 2, body: 'agent edit' })).rejects.toMatchObject({
      code: 'mirrored_item',
      status: 409,
      details: { source_path: 'ARCHITECTURE.md' },
    })
    await expect(
      s.items.update(caller, d.id, { revision: 2, body: 'x' }, { expectSpace: 'memories' }),
    ).rejects.toMatchObject({
      code: 'wrong_space',
    })
  })
})

describe('provenance and MCP semantics', () => {
  it("MCP content writes are 'agent'; web verify / pin / edit make them 'human'", async () => {
    const caller = mcpCaller(s.editor, { id: s.acme.id, slug: 'acme', kind: 'project' })
    const r = await s.items.create(caller, 'memories', { title: 'Agent claim', type: 'fact' })
    const id = r.item?.id as string
    expect(r.item).toMatchObject({ provenance: 'agent', client_name: 'claude-code/2.1.303' })
    const [rev] = await db().select().from(itemRevisions).where(eq(itemRevisions.itemId, id))
    expect(rev).toMatchObject({ via: 'mcp', clientName: 'claude-code/2.1.303', tokenId: caller.ctx.tokenId })
    // MCP verify keeps provenance, sets last_used_at
    await s.items.verifyMany(caller, [id])
    expect(await row(id)).toMatchObject({ provenance: 'agent' })
    expect((await row(id)).lastUsedAt).not.toBeNull()
    await ed.post(`${P}/items/${id}/verify`)
    expect((await row(id)).provenance).toBe('human')
    await s.items.update(caller, id, { revision: 1, body: 'agent edit' })
    expect((await row(id)).provenance).toBe('agent')
    await ed.post(`${P}/items/${id}/pin`)
    expect((await row(id)).provenance).toBe('human')
  })

  it('verifyMany skips archived and shared items', async () => {
    const caller = mcpCaller(s.editor, { id: s.acme.id, slug: 'acme', kind: 'project' })
    const a = await createItem(db(), { projectId: s.acme.id })
    const b = await createItem(db(), { projectId: s.acme.id })
    await createItem(db(), { projectId: s.shared.id })
    await db().update(items).set({ lifecycle: 'stale', staleSince: sql`now()` }).where(eq(items.id, a.id))
    await db()
      .update(items)
      .set({ lifecycle: 'archived', archivedAt: sql`now()`, archiveReason: 'manual' })
      .where(eq(items.id, b.id))
    const r = await s.items.verifyMany(caller, [`m${a.number}`, `m${b.number}`, 'S:m1', 'm99'], 'checked')
    expect(r.verified).toEqual([`m${a.number}`])
    expect(r.restored).toEqual([`m${a.number}`])
    expect(r.skipped.map((x) => x.reason)).toEqual(['archived', 'read_only_space', 'not_found'])
    const audit = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.itemId, a.id), eq(auditLog.action, 'item.verify')))
    expect(audit[0]?.data).toMatchObject({ restored: true, note: 'checked' })
  })
})

describe('get and list', () => {
  it('GET does not bump last_used_at; handles, uuids and slugs resolve', async () => {
    const m = await createItem(db(), { projectId: s.acme.id, title: 'Find me' })
    for (const ref of [`m${m.number}`, m.id, m.slug]) {
      const r = await ed.get(`${P}/items/${ref}`)
      expect(r.status).toBe(200)
    }
    expect((await row(m.id)).lastUsedAt).toBeNull()
    expect((await ed.get(`${P}/items/m999`)).status).toBe(404)
  })

  it('filters: type, tag (AND), lifecycle, pinned, q_title, anchor', async () => {
    const f = await createItem(db(), {
      projectId: s.acme.id,
      title: 'Alpha fact',
      tags: ['auth', 'db'],
      anchors: ['src/auth/'],
    })
    const p = await createItem(db(), {
      projectId: s.acme.id,
      title: 'Beta procedure',
      type: 'procedure',
      tags: ['auth'],
      pinned: true,
    })
    const g = await createItem(db(), {
      projectId: s.acme.id,
      title: 'Gamma',
      anchors: ['packages/*/schema.ts'],
    })
    const arch = await createItem(db(), { projectId: s.acme.id, title: 'Archived' })
    await db()
      .update(items)
      .set({ lifecycle: 'archived', archivedAt: sql`now()`, archiveReason: 'manual' })
      .where(eq(items.id, arch.id))
    const ids = async (q: string) =>
      (await json<{ items: { id: string }[] }>(await ed.get(`${P}/spaces/memories/items${q}`))).items
        .map((i) => i.id)
        .sort()
    expect(await ids('')).toEqual([f.id, p.id, g.id].sort())
    expect(await ids('?lifecycle=all')).toEqual([f.id, p.id, g.id, arch.id].sort())
    expect(await ids('?lifecycle=archived')).toEqual([arch.id])
    expect(await ids('?type=procedure')).toEqual([p.id])
    expect(await ids('?tag=auth&tag=db')).toEqual([f.id])
    expect(await ids('?tag=auth')).toEqual([f.id, p.id].sort())
    expect(await ids('?pinned=true')).toEqual([p.id])
    expect(await ids('?q_title=ALPHA')).toEqual([f.id])
    expect(await ids('?q_title=%25')).toEqual([])
    expect(await ids('?anchor=src/auth/session.ts')).toEqual([f.id])
    expect(await ids('?anchor=packages/server/schema.ts')).toEqual([g.id])
    expect((await ed.get(`${P}/spaces/memories/items?type=bogus`)).status).toBe(400)
    expect((await ed.get(`${P}/spaces/memories/items?nope=1`)).status).toBe(400)
  })

  it('cursor pagination neither skips nor repeats, in every sort', async () => {
    const made: string[] = []
    for (let i = 0; i < 7; i++)
      made.push((await createItem(db(), { projectId: s.acme.id, title: `I${i}` })).id)
    // same updated_at for some rows to exercise the id tie-break
    await db()
      .update(items)
      .set({ updatedAt: sql`'2026-01-01T00:00:00Z'` })
      .where(eq(items.projectId, s.acme.id))
    for (const q of [
      'sort=updated&dir=desc',
      'sort=number&dir=asc',
      'sort=created&dir=asc',
      'sort=verified&dir=desc',
    ]) {
      const seen: string[] = []
      let cursor: string | null = null
      do {
        const url = `${P}/spaces/memories/items?${q}&limit=3${cursor ? `&cursor=${cursor}` : ''}`
        const page: { items: { id: string; number: number }[]; next_cursor: string | null } = await json(
          await ed.get(url),
        )
        seen.push(...page.items.map((i) => i.id))
        cursor = page.next_cursor
      } while (cursor)
      expect(seen.length, q).toBe(7)
      expect(new Set(seen).size, q).toBe(7)
    }
    const asc = await json<{ items: { number: number }[] }>(
      await ed.get(`${P}/spaces/memories/items?sort=number&dir=asc`),
    )
    expect(asc.items.map((i) => i.number)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
})

describe('operational actions', () => {
  it('pin verifies (stale → active); unpin; no revision', async () => {
    const m = await createItem(db(), { projectId: s.acme.id })
    await db()
      .update(items)
      .set({ lifecycle: 'stale', staleSince: sql`now()`, lastVerifiedAt: sql`now() - interval '40 days'` })
      .where(eq(items.id, m.id))
    const r = await ed.post(`${P}/items/${m.id}/pin`)
    expect((await json<{ item: Record<string, unknown> }>(r)).item).toMatchObject({
      pinned: true,
      lifecycle: 'active',
      revision: 1,
    })
    const after = await row(m.id)
    expect(Date.now() - after.lastVerifiedAt.getTime()).toBeLessThan(60_000)
    await ed.post(`${P}/items/${m.id}/unpin`)
    expect((await row(m.id)).pinned).toBe(false)
    const actions = await db()
      .select({ a: auditLog.action, d: auditLog.data })
      .from(auditLog)
      .where(eq(auditLog.itemId, m.id))
    expect(actions.map((a) => a.a)).toEqual(['item.pin', 'item.pin'])
  })

  it('verify: stale → active; archived is 400 restore first', async () => {
    const m = await createItem(db(), { projectId: s.acme.id })
    await db().update(items).set({ lifecycle: 'stale', staleSince: sql`now()` }).where(eq(items.id, m.id))
    expect(
      (
        await json<{ item: { lifecycle: string } }>(
          await ed.post(`${P}/items/${m.id}/verify`, { note: 'ok' }),
        )
      ).item.lifecycle,
    ).toBe('active')
    await ed.post(`${P}/items/${m.id}/archive`)
    expect(await row(m.id)).toMatchObject({ lifecycle: 'archived', archiveReason: 'manual' })
    const v = await ed.post(`${P}/items/${m.id}/verify`)
    expect(v.status).toBe(400)
    expect(await json(v)).toMatchObject({ error: 'invalid_input', hint: 'restore first' })
    // archive twice is a no-op with one audit row
    await ed.post(`${P}/items/${m.id}/archive`)
    const arch = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.itemId, m.id), eq(auditLog.action, 'item.archive')))
    expect(arch).toHaveLength(1)
  })

  it('restore: archived → active; an expired observation needs promote_to_fact + revision', async () => {
    const m = await createItem(db(), { projectId: s.acme.id })
    await ed.post(`${P}/items/${m.id}/archive`)
    const r = await ed.post(`${P}/items/${m.id}/restore`)
    expect((await json<{ item: Record<string, unknown> }>(r)).item).toMatchObject({
      lifecycle: 'active',
      archived_at: null,
      archive_reason: null,
    })

    const o = await createItem(db(), { projectId: s.acme.id, type: 'observation' })
    await db()
      .update(items)
      .set({
        expiresAt: sql`now() - interval '1 day'`,
        lifecycle: 'archived',
        archivedAt: sql`now()`,
        archiveReason: 'expired',
      })
      .where(eq(items.id, o.id))
    const no = await ed.post(`${P}/items/${o.id}/restore`)
    expect(no.status).toBe(409)
    expect((await json(no)).error).toBe('promote_required')
    expect((await json(await ed.post(`${P}/items/${o.id}/restore`, { promote_to_fact: true }))).error).toBe(
      'revision_required',
    )
    expect((await ed.post(`${P}/items/${o.id}/restore`, { promote_to_fact: true, revision: 7 })).status).toBe(
      409,
    )
    const yes = await ed.post(`${P}/items/${o.id}/restore`, { promote_to_fact: true, revision: 1 })
    expect((await json<{ item: Record<string, unknown> }>(yes)).item).toMatchObject({
      type: 'fact',
      lifecycle: 'active',
      expires_at: null,
      revision: 2,
    })
  })
})

describe('last_used_at, dedupe, chunks', () => {
  it('relate bumps the target, at most once an hour', async () => {
    const a = await createItem(db(), { projectId: s.acme.id })
    const b = await createItem(db(), { projectId: s.acme.id })
    await ed.post(`${P}/items/${a.id}/edges`, { kind: 'refines', to: b.id })
    const first = (await row(b.id)).lastUsedAt
    expect(first).not.toBeNull()
    expect((await row(a.id)).lastUsedAt).toBeNull()
    await ed.post(`${P}/items/${a.id}/edges`, { kind: 'supports', to: b.id })
    expect((await row(b.id)).lastUsedAt?.getTime()).toBe(first?.getTime())
  })

  it('web create warns about a near duplicate and saves; MCP refuses and bumps the existing item', async () => {
    const existing = await createItem(db(), { projectId: s.acme.id, title: 'Sessions are server-side' })
    s.search.candidates = [
      {
        id: existing.id,
        number: existing.number,
        adrNumber: null,
        space: 'memories',
        title: existing.title,
        type: 'fact',
        revision: 1,
        lifecycle: 'active',
        cos: 0.95,
      },
    ]
    const web = await json<{ item: { id: string }; warnings: unknown[] }>(
      await create(ed, 'memories', { title: 'Sessions are stored server-side', type: 'fact' }),
    )
    expect(web.warnings).toEqual([
      { code: 'near_duplicate', handle: `m${existing.number}`, cos: 0.95, title: existing.title },
    ])
    expect(web.item.id).toBeDefined()

    const caller = mcpCaller(s.editor, { id: s.acme.id, slug: 'acme', kind: 'project' })
    const before = await db().select().from(items)
    const r = await s.items.create(caller, 'memories', { title: 'Sessions server side', type: 'fact' })
    expect(r.item).toBeNull()
    expect(r.duplicate).toMatchObject({ handle: `m${existing.number}`, cos: 0.95, revision: 1 })
    expect(await db().select().from(items)).toHaveLength(before.length)
    expect((await row(existing.id)).lastUsedAt).not.toBeNull()
    const hits = await db().select().from(auditLog).where(eq(auditLog.action, 'item.dedupe_hit'))
    expect(hits).toHaveLength(1)
    // allow_duplicate skips the check
    const forced = await s.items.create(caller, 'memories', {
      title: 'Sessions server side',
      type: 'fact',
      allow_duplicate: true,
    })
    expect(forced.item).not.toBeNull()
  })

  it('the per-project threshold decides; the supersedes target is excluded; skipped is noted', async () => {
    const old = await createItem(db(), { projectId: s.acme.id, title: 'Old claim' })
    s.search.candidates = [
      {
        id: old.id,
        number: old.number,
        adrNumber: null,
        space: 'memories',
        title: old.title,
        type: 'fact',
        revision: 1,
        lifecycle: 'active',
        cos: 0.9,
      },
    ]
    const caller = mcpCaller(s.editor, { id: s.acme.id, slug: 'acme', kind: 'project' })
    // default 0.92: 0.9 is no hit
    expect(
      (await s.items.create(caller, 'memories', { title: 'A claim', type: 'fact' })).duplicate,
    ).toBeNull()
    await db()
      .update(projects)
      .set({ settings: { dedupe: { threshold: 0.85 } } })
      .where(eq(projects.id, s.acme.id))
    expect(
      (await s.items.create(caller, 'memories', { title: 'A claim 2', type: 'fact' })).duplicate,
    ).not.toBeNull()
    await s.items
      .create(caller, 'memories', {
        title: 'Replacement',
        type: 'decision',
        supersedes: `m${old.number}`,
        allow_duplicate: false,
      })
      .catch(() => {})
    expect(s.search.dedupeCalls.at(-1)).toMatchObject({
      excludeItemId: old.id,
      type: 'decision',
      space: 'memories',
    })
    s.search.skipped = true
    s.search.candidates = []
    expect((await s.items.create(caller, 'memories', { title: 'Third', type: 'fact' })).notes).toEqual([
      'duplicate check skipped',
    ])
  })

  it('a failing provider stores pending chunks, warns and nudges embed-pending', async () => {
    s.search.failPrepare = true
    const r = await json<{ item: { id: string }; warnings: unknown[] }>(
      await create(ed, 'docs', { title: 'Runbook', body: '# Steps' }),
    )
    expect(r.warnings).toEqual([{ code: 'embedding_pending' }])
    expect(s.search.calls.at(-1)).toMatchObject({ item: { id: r.item.id, revision: 1 }, pending: true })
    expect(s.jobs.enqueued).toContainEqual({ name: 'embed-pending', projectId: s.acme.id })
    s.search.failPrepare = false
    await ed.patch(`${P}/items/${r.item.id}`, { revision: 1, body: 'v2' })
    expect(s.search.calls.at(-1)).toMatchObject({ item: { id: r.item.id, revision: 2 }, pending: false })
  })
})

describe('shared space', () => {
  it('writes need IA or shared_editor in the web UI; reads are open to everyone logged in', async () => {
    expect((await create(ed, 'docs', { title: 'Style guide' }, '_shared')).status).toBe(403)
    const se = await s.login(s.se)
    const r = await create(se, 'docs', { title: 'Style guide' }, '_shared')
    expect(r.status).toBe(201)
    const { item } = await json<{ item: { id: string; handle: string } }>(r)
    expect(item.handle).toBe('d1')
    expect((await ed.get(`/api/v1/projects/_shared/items/${item.id}`)).status).toBe(200)
    // seen from a project, a shared item carries the S: prefix
    expect((await json<{ handle: string }>(await ed.get(`${P}/items/S:d1`))).handle).toBe('S:d1')
    // project write positions never reach shared items
    expect((await ed.patch(`${P}/items/S:d1`, { revision: 1, title: 'x' })).status).toBe(403)
    expect((await ed.patch(`${P}/items/${item.id}`, { revision: 1, title: 'x' })).status).toBe(404)
  })

  it('non-web callers can never write the shared space (read_only_space)', async () => {
    for (const via of ['mcp', 'cli'] as const) {
      const caller = { ...mcpCaller(s.se, { id: s.shared.id, slug: '_shared', kind: 'shared' }), via }
      caller.ctx.user = {
        ...(caller.ctx.user as NonNullable<AuthContext['user']>),
        sharedEditor: true,
        isAdmin: true,
      }
      await expect(s.items.create(caller, 'memories', { title: 'x', type: 'fact' })).rejects.toMatchObject({
        code: 'read_only_space',
      })
    }
    const err = await s.items
      .create(
        { ...mcpCaller(s.editor, { id: s.shared.id, slug: '_shared', kind: 'shared' }), via: 'web' },
        'docs',
        { title: 'x' },
      )
      .catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('read_only_space')
  })
})

describe('malformed cursors are 400, not 500 (phase-2 review S4)', () => {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url')
  it('item lists (both sort kinds), revisions and the admin user list', async () => {
    await create(ed, 'memories', { title: 'A', type: 'fact' })
    for (const path of [
      `${P}/spaces/memories/items?cursor=${enc(['x', 'y'])}`,
      `${P}/spaces/memories/items?sort=number&cursor=${enc(['x', 'y'])}`,
      `${P}/items/m1/revisions?cursor=${enc(['abc'])}`,
    ]) {
      const r = await ed.get(path)
      expect(r.status, path).toBe(400)
      expect((await json<{ error: string }>(r)).error).toBe('invalid_input')
    }
    const admin = await createAdmin(db())
    const ia = await loginAs(s.app, admin.email, DEFAULT_PASSWORD)
    const r = await ia.get(`/api/v1/users?cursor=${enc(['a', 'not-a-uuid'])}`)
    expect(r.status).toBe(400)
  })
})

describe('field limits (phase-2 review C9/C10)', () => {
  it('a body over 200000 characters is 413 too_large; limits count code points, not UTF-16 units', async () => {
    const long = await create(ed, 'memories', { title: 'Long', type: 'fact', body: 'x'.repeat(200_001) })
    expect(long.status).toBe(413)
    expect(await json(long)).toMatchObject({ error: 'too_large', details: { limit: 200_000 } })
    const emoji = await create(ed, 'memories', {
      title: '😀'.repeat(150),
      type: 'fact',
      body: '😀'.repeat(150_000),
    })
    expect(emoji.status).toBe(201)
  })
})
