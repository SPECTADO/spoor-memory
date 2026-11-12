// Near-copies and possible duplicates (search-and-digest.md section 5, cleanup-and-jobs.md section 6): the
// `dedupe.refuse_threshold` refusal of MCP creates, the pairs a saved near-duplicate records, and the review
// queue's "Possible duplicates" section (list, counts, review_total, dismiss, auto-resolve).
import type { DuplicateReviewRow } from '@spoor/shared'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import { addMember, createItem, createProject, createUser } from '../../../test/factories.js'
import { type Client, json, loginAs, testApp } from '../../../test/http.js'
import { MemoryJobsPort, stubPorts } from '../../../test/ports.js'
import { auditLog, duplicatePairs, items, projects } from '../../db/schema.js'
import type { AuthContext } from '../../lib/auth-context.js'
import { allowPurge, type DbOrTx, type Tx, withTx } from '../../lib/db.js'
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
const GEMMA = 'ollama:embeddinggemma/768'

class FakeSearch implements SearchPort {
  candidates: DedupeCandidate[] = []
  async prepareChunks(source: ChunkSource): Promise<PreparedChunks> {
    return { source, models: ['fake'], chunks: [], pending: false }
  }
  async dedupeCandidates(_db: DbOrTx, _q: DedupeQuery) {
    return { candidates: this.candidates, skipped: false }
  }
  async indexItemChunks(_tx: Tx, _item: IndexedItem, prepared: PreparedChunks) {
    return { embeddingPending: prepared.pending }
  }
  async relatedCandidates() {
    return { candidates: [], pending: true }
  }
}

async function seed() {
  const search = new FakeSearch()
  const { app, modules } = testApp({ ports: stubPorts({ search, jobs: new MemoryJobsPort() }) })
  const acme = await createProject(db(), { slug: 'acme' }) // e5: refusal off by default
  const gem = await createProject(db(), { slug: 'gem', embeddingModel: GEMMA }) // 0.90 by default
  const other = await createProject(db(), { slug: 'other' })
  const editor = await createUser(db())
  const viewer = await createUser(db())
  const pa = await createUser(db())
  for (const p of [acme, gem, other]) {
    await addMember(db(), p.id, editor.id, 'editor')
    await addMember(db(), p.id, viewer.id, 'viewer')
    await addMember(db(), p.id, pa.id, 'admin')
  }
  const login = (u: { email: string; password: string }) => loginAs(app, u.email, u.password)
  return { app, items: modules.items.items, search, acme, gem, other, editor, viewer, pa, login }
}

let s: Awaited<ReturnType<typeof seed>>
let ed: Client
beforeEach(async () => {
  s = await seed()
  ed = await s.login(s.editor)
})

function mcpCaller(project: { id: string; slug: string }): Caller {
  const user = s.editor
  const ctx: AuthContext = {
    user: { id: user.id, email: user.email, name: user.name, isAdmin: false, sharedEditor: false },
    project: { ...project, kind: 'project', name: project.slug },
    role: 'editor',
    via: 'bearer',
    tokenId: '00000000-0000-4000-8000-000000000001',
    clientName: 'claude-code/2.1.303',
  }
  return { ctx, via: 'mcp', project: { ...project, kind: 'project' } }
}

const candidateOf = (
  existing: { id: string; number: number; title: string },
  over: Partial<DedupeCandidate> = {},
): DedupeCandidate => ({
  id: existing.id,
  number: existing.number,
  adrNumber: null,
  space: 'memories',
  title: existing.title,
  type: 'fact',
  revision: 1,
  lifecycle: 'active',
  cos: 0.95,
  sameText: false,
  values: null,
  ...over,
})

const count = async (projectId: string) =>
  (await db().select().from(items).where(eq(items.projectId, projectId))).length
const pairs = () => db().select().from(duplicatePairs)

