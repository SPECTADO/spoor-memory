// Projects and settings (api.md 4.1; data-model.md 2, 2.1; auth-and-security.md 7, 8).
import { eq, sql } from 'drizzle-orm'
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
import { Client, json, loginAs, testApp } from '../../../test/http.js'
import {
  FakeEmbeddingProvider,
  MemoryJobsPort,
  StaticEmbeddingRegistry,
  stubPorts,
} from '../../../test/ports.js'
import { auditLog, itemRevisions, items, memberships, projects, tokens } from '../../db/schema.js'
import type { EmbeddingProvider } from '../../ports.js'
import { ensureSharedProject } from './service.js'

const db = () => testDb()

async function setup() {
  const fake = new FakeEmbeddingProvider()
  // a second provider under another name (the fake's `name` is a readonly literal, hence the cast)
  const openai = Object.assign(new FakeEmbeddingProvider({ model: 'text-embedding-3-small', dims: 1536 }), {
    name: 'openai',
  }) as EmbeddingProvider
  const jobs = new MemoryJobsPort()
  const ports = stubPorts({ embeddings: new StaticEmbeddingRegistry(fake, [openai]), jobs })
  const { app } = testApp({ ports })
  const admin = await createAdmin(db(), { email: 'admin@example.com' })
  const ia = await loginAs(app, admin.email, DEFAULT_PASSWORD)
  return { app, admin, ia, fake, openai, jobs }
}

type ProjectBody = {
  id: string
  slug: string
  kind: string
  role: string
  settings: { cleanup: { stale_days: number; archive_days: number }; embedding: { provider: string } }
  embedding: { model: string; target: string | null; remaining: number }
}

describe('POST /api/v1/projects', () => {
  it('creates a project for an instance admin with default settings and the default model', async () => {
    const { ia, fake, admin } = await setup()
    const res = await ia.post('/api/v1/projects', {
      slug: 'acme',
      name: 'Acme',
      description: 'line 1\nline 2',
    })
    expect(res.status).toBe(201)
    const body = await json<ProjectBody & { description: string }>(res)
    expect(body).toMatchObject({
      slug: 'acme',
      kind: 'project',
      role: 'admin',
      description: 'line 1\nline 2',
      embedding: { model: fake.tag, target: null, remaining: 0 },
    })
    expect(body.settings.cleanup).toEqual({ stale_days: 30, archive_days: 90, observation_days: 7 })
    const [row] = await db().select().from(projects).where(eq(projects.slug, 'acme'))
    expect(row?.settings).toEqual({ embedding: { provider: 'local' } }) // only explicit keys are stored
    expect(row?.createdBy).toBe(admin.id)
    const [audit] = await db().select().from(auditLog).where(eq(auditLog.action, 'project.create'))
    expect(audit).toMatchObject({ projectId: null, actorLabel: 'admin@example.com', via: 'web' })
    expect(audit?.data).toMatchObject({ project_id: body.id, slug: 'acme' })
  })

  it('validates the slug and settings, 409 slug_taken', async () => {
    const { ia } = await setup()
    for (const slug of ['Acme', 'api', '_shared', 'a_b', '-x']) {
      const r = await ia.post('/api/v1/projects', { slug, name: 'X' })
      expect(r.status, slug).toBe(400)
    }
    const bad = await ia.post('/api/v1/projects', {
      slug: 'x',
      name: 'X',
      settings: { cleanup: { stale_days: 0 } },
    })
    expect(bad.status).toBe(400)
    const unknownProvider = await ia.post('/api/v1/projects', {
      slug: 'x',
      name: 'X',
      settings: { embedding: { provider: 'voyage' } },
    })
    expect(unknownProvider.status).toBe(400)
    expect(
      (await json<{ details: { issues: { path: string }[] } }>(unknownProvider)).details.issues[0]?.path,
    ).toBe('settings.embedding.provider')
    expect((await ia.post('/api/v1/projects', { slug: 'x', name: 'X' })).status).toBe(201)
    const dup = await ia.post('/api/v1/projects', { slug: 'x', name: 'Other' })
    expect(dup.status).toBe(409)
    expect((await json(dup)).error).toBe('slug_taken')
  })

  it('a chosen provider sets the model at creation', async () => {
    const { ia, openai } = await setup()
    const res = await ia.post('/api/v1/projects', {
      slug: 'x',
      name: 'X',
      settings: { embedding: { provider: 'openai' } },
    })
    expect((await json<ProjectBody>(res)).embedding).toEqual({
      model: openai.tag,
      target: null,
      remaining: 0,
    })
  })

  it('is for instance admins only', async () => {
    const { app } = await setup()
    const ann = await createUser(db())
    const p = await createProject(db())
    await addMember(db(), p.id, ann.id, 'admin')
    const c = await loginAs(app, ann.email, DEFAULT_PASSWORD)
    const res = await c.post('/api/v1/projects', { slug: 'x', name: 'X' })
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('forbidden')
    expect((await new Client(app).post('/api/v1/projects', { slug: 'x', name: 'X' })).status).toBe(401)
  })
})