describe('dedupe.refuse_threshold (MCP creates)', () => {
  it('is off by default on e5: a 0.99 reworded copy is saved with the similar note', async () => {
    const existing = await createItem(db(), { projectId: s.acme.id, title: 'Sessions are server-side' })
    s.search.candidates = [candidateOf(existing, { cos: 0.99 })]
    const r = await s.items.create(mcpCaller(s.acme), 'memories', {
      title: 'Sessions live server-side',
      type: 'fact',
    })
    expect(r.duplicate).toBeNull()
    expect(r.item).not.toBeNull()
    expect(r.similar).toMatchObject({ handle: `m${existing.number}`, values: null })
  })

  it('is 0.90 on embeddinggemma: at the boundary refused, just below saved; audit and last_used_at', async () => {
    const existing = await createItem(db(), { projectId: s.gem.id, title: 'Sessions are server-side' })
    const caller = mcpCaller(s.gem)
    s.search.candidates = [candidateOf(existing, { cos: 0.9 })]
    const before = await count(s.gem.id)
    const r = await s.items.create(caller, 'memories', { title: 'Sessions live server-side', type: 'fact' })
    expect(r.item).toBeNull()
    expect(r.duplicate).toMatchObject({ handle: `m${existing.number}`, cos: 0.9, match: 'near_copy' })
    expect(await count(s.gem.id)).toBe(before)
    const [row] = await db().select().from(items).where(eq(items.id, existing.id))
    expect(row?.lastUsedAt).not.toBeNull()
    const hits = await db().select().from(auditLog).where(eq(auditLog.action, 'item.dedupe_hit'))
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ summary: `near-copy of m${existing.number} refused`, via: 'mcp' })
    expect(hits[0]?.data).toEqual({ cos: 0.9, match: 'near_copy' })
    expect(await pairs()).toHaveLength(0)

    s.search.candidates = [candidateOf(existing, { cos: 0.8999 })]
    const saved = await s.items.create(caller, 'memories', { title: 'Server-side sessions', type: 'fact' })
    expect(saved.item).not.toBeNull()
    expect(saved.similar).toMatchObject({ handle: `m${existing.number}` })

    // allow_duplicate skips it
    s.search.candidates = [candidateOf(existing, { cos: 0.97 })]
    const forced = await s.items.create(caller, 'memories', {
      title: 'Sessions: server-side',
      type: 'fact',
      allow_duplicate: true,
    })
    expect(forced.item).not.toBeNull()
  })

  it('never refuses when the values differ, the type differs, or on a web create', async () => {
    const existing = await createItem(db(), {
      projectId: s.gem.id,
      title: 'Admin API allows 600 requests/min',
    })
    const caller = mcpCaller(s.gem)
    s.search.candidates = [candidateOf(existing, { cos: 0.97, values: { new: ['60'], existing: ['600'] } })]
    const values = await s.items.create(caller, 'memories', {
      title: 'Admin API allows 60/min',
      type: 'fact',
    })
    expect(values.duplicate).toBeNull()
    expect(values.item).not.toBeNull()

    s.search.candidates = [candidateOf(existing, { cos: 0.97, type: 'procedure' })]
    const type = await s.items.create(caller, 'memories', { title: 'Admin API rate limit', type: 'fact' })
    expect(type.duplicate).toBeNull()

    s.search.candidates = [candidateOf(existing, { cos: 0.97 })]
    const web = await ed.post('/api/v1/projects/gem/spaces/memories/items', {
      title: 'Admin API: 600 per minute',
      type: 'fact',
    })
    expect(web.status).toBe(201)
    expect((await json<{ warnings: { code: string }[] }>(web)).warnings[0]?.code).toBe('near_duplicate')
  })

  it('a stored null turns the model default off; the threshold raises a lower cut-off', async () => {
    const existing = await createItem(db(), { projectId: s.gem.id, title: 'Sessions are server-side' })
    const caller = mcpCaller(s.gem)
    s.search.candidates = [candidateOf(existing, { cos: 0.95 })]
    await db()
      .update(projects)
      .set({ settings: { dedupe: { refuse_threshold: null } } })
      .where(eq(projects.id, s.gem.id))
    expect((await s.items.create(caller, 'memories', { title: 'A', type: 'fact' })).duplicate).toBeNull()
    // threshold 0.96 stored, refuse_threshold the model's 0.90: refusal starts at 0.96
    await db()
      .update(projects)
      .set({ settings: { dedupe: { threshold: 0.96 } } })
      .where(eq(projects.id, s.gem.id))
    expect((await s.items.create(caller, 'memories', { title: 'B', type: 'fact' })).duplicate).toBeNull()
    s.search.candidates = [candidateOf(existing, { cos: 0.96 })]
    expect((await s.items.create(caller, 'memories', { title: 'C', type: 'fact' })).duplicate).toMatchObject({
      match: 'near_copy',
    })
  })
})