describe('GET /api/v1/projects', () => {
  it('lists member projects with role, counts and review total; IA sees all; never _shared', async () => {
    const { app, ia } = await setup()
    await createSharedProject(db())
    const a = await createProject(db(), { slug: 'alpha', name: 'Alpha' })
    await createProject(db(), { slug: 'beta', name: 'Beta' })
    const ann = await createUser(db())
    await addMember(db(), a.id, ann.id, 'viewer')
    await createItem(db(), { projectId: a.id })
    await createItem(db(), { projectId: a.id, space: 'decisions' })
    await createItem(db(), { projectId: a.id, space: 'docs' })
    const stale = await createItem(db(), { projectId: a.id })
    await db().update(items).set({ lifecycle: 'stale', staleSince: sql`now()` }).where(eq(items.id, stale.id))
    const archived = await createItem(db(), { projectId: a.id })
    await db()
      .update(items)
      .set({ lifecycle: 'archived', archivedAt: sql`now()`, archiveReason: 'manual' })
      .where(eq(items.id, archived.id))
    // library pages count per space but never reach the review queue, archived or not
    await createItem(db(), { projectId: a.id, space: 'library' })
    const libArchived = await createItem(db(), { projectId: a.id, space: 'library' })
    await db()
      .update(items)
      .set({ lifecycle: 'archived', archivedAt: sql`now()`, archiveReason: 'manual' })
      .where(eq(items.id, libArchived.id))
    await createItem(db(), { projectId: a.id, type: 'observation' }) // expires in 7 days: not "expiring"

    const mine = await json<{
      items: { slug: string; role: string; counts: unknown; review_total: number }[]
    }>(await (await loginAs(app, ann.email, DEFAULT_PASSWORD)).get('/api/v1/projects'))
    expect(mine.items).toEqual([
      {
        slug: 'alpha',
        name: 'Alpha',
        description: '',
        role: 'viewer',
        counts: { memories: 3, decisions: 1, docs: 1, library: 1 },
        review_total: 2, // one stale + one recently archived
      },
    ])
    const all = await json<{ items: { slug: string; role: string }[] }>(await ia.get('/api/v1/projects'))
    expect(all.items.map((p) => [p.slug, p.role])).toEqual([
      ['alpha', 'admin'],
      ['beta', 'admin'],
    ])
  })
})

describe('GET /api/v1/projects/:slug', () => {
  it('members see it with their effective role; non-members get 404', async () => {
    const { app, ia } = await setup()
    const p = await createProject(db(), { slug: 'acme' })
    const ann = await createUser(db())
    const bob = await createUser(db())
    await addMember(db(), p.id, ann.id, 'editor')
    const annC = await loginAs(app, ann.email, DEFAULT_PASSWORD)
    expect((await json<ProjectBody>(await annC.get('/api/v1/projects/acme'))).role).toBe('editor')
    expect((await json<ProjectBody>(await ia.get('/api/v1/projects/acme'))).role).toBe('admin')
    const bobRes = await (await loginAs(app, bob.email, DEFAULT_PASSWORD)).get('/api/v1/projects/acme')
    expect(bobRes.status).toBe(404)
    expect((await json(bobRes)).error).toBe('not_found')
    expect((await annC.get('/api/v1/projects/nope')).status).toBe(404)
  })

  it('_shared is visible to every logged-in user: admin / editor (shared_editor) / viewer', async () => {
    const { app, ia } = await setup()
    await createSharedProject(db())
    const se = await createUser(db(), { sharedEditor: true })
    const u = await createUser(db())
    expect((await json<ProjectBody>(await ia.get('/api/v1/projects/_shared'))).role).toBe('admin')
    const seRes = await (await loginAs(app, se.email, DEFAULT_PASSWORD)).get('/api/v1/projects/_shared')
    expect(await json<ProjectBody>(seRes)).toMatchObject({ kind: 'shared', role: 'editor' })
    const uRes = await (await loginAs(app, u.email, DEFAULT_PASSWORD)).get('/api/v1/projects/_shared')
    expect((await json<ProjectBody>(uRes)).role).toBe('viewer')
    expect((await new Client(app).get('/api/v1/projects/_shared')).status).toBe(401)
  })
})

describe('PATCH /api/v1/projects/:slug', () => {
  it('deep-merges settings, validates, audits; the slug is immutable', async () => {
    const { app } = await setup()
    const p = await createProject(db(), { slug: 'acme', settings: { cleanup: { stale_days: 10 } } })
    const pa = await createUser(db())
    await addMember(db(), p.id, pa.id, 'admin')
    const c = await loginAs(app, pa.email, DEFAULT_PASSWORD)
    const res = await c.patch('/api/v1/projects/acme', {
      name: 'Acme Corp',
      settings: { cleanup: { archive_days: 45 }, dedupe: { threshold: 0.85 } },
    })
    expect(res.status).toBe(200)
    const body = await json<ProjectBody & { name: string; settings: { dedupe: { threshold: number } } }>(res)
    expect(body.name).toBe('Acme Corp')
    expect(body.settings.cleanup).toMatchObject({ stale_days: 10, archive_days: 45 })
    expect(body.settings.dedupe.threshold).toBe(0.85)
    const [row] = await db().select().from(projects).where(eq(projects.id, p.id))
    expect(row?.settings).toEqual({
      cleanup: { stale_days: 10, archive_days: 45 },
      dedupe: { threshold: 0.85 },
    })
    const audits = await db().select().from(auditLog).where(eq(auditLog.projectId, p.id))
    expect(audits.map((a) => a.action).sort()).toEqual(['project.settings', 'project.update'])
    expect(audits.find((a) => a.action === 'project.settings')?.data).toMatchObject({
      changed: ['cleanup.archive_days', 'dedupe.threshold'],
    })

    expect((await c.patch('/api/v1/projects/acme', { slug: 'other' })).status).toBe(400)
    expect(
      (await c.patch('/api/v1/projects/acme', { settings: { dedupe: { threshold: 0.5 } } })).status,
    ).toBe(400)
    expect((await c.patch('/api/v1/projects/acme', { settings: { nope: {} } })).status).toBe(400)
  })

  it('changing the provider sets embedding_target and nudges the re-embed job; going back clears it', async () => {
    const { ia, openai, jobs } = await setup()
    const created = await json<ProjectBody>(await ia.post('/api/v1/projects', { slug: 'acme', name: 'Acme' }))
    await createItem(db(), { projectId: created.id })
    const res = await ia.patch('/api/v1/projects/acme', { settings: { embedding: { provider: 'openai' } } })
    const body = await json<ProjectBody>(res)
    expect(body.embedding).toEqual({ model: created.embedding.model, target: openai.tag, remaining: 1 })
    expect(body.settings.embedding.provider).toBe('openai')
    expect(jobs.enqueued).toEqual([{ name: 'reembed', projectId: created.id }])
    const back = await json<ProjectBody>(
      await ia.patch('/api/v1/projects/acme', { settings: { embedding: { provider: 'local' } } }),
    )
    expect(back.embedding).toEqual({ model: created.embedding.model, target: null, remaining: 0 })
    expect(jobs.enqueued).toHaveLength(1)
    const missing = await ia.patch('/api/v1/projects/acme', {
      settings: { embedding: { provider: 'voyage' } },
    })
    expect(missing.status).toBe(400)
  })

  it('editors and viewers may not; _shared settings belong to instance admins', async () => {
    const { app, ia } = await setup()
    await createSharedProject(db())
    const p = await createProject(db(), { slug: 'acme' })
    const ed = await createUser(db(), { sharedEditor: true })
    await addMember(db(), p.id, ed.id, 'editor')
    const c = await loginAs(app, ed.email, DEFAULT_PASSWORD)
    expect((await c.patch('/api/v1/projects/acme', { name: 'X' })).status).toBe(403)
    expect((await c.patch('/api/v1/projects/_shared', { name: 'X' })).status).toBe(403)
    const ok = await ia.patch('/api/v1/projects/_shared', { settings: { cleanup: { stale_days: 60 } } })
    expect(ok.status).toBe(200)
  })
})