describe('settings dedupe.refuse_threshold', () => {
  it('is shown resolved per model, 0.80 to 1.0 or null, not below a stored threshold; admins only', async () => {
    const get = async (slug: string) =>
      (
        await json<{ settings: { dedupe: Record<string, unknown> } }>(
          await ed.get(`/api/v1/projects/${slug}`),
        )
      ).settings.dedupe
    expect((await get('acme')).refuse_threshold).toBeNull()
    expect((await get('gem')).refuse_threshold).toBe(0.9)
    const pa = await s.login(s.pa)
    const set = (dedupe: Record<string, unknown>) =>
      pa.patch('/api/v1/projects/acme', { settings: { dedupe } })
    expect((await set({ refuse_threshold: 0.79 })).status).toBe(400)
    expect((await set({ refuse_threshold: 1.01 })).status).toBe(400)
    expect((await set({ refuse_threshold: 0.92 })).status).toBe(200)
    expect((await get('acme')).refuse_threshold).toBe(0.92)
    const bad = await set({ threshold: 0.95 })
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({
      error: 'invalid_input',
      details: {
        issues: [{ path: 'settings.dedupe.refuse_threshold', message: 'must be at least dedupe.threshold' }],
      },
    })
    expect((await set({ threshold: 0.95, refuse_threshold: 0.95 })).status).toBe(200)
    expect((await set({ refuse_threshold: null })).status).toBe(200)
    expect((await get('acme')).refuse_threshold).toBeNull()
    expect(
      (await ed.patch('/api/v1/projects/acme', { settings: { dedupe: { refuse_threshold: 0.9 } } })).status,
    ).toBe(403)
  })
})