describe('DELETE /api/v1/projects/:slug', () => {
  it('purges the project with its items, revisions, memberships, tokens and audit rows', async () => {
    const { ia, admin } = await setup()
    const p = await createProject(db(), { slug: 'acme' })
    await addMember(db(), p.id, admin.id, 'admin')
    await createItem(db(), { projectId: p.id })
    await createToken(db(), { projectId: p.id, kind: 'service', role: 'viewer' })
    await ia.patch('/api/v1/projects/acme', { name: 'Renamed' }) // a project audit row
    expect((await ia.delete('/api/v1/projects/acme')).status).toBe(400) // confirm missing
    expect((await ia.delete('/api/v1/projects/acme?confirm=nope')).status).toBe(400)
    expect((await ia.delete('/api/v1/projects/acme?confirm=acme')).status).toBe(204)
    expect(await db().select().from(projects).where(eq(projects.id, p.id))).toHaveLength(0)
    expect(await db().select().from(items)).toHaveLength(0)
    expect(await db().select().from(itemRevisions)).toHaveLength(0)
    expect(await db().select().from(memberships)).toHaveLength(0)
    expect(await db().select().from(tokens)).toHaveLength(0)
    expect(await db().select().from(auditLog).where(eq(auditLog.projectId, p.id))).toHaveLength(0)
    const [del] = await db().select().from(auditLog).where(eq(auditLog.action, 'project.delete'))
    expect(del).toMatchObject({ projectId: null, data: { slug: 'acme' } })
    expect((await ia.delete('/api/v1/projects/acme?confirm=acme')).status).toBe(404)
  })

  it('_shared cannot be deleted; only instance admins delete', async () => {
    const { app, ia } = await setup()
    await createSharedProject(db())
    const p = await createProject(db(), { slug: 'acme' })
    const pa = await createUser(db())
    await addMember(db(), p.id, pa.id, 'admin')
    const res = await ia.delete('/api/v1/projects/_shared?confirm=_shared')
    expect(res.status).toBe(403)
    const c = await loginAs(app, pa.email, DEFAULT_PASSWORD)
    expect((await c.delete('/api/v1/projects/acme?confirm=acme')).status).toBe(403)
  })
})

describe('ensureSharedProject (startup step 5)', () => {
  it('creates the _shared row once, on the default provider (setting and active model)', async () => {
    const provider = { name: 'openai' as const, tag: 'openai:text-embedding-3-small/1536' }
    expect(await ensureSharedProject(db(), provider)).toEqual({ created: true })
    expect(await ensureSharedProject(db(), { name: 'local', tag: 'local:x/1' })).toEqual({ created: false })
    const rows = await db().select().from(projects)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'shared',
      slug: '_shared',
      embeddingModel: provider.tag,
      settings: { embedding: { provider: 'openai' } },
    })
  })
})