describe('possible duplicates', () => {
  const list = async (c: Client, slug = 'acme') =>
    json<{ items: DuplicateReviewRow[]; next_cursor: string | null }>(
      await c.get(`/api/v1/projects/${slug}/review/duplicates`),
    )
  const counts = async (c: Client) =>
    (await json<{ counts: Record<string, number> }>(await c.get('/api/v1/projects/acme/review'))).counts

  it('records a saved near-duplicate (MCP note and web warning), not one whose values differ', async () => {
    const existing = await createItem(db(), { projectId: s.acme.id, title: 'Sessions are server-side' })
    s.search.candidates = [candidateOf(existing, { cos: 0.91 })]
    const mcp = await s.items.create(mcpCaller(s.acme), 'memories', {
      title: 'Server sessions',
      type: 'fact',
    })
    const web = await json<{ item: { id: string; handle: string } }>(
      await ed.post('/api/v1/projects/acme/spaces/memories/items', {
        title: 'Sessions on server',
        type: 'fact',
      }),
    )
    s.search.candidates = [candidateOf(existing, { cos: 0.95, values: { new: ['60'], existing: ['600'] } })]
    await s.items.create(mcpCaller(s.acme), 'memories', { title: 'Sessions 60', type: 'fact' })
    // below the threshold: nothing
    s.search.candidates = [candidateOf(existing, { cos: 0.86 })]
    await s.items.create(mcpCaller(s.acme), 'memories', { title: 'Sessions maybe', type: 'fact' })

    const rows = await pairs()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.newItemId).sort()).toEqual([mcp.item?.id, web.item.id].sort())
    expect(rows.every((r) => r.existingItemId === existing.id)).toBe(true)
    expect(rows[0]?.cos).toBeCloseTo(0.91, 4)

    const vi = await s.login(s.viewer)
    const body = await list(vi)
    expect(body.items).toHaveLength(2)
    expect(body.items[0]).toMatchObject({
      cos: 0.91,
      new: { handle: web.item.handle, type: 'fact' },
      existing: { handle: `m${existing.number}`, title: 'Sessions are server-side' },
    })
    expect(body.items[0]?.pair_id).toBeDefined()
    expect(body.items[0]?.created_at).toBeDefined()
    expect((await counts(vi)).duplicates).toBe(2)
    const projects = await json<{ items: { slug: string; review_total: number }[] }>(
      await vi.get('/api/v1/projects'),
    )
    expect(projects.items.find((p) => p.slug === 'acme')?.review_total).toBe(2)
    const dash = await json<{ review: Record<string, number> }>(
      await vi.get('/api/v1/projects/acme/dashboard'),
    )
    expect(dash.review.duplicates).toBe(2)
    // the other project sees none of them
    expect((await list(ed, 'other')).items).toHaveLength(0)
  })

  it('a similar item deleted after the dedupe check: the create is saved, no pair', async () => {
    const existing = await createItem(db(), { projectId: s.acme.id, title: 'Sessions are server-side' })
    s.search.candidates = [candidateOf(existing, { cos: 0.93 })]
    // the check runs outside the create transaction: the similar item goes right after it
    const check = s.search.dedupeCandidates.bind(s.search)
    s.search.dedupeCandidates = async (d, q) => {
      const res = await check(d, q)
      await withTx(db(), async (tx) => {
        await allowPurge(tx)
        await tx.delete(items).where(eq(items.id, existing.id))
      })
      return res
    }
    const r = await s.items.create(mcpCaller(s.acme), 'memories', { title: 'Server sessions', type: 'fact' })
    expect(r.item).not.toBeNull()
    expect(await count(s.acme.id)).toBe(1)
    expect(await pairs()).toHaveLength(0)
  })

  it('"Not a duplicate": editors only, stores who and when, leaves the section, audited', async () => {
    const existing = await createItem(db(), { projectId: s.acme.id, title: 'Sessions are server-side' })
    s.search.candidates = [candidateOf(existing, { cos: 0.91 })]
    const mcp = await s.items.create(mcpCaller(s.acme), 'memories', {
      title: 'Server sessions',
      type: 'fact',
    })
    const [pair] = await pairs()
    const url = `/api/v1/projects/acme/review/duplicates/${pair?.id}/dismiss`
    const vi = await s.login(s.viewer)
    expect((await vi.post(url)).status).toBe(403)
    // another project's pair, or no pair: 404
    expect((await ed.post(`/api/v1/projects/other/review/duplicates/${pair?.id}/dismiss`)).status).toBe(404)
    expect((await ed.post('/api/v1/projects/acme/review/duplicates/nope/dismiss')).status).toBe(404)
    const res = await ed.post(url)
    expect(res.status).toBe(200)
    const body = await json<{ pair_id: string; dismissed_at: string; dismissed_by: string }>(res)
    expect(body).toMatchObject({ pair_id: pair?.id, dismissed_by: s.editor.email })
    const [stored] = await pairs()
    expect(stored).toMatchObject({ dismissedBy: s.editor.id, dismissedByLabel: s.editor.email })
    expect(stored?.dismissedAt).not.toBeNull()
    expect((await list(ed)).items).toHaveLength(0)
    expect((await counts(ed)).duplicates).toBe(0)
    const audit = await db().select().from(auditLog).where(eq(auditLog.action, 'review.duplicate_dismissed'))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      itemId: mcp.item?.id,
      summary: `${mcp.item?.handle} is not a duplicate of m${existing.number}`,
    })
    // again: unchanged, no second audit row
    expect((await json<{ dismissed_at: string }>(await ed.post(url))).dismissed_at).toBe(body.dismissed_at)
    expect(
      await db().select().from(auditLog).where(eq(auditLog.action, 'review.duplicate_dismissed')),
    ).toHaveLength(1)
  })

  it('leaves the section when either item is archived, superseded or deleted', async () => {
    const make = async (title: string) => {
      const existing = await createItem(db(), { projectId: s.acme.id, title })
      s.search.candidates = [candidateOf(existing, { cos: 0.92 })]
      const r = await s.items.create(mcpCaller(s.acme), 'memories', { title: `${title} again`, type: 'fact' })
      return { existing, created: r.item as NonNullable<typeof r.item> }
    }
    const a = await make('Alpha claim')
    const b = await make('Beta claim')
    const c = await make('Gamma claim')
    expect((await list(ed)).items).toHaveLength(3)

    await ed.post(`/api/v1/projects/acme/items/${a.created.handle}/archive`, {})
    expect((await list(ed)).items.map((r) => r.new.handle).sort()).toEqual(
      [b.created.handle, c.created.handle].sort(),
    )
    // "Supersede": the newer one stays, the older one is superseded
    const sup = await ed.post(`/api/v1/projects/acme/items/m${b.existing.number}/supersede`, {
      new_id: b.created.handle,
    })
    expect(sup.status).toBe(200)
    expect((await list(ed)).items.map((r) => r.new.handle)).toEqual([c.created.handle])
    const pa = await s.login(s.pa)
    const del = await pa.delete(
      `/api/v1/projects/acme/items/m${c.existing.number}?confirm=m${c.existing.number}`,
    )
    expect(del.status).toBe(204)
    expect((await list(ed)).items).toHaveLength(0)
    expect(await pairs()).toHaveLength(2) // the deleted item's pair went with it
    expect((await counts(ed)).duplicates).toBe(0)
  })
})
