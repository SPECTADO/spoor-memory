// Export and import against the real Postgres test database (data-model.md section 8, api.md section 9).
import { and, asc, eq, inArray } from 'drizzle-orm'
import { strToU8 } from 'fflate'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
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
import { Client, json, loginAs, TEST_ORIGIN, testConfig } from '../../../test/http.js'
import { stubPorts } from '../../../test/ports.js'
import { auditLog, edges, itemRevisions, items, projects } from '../../db/schema.js'
import { allowPurge, withTx } from '../../lib/db.js'
import type { ServerDeps } from '../../lib/deps.js'
import { ApiError, apiErrorResponse, errorResponse } from '../../lib/errors.js'
import type { NoopSearchPort } from '../../ports.js'
import type { AppEnv } from '../../types.js'
import { createAuthModule } from '../auth/index.js'
import { createTransferModule } from './index.js'
import { readZip, writeZip } from './zip.js'
import { rawZip } from './zipfixtures.js'

const db = () => testDb()
const uuid = (): string => crypto.randomUUID()
const at = (s: string) => new Date(s)
const allow = () => true

// ---- app: the real guards and auth routes plus this module's routes --------------------------------------

function buildApp() {
  const ports = stubPorts()
  const deps: ServerDeps = { config: testConfig(), logger: pino({ level: 'silent' }), db: db(), ports }
  const auth = createAuthModule(deps)
  const transfer = createTransferModule(deps)
  const api = new Hono<AppEnv>()
  api.use('*', ...auth.cookieApiGuards)
  api.route('/', auth.routes)
  api.route('/', transfer.routes)
  const app = new Hono<AppEnv>()
  app.route('/api/v1', api)
  app.onError((err, c) => {
    if (err instanceof ApiError) return apiErrorResponse(c, err)
    if (err instanceof HTTPException) return err.getResponse()
    return errorResponse(c, 'internal', { message: String(err) })
  })
  return { app, deps, ports, transfer: transfer.transfer, search: ports.search as NoopSearchPort }
}

async function upload(
  app: ReturnType<typeof buildApp>['app'],
  client: Client,
  path: string,
  file: Uint8Array,
  fields: Record<string, string> = {},
): Promise<Response> {
  const form = new FormData()
  form.set('file', new File([file as Uint8Array<ArrayBuffer>], 'archive.zip', { type: 'application/zip' }))
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  const headers: Record<string, string> = { origin: TEST_ORIGIN }
  const cookie = client.cookieHeader()
  if (cookie) headers.cookie = cookie
  return app.request(`${TEST_ORIGIN}${path}`, { method: 'POST', headers, body: form })
}

const bytes = async (res: Response) => new Uint8Array(await res.arrayBuffer())

// ---- seed: a project with every kind of item, edge and history -------------------------------------------

async function seed() {
  const shared = await createSharedProject(db())
  const ann = await createUser(db(), { email: 'ann@example.com' })
  const bob = await createUser(db(), { email: 'bob@example.com' })
  const acme = await createProject(db(), {
    slug: 'acme',
    name: 'Acme',
    settings: { cleanup: { stale_days: 45 } },
  })
  await db().update(projects).set({ nextItemNumber: 57, nextAdrNumber: 13 }).where(eq(projects.id, acme.id))

  const base = (
    projectId: string,
    o: Partial<typeof items.$inferInsert> & {
      id: string
      space: 'memories' | 'decisions' | 'docs'
      number: number
      slug: string
      title: string
      status: string
    },
  ) =>
    ({
      projectId,
      createdAt: at('2026-09-01T10:00:00.000Z'),
      createdBy: ann.id,
      createdByLabel: 'ann@example.com',
      updatedAt: at('2026-09-02T10:00:00.000Z'),
      updatedBy: bob.id,
      updatedByLabel: 'bob@example.com',
      statusChangedAt: at('2026-09-01T10:00:00.000Z'),
      lastVerifiedAt: at('2026-09-03T10:00:00.000Z'),
      ...o,
    }) satisfies typeof items.$inferInsert
  const rev = (
    itemId: string,
    revision: number,
    o: Partial<typeof itemRevisions.$inferInsert> & {
      title: string
      body: string
      status: string
      frontmatter: Record<string, unknown>
    },
  ) =>
    ({
      itemId,
      revision,
      change: revision === 1 ? 'create' : 'update',
      actorUserId: ann.id,
      actorLabel: 'ann@example.com',
      tokenId: uuid(),
      via: 'mcp',
      clientName: 'claude-code/2.1.303',
      createdAt: at(`2026-09-0${revision}T10:00:00.000Z`),
      ...o,
    }) satisfies typeof itemRevisions.$inferInsert

  // shared space
  const sDoc = uuid()
  const sMem = uuid()
  await db()
    .insert(items)
    .values([
      base(shared.id, {
        id: sDoc,
        space: 'docs',
        number: 1,
        slug: 'style-guide',
        title: 'Style guide',
        status: 'active',
        body: 'Shared style.\n',
      }),
      base(shared.id, {
        id: sMem,
        space: 'memories',
        number: 2,
        slug: 'shared-rule',
        title: 'Shared rule',
        status: 'active',
        type: 'fact',
        confidence: 'medium',
        body: 'Always.\n',
      }),
    ])
  await db()
    .insert(itemRevisions)
    .values([
      rev(sDoc, 1, {
        title: 'Style guide',
        body: 'Shared style.\n',
        status: 'active',
        frontmatter: { spoor_id: sDoc, title: 'Style guide', tags: [], anchors: [] },
      }),
      rev(sMem, 1, {
        title: 'Shared rule',
        body: 'Always.\n',
        status: 'active',
        frontmatter: {
          spoor_id: sMem,
          title: 'Shared rule',
          tags: [],
          anchors: [],
          type: 'fact',
          confidence: 'medium',
        },
      }),
    ])
  await db().update(projects).set({ nextItemNumber: 3 }).where(eq(projects.id, shared.id))

  // project A
  const m1 = uuid(),
    m2 = uuid(),
    m3 = uuid(),
    d4 = uuid(),
    a5 = uuid(),
    m6 = uuid()
  const m1Body = 'Cookie sessions. See [[auth-flow]], [[shared:style-guide]] and [[nowhere]].\n'
  await db()
    .insert(items)
    .values([
      base(acme.id, {
        id: m1,
        space: 'memories',
        number: 1,
        slug: 'session-store',
        title: 'Session store',
        status: 'superseded',
        type: 'fact',
        confidence: 'high',
        tags: ['auth', 'sessions'],
        anchors: ['src/auth/'],
        frontmatter: { custom: 'x', nested: { a: [1, 2] } },
        body: m1Body,
        revision: 3,
        pinned: true,
        provenance: 'agent',
        clientName: 'claude-code/2.1.303',
        lastUsedAt: at('2026-09-04T10:00:00.000Z'),
        updatedByLabel: 'service:ci',
      }),
      base(acme.id, {
        id: m2,
        space: 'memories',
        number: 2,
        slug: 'flaky-test',
        title: 'Flaky test',
        status: 'active',
        type: 'observation',
        confidence: 'low',
        body: 'It flakes.\n',
        expiresAt: at('2026-11-01T00:00:00.000Z'),
        lifecycle: 'stale',
        staleSince: at('2026-10-01T00:00:00.000Z'),
      }),
      base(acme.id, {
        id: m3,
        space: 'memories',
        number: 3,
        slug: 'old-fact',
        title: 'Old fact',
        status: 'active',
        type: 'fact',
        confidence: 'medium',
        body: 'Old.\n',
        lifecycle: 'archived',
        archivedAt: at('2026-10-02T00:00:00.000Z'),
        archiveReason: 'manual',
      }),
      base(acme.id, {
        id: d4,
        space: 'docs',
        number: 4,
        slug: 'auth-flow',
        title: 'Auth flow',
        status: 'active',
        body: 'Přihlášení ✓\n---\nrule above\n',
        revision: 2,
        sourcePath: 'ARCHITECTURE.md',
      }),
      base(acme.id, {
        id: a5,
        space: 'decisions',
        number: 5,
        adrNumber: 4,
        slug: 'use-postgres',
        title: 'Use Postgres',
        status: 'accepted',
        decidedOn: '2026-09-01',
        frontmatter: { deciders: ['ann', 'bob'] },
        body: '## Context\nWe need SQL.\n',
        sourcePath: 'docs/adr/0004-use-postgres.md',
      }),
      base(acme.id, {
        id: m6,
        space: 'memories',
        number: 6,
        slug: 'new-session-store',
        title: 'New session store',
        status: 'active',
        type: 'decision',
        confidence: 'high',
        body: 'Replaces [[session-store]].\n',
      }),
    ])
  const fmOf = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    spoor_id: id,
    title,
    tags: [],
    anchors: [],
    ...extra,
  })
  const memFm = (
    id: string,
    title: string,
    type: string,
    confidence: string,
    extra: Record<string, unknown> = {},
  ) => fmOf(id, title, { type, confidence, ...extra })
  await db()
    .insert(itemRevisions)
    .values([
      rev(m1, 1, {
        title: 'Session store',
        body: 'Old body\n',
        status: 'active',
        frontmatter: memFm(m1, 'Session store', 'fact', 'medium', { tags: ['auth'] }),
      }),
      rev(m1, 2, {
        title: 'Session store',
        body: 'Newer body [[auth-flow]]\n',
        status: 'active',
        actorUserId: bob.id,
        actorLabel: 'bob@example.com',
        via: 'web',
        clientName: 'web',
        tokenId: null,
        frontmatter: memFm(m1, 'Session store', 'fact', 'high', { tags: ['auth'], anchors: ['src/auth/'] }),
      }),
      rev(m1, 3, {
        title: 'Session store',
        body: m1Body,
        status: 'superseded',
        actorUserId: null,
        actorLabel: 'service:ci',
        change: 'supersede',
        frontmatter: memFm(m1, 'Session store', 'fact', 'high', {
          tags: ['auth', 'sessions'],
          anchors: ['src/auth/'],
          custom: 'x',
          nested: { a: [1, 2] },
        }),
      }),
      rev(m2, 1, {
        title: 'Flaky test',
        body: 'It flakes.\n',
        status: 'active',
        frontmatter: memFm(m2, 'Flaky test', 'observation', 'low'),
      }),
      rev(m3, 1, {
        title: 'Old fact',
        body: 'Old.\n',
        status: 'active',
        frontmatter: memFm(m3, 'Old fact', 'fact', 'medium'),
      }),
      rev(d4, 1, { title: 'Auth flow', body: 'v1\n', status: 'active', frontmatter: fmOf(d4, 'Auth flow') }),
      rev(d4, 2, {
        title: 'Auth flow',
        body: 'Přihlášení ✓\n---\nrule above\n',
        status: 'active',
        change: 'push',
        via: 'cli',
        clientName: 'spoor-cli/0.1.0',
        frontmatter: fmOf(d4, 'Auth flow'),
      }),
      rev(a5, 1, {
        title: 'Use Postgres',
        body: '## Context\nWe need SQL.\n',
        status: 'accepted',
        frontmatter: fmOf(a5, 'Use Postgres', { adr: 4, date: '2026-09-01', deciders: ['ann', 'bob'] }),
      }),
      rev(m6, 1, {
        title: 'New session store',
        body: 'Replaces [[session-store]].\n',
        status: 'active',
        frontmatter: memFm(m6, 'New session store', 'decision', 'high'),
      }),
    ])
  const edge = (
    srcId: string,
    kind: (typeof edges.$inferInsert)['kind'],
    dstRef: string,
    dstId: string | null,
  ) =>
    ({
      id: uuid(),
      projectId: acme.id,
      srcId,
      kind,
      dstRef,
      dstId,
      createdAt: at('2026-09-05T10:00:00.000Z'),
      createdBy: ann.id,
      createdByLabel: 'ann@example.com',
      clientName: 'claude-code/2.1.303',
    }) satisfies typeof edges.$inferInsert
  await db()
    .insert(edges)
    .values([
      edge(m1, 'wikilink', 'auth-flow', d4),
      edge(m1, 'wikilink', 'shared:style-guide', sDoc),
      edge(m1, 'wikilink', 'nowhere', null),
      edge(m1, 'refines', 'shared:memories/shared-rule', sMem),
      edge(m1, 'supports', m2, m2),
      edge(m6, 'supersedes', m1, m1),
      edge(a5, 'drafted_from', m3, m3),
      edge(m6, 'wikilink', 'session-store', m1),
    ])
  await db()
    .insert(auditLog)
    .values([
      {
        projectId: acme.id,
        at: at('2026-09-01T10:00:00.000Z'),
        actorUserId: ann.id,
        actorLabel: 'ann@example.com',
        via: 'web',
        clientName: 'web',
        action: 'item.create',
        itemId: m1,
        itemHandle: 'm1',
        summary: 'ann created m1',
        data: { revision: [0, 1] },
      },
      {
        projectId: acme.id,
        at: at('2026-09-02T10:00:00.000Z'),
        actorUserId: null,
        tokenId: uuid(),
        actorLabel: 'service:ci',
        via: 'mcp',
        clientName: 'claude-code/2.1',
        action: 'item.update',
        itemId: m1,
        itemHandle: 'm1',
        summary: 'ci updated m1',
        data: { revision: [1, 2] },
      },
      {
        projectId: acme.id,
        at: at('2026-09-03T10:00:00.000Z'),
        actorUserId: bob.id,
        actorLabel: 'bob@example.com',
        via: 'web',
        action: 'project.settings',
        summary: 'bob changed settings',
        data: { changed: ['cleanup.stale_days'] },
      },
    ])
  const admin = await createAdmin(db(), { email: 'admin@example.com' })
  return { shared, acme, ann, bob, admin, ids: { sDoc, sMem, m1, m2, m3, d4, a5, m6 } }
}

async function purgeProject(id: string) {
  await withTx(db(), async (tx) => {
    await allowPurge(tx)
    await tx.delete(projects).where(eq(projects.id, id))
    await tx.delete(auditLog).where(eq(auditLog.projectId, id))
  })
}

async function purgeSharedItems(sharedId: string) {
  await withTx(db(), async (tx) => {
    await allowPurge(tx)
    await tx.delete(items).where(eq(items.projectId, sharedId))
  })
}

// ---- reading an export back --------------------------------------------------------------------------------

interface Exported {
  manifest: {
    items: Record<string, unknown>[]
    edges: Record<string, unknown>[]
    project: Record<string, unknown>
    history: boolean
    exported_at?: string
  } & Record<string, unknown>
  md: Record<string, string>
  revisions: Record<string, Record<string, unknown>[]>
  audit: Record<string, unknown>[]
  names: string[]
}

function parseExport(zip: Uint8Array): Exported {
  const entries = readZip(zip, allow)
  const dec = new TextDecoder()
  const out: Exported = {
    manifest: JSON.parse(dec.decode(entries.get('manifest.json'))),
    md: {},
    revisions: {},
    audit: [],
    names: [...entries.keys()],
  }
  const jl = (b: Uint8Array) =>
    dec
      .decode(b)
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  for (const [name, data] of entries) {
    if (name.endsWith('.md')) out.md[name] = dec.decode(data)
    else if (name.startsWith('revisions/')) out.revisions[name.slice(10, -6)] = jl(data)
    else if (name === 'audit.jsonl') out.audit = jl(data)
  }
  return out
}

const unprefix = (s: unknown) => (typeof s === 'string' ? s.replace(/^imported: /, '') : s)

/** data-model.md section 8, round-trip test: normalise provenance, drop what may differ. */
function normalise(e: Exported) {
  const manifest = structuredClone(e.manifest)
  delete manifest.exported_at
  for (const i of manifest.items) {
    i.created_by_label = unprefix(i.created_by_label)
    i.updated_by_label = unprefix(i.updated_by_label)
  }
  for (const ed of manifest.edges) ed.created_by_label = unprefix(ed.created_by_label)
  const revisions: Record<string, unknown[]> = {}
  for (const [id, lines] of Object.entries(e.revisions)) {
    revisions[id] = lines.map((l) => {
      const from = (l.imported_from as { via: string; actor_label: string } | null) ?? {
        via: l.via as string,
        actor_label: l.actor_label as string,
      }
      return { ...l, via: from.via, actor_label: unprefix(from.actor_label), imported_from: null }
    })
  }
  const audit = e.audit
    .filter((l) => l.action !== 'project.import')
    .map((l) => {
      const data = { ...(l.data as Record<string, unknown>) }
      const from = (data.imported_from as { via: string; actor_label: string } | undefined) ?? {
        via: l.via as string,
        actor_label: l.actor_label as string,
      }
      delete data.imported_from
      return { ...l, via: from.via, actor_label: unprefix(from.actor_label), data }
    })
  return { manifest, md: e.md, revisions, audit }
}

async function adminClient(app: ReturnType<typeof buildApp>['app']) {
  return loginAs(app, 'admin@example.com', DEFAULT_PASSWORD)
}

describe('export', () => {
  it('writes the layout of data-model.md section 8 with labels only', async () => {
    const { app } = buildApp()
    const { ids, ann, bob } = await seed()
    const ia = await adminClient(app)
    const res = await ia.get('/api/v1/projects/acme/export')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="spoor-acme-\d{8}\.zip"$/)
    const raw = await bytes(res)
    const e = parseExport(raw)
    expect(e.names).toContain('manifest.json')
    expect(e.names).toContain('audit.jsonl')
    expect(e.names).toContain('memories/session-store.md')
    expect(e.names).toContain('decisions/0004-use-postgres.md')
    expect(e.names).toContain('docs/auth-flow.md')
    expect(e.names).toContain(`revisions/${ids.m1}.jsonl`)
    expect(e.manifest).toMatchObject({
      format: 'spoor-export/1',
      history: true,
      project: {
        slug: 'acme',
        kind: 'project',
        next_item_number: 57,
        next_adr_number: 13,
        settings: { cleanup: { stale_days: 45 } },
      },
    })
    expect(e.manifest.items).toHaveLength(6)
    expect(e.manifest.edges).toHaveLength(8)
    expect(e.revisions[ids.m1]).toHaveLength(3)
    expect(e.audit).toHaveLength(3)

    // no user ids, no token ids anywhere
    const all = new TextDecoder().decode(
      raw.length ? new Uint8Array([...readZip(raw, allow).values()].flatMap((v) => [...v])) : raw,
    )
    expect(all).not.toContain(ann.id)
    expect(all).not.toContain(bob.id)
    expect(all).not.toContain('token_id')

    // Markdown files: canonical frontmatter with uuids and shared refs, derived fields
    const m1 = e.md['memories/session-store.md'] as string
    expect(m1).toMatch(/^---\nspoor_id: /)
    expect(m1).toContain('superseded_by: m6')
    expect(m1).toContain('kind: refines')
    expect(m1).toContain('to: shared:memories/shared-rule')
    expect(m1).toContain(`to: ${ids.m2}`)
    expect(m1.endsWith('See [[auth-flow]], [[shared:style-guide]] and [[nowhere]].\n')).toBe(true)
    expect(e.md['memories/new-session-store.md']).toContain(`supersedes: ${ids.m1}`)
    const adr = e.md['decisions/0004-use-postgres.md'] as string
    expect(adr).toContain('adr: 4')
    expect(adr).toContain('date: 2026-09-01')
    expect(adr).toContain(`drafted_from:\n  - ${ids.m3}`)
    expect(adr).toContain('deciders:')
    expect(e.md['memories/flaky-test.md']).toContain('expires: 2026-11-01T00:00:00.000Z')
  })

  it('history=0 leaves out revisions and audit', async () => {
    const { app } = buildApp()
    await seed()
    const ia = await adminClient(app)
    const e = parseExport(await bytes(await ia.get('/api/v1/projects/acme/export?history=0')))
    expect(e.manifest.history).toBe(false)
    expect(e.names.filter((n) => n.startsWith('revisions/') || n === 'audit.jsonl')).toEqual([])
  })

  it('role checks: project admin, instance admin for shared; others are refused', async () => {
    const { app } = buildApp()
    const { acme } = await seed()
    const pa = await createUser(db(), { email: 'pa@example.com' })
    const editor = await createUser(db(), { email: 'ed@example.com' })
    const viewer = await createUser(db(), { email: 'vi@example.com' })
    const stranger = await createUser(db(), { email: 'st@example.com' })
    await addMember(db(), acme.id, pa.id, 'admin')
    await addMember(db(), acme.id, editor.id, 'editor')
    await addMember(db(), acme.id, viewer.id, 'viewer')
    const status = async (email: string, path: string) =>
      (await (await loginAs(app, email, DEFAULT_PASSWORD)).get(path)).status
    expect(await status('pa@example.com', '/api/v1/projects/acme/export')).toBe(200)
    expect(await status('ed@example.com', '/api/v1/projects/acme/export')).toBe(403)
    expect(await status('vi@example.com', '/api/v1/projects/acme/export')).toBe(403)
    expect(await status('st@example.com', '/api/v1/projects/acme/export')).toBe(404)
    expect(await status('pa@example.com', '/api/v1/projects/_shared/export')).toBe(403)
    expect(await status('admin@example.com', '/api/v1/projects/_shared/export')).toBe(200)
    expect((await new Client(app).get('/api/v1/projects/acme/export')).status).toBe(401)
    expect(stranger.id).toBeTruthy()
  })

  it('the shared space exports as kind shared', async () => {
    const { app } = buildApp()
    await seed()
    const ia = await adminClient(app)
    const e = parseExport(await bytes(await ia.get('/api/v1/projects/_shared/export')))
    expect(e.manifest.project).toMatchObject({ kind: 'shared', slug: '_shared' })
    expect(e.names).toContain('docs/style-guide.md')
  })
})

describe('import: lossless round trip (DoD 6)', () => {
  it('export, purge, import, export again: equal after normalising provenance', async () => {
    const { app, search } = buildApp()
    const { acme, admin, ids } = await seed()
    const ia = await adminClient(app)
    const zip = await bytes(await ia.get('/api/v1/projects/acme/export'))
    const first = parseExport(zip)

    await purgeProject(acme.id)
    const res = await upload(app, ia, '/api/v1/projects/import', zip, { slug: 'acme' })
    expect(res.status).toBe(200)
    const body = await json<{
      project: { slug: string }
      counts: Record<string, number>
      remapped: boolean
      appended_revisions: string[]
      dangling_edges: unknown[]
      notes: string[]
    }>(res)
    expect(body).toMatchObject({
      project: { slug: 'acme' },
      counts: { items: 6, revisions: 9, edges: 8, audit: 3 },
      remapped: false,
      appended_revisions: [],
      dangling_edges: [],
    })

    const second = parseExport(await bytes(await ia.get('/api/v1/projects/acme/export')))
    expect(normalise(second)).toEqual(normalise(first))
    // the Markdown files are byte-identical, so every content_sha256 still verifies
    expect(second.md).toEqual(first.md)

    // provenance is marked, never forged
    const [proj] = await db().select().from(projects).where(eq(projects.slug, 'acme'))
    expect(proj?.id).toBe(first.manifest.project.id)
    const rows = await db()
      .select()
      .from(items)
      .where(eq(items.projectId, proj?.id as string))
    expect(rows).toHaveLength(6)
    for (const r of rows) {
      expect(r.createdBy).toBeNull()
      expect(r.updatedBy).toBeNull()
      expect(r.createdByLabel).toBe('imported: ann@example.com')
    }
    const revs = await db()
      .select()
      .from(itemRevisions)
      .where(
        inArray(
          itemRevisions.itemId,
          rows.map((r) => r.id),
        ),
      )
    for (const r of revs) {
      expect(r).toMatchObject({ via: 'import', actorUserId: null, tokenId: null })
      expect(r.actorLabel).toMatch(/^imported: /)
      expect(r.importedFrom).toMatchObject({ via: expect.any(String), actor_label: expect.any(String) })
    }
    const m1Revs = revs.filter((r) => r.itemId === ids.m1).sort((a, b) => a.revision - b.revision)
    expect(m1Revs.map((r) => r.createdAt.toISOString())).toEqual([
      '2026-09-01T10:00:00.000Z',
      '2026-09-02T10:00:00.000Z',
      '2026-09-03T10:00:00.000Z',
    ])
    const audits = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.projectId, proj?.id as string))
      .orderBy(asc(auditLog.id))
    expect(audits).toHaveLength(4)
    for (const a of audits.slice(0, 3))
      expect(a).toMatchObject({ via: 'import', actorUserId: null, tokenId: null })
    expect(audits[0]?.at.toISOString()).toBe('2026-09-01T10:00:00.000Z')
    expect(audits[3]).toMatchObject({
      action: 'project.import',
      via: 'web',
      actorUserId: admin.id,
      actorLabel: 'admin@example.com',
    })
    expect(audits[3]?.data).toMatchObject({ counts: { items: 6 }, remapped: false })
    // an instance-level project.create row names the real importer too
    const created = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'project.create')))
    expect(created.map((c) => c.actorLabel)).toContain('admin@example.com')

    // edges point where they pointed, including the links into the shared space
    const e = await db()
      .select()
      .from(edges)
      .where(eq(edges.projectId, proj?.id as string))
    const find = (kind: string, ref: string) => e.find((x) => x.kind === kind && x.dstRef === ref)
    expect(find('wikilink', 'shared:style-guide')?.dstId).toBe(ids.sDoc)
    expect(find('refines', 'shared:memories/shared-rule')?.dstId).toBe(ids.sMem)
    expect(find('wikilink', 'nowhere')?.dstId).toBeNull()
    expect(find('wikilink', 'auth-flow')?.dstId).toBe(ids.d4)

    // numbering: counters and numbers are kept
    expect(proj).toMatchObject({ nextItemNumber: 57, nextAdrNumber: 13 })
    expect(rows.find((r) => r.id === ids.a5)).toMatchObject({
      number: 5,
      adrNumber: 4,
      sourcePath: 'docs/adr/0004-use-postgres.md',
    })

    // chunk rows are written through the SearchPort inside the import transaction
    expect(search.indexed.map((i) => i.id).sort()).toEqual(rows.map((r) => r.id).sort())
  })

  it('a second hop keeps the original provenance and does not stack prefixes', async () => {
    const { app } = buildApp()
    const { acme } = await seed()
    const ia = await adminClient(app)
    const zip1 = await bytes(await ia.get('/api/v1/projects/acme/export'))
    await purgeProject(acme.id)
    await upload(app, ia, '/api/v1/projects/import', zip1, { slug: 'acme' })
    const zip2 = await bytes(await ia.get('/api/v1/projects/acme/export'))
    await purgeProject((await db().select().from(projects).where(eq(projects.slug, 'acme')))[0]?.id as string)
    expect((await upload(app, ia, '/api/v1/projects/import', zip2, { slug: 'acme' })).status).toBe(200)
    const third = parseExport(await bytes(await ia.get('/api/v1/projects/acme/export')))
    expect(normalise(third)).toEqual(normalise(parseExport(zip1)))
    for (const lines of Object.values(third.revisions)) {
      for (const l of lines) expect(l.actor_label as string).not.toMatch(/imported: imported:/)
    }
  })

  it('id collision fails without remap_ids and writes nothing; remap_ids gives new ids consistently', async () => {
    const { app } = buildApp()
    const { ids, acme } = await seed()
    const ia = await adminClient(app)
    const zip = await bytes(await ia.get('/api/v1/projects/acme/export'))
    const before = (await db().select().from(items)).length

    const clash = await upload(app, ia, '/api/v1/projects/import', zip, { slug: 'acme2' })
    expect(clash.status).toBe(409)
    const clashBody = await json<{ error: string; details?: unknown }>(clash)
    expect(clashBody.error).toBe('id_collision')
    // no ids and no count: they would reveal uuids of projects the importer cannot see (review S6)
    expect(clashBody.details).toBeUndefined()
    expect((await db().select().from(projects).where(eq(projects.slug, 'acme2'))).length).toBe(0)
    expect((await db().select().from(items)).length).toBe(before)

    const ok = await upload(app, ia, '/api/v1/projects/import', zip, { slug: 'acme2', remap_ids: 'true' })
    expect(ok.status).toBe(200)
    expect(await json(ok)).toMatchObject({
      remapped: true,
      counts: { items: 6, revisions: 9, edges: 8, audit: 3 },
      dangling_edges: [],
    })
    const [two] = await db().select().from(projects).where(eq(projects.slug, 'acme2'))
    expect(two?.id).not.toBe(acme.id)
    const newItems = await db()
      .select()
      .from(items)
      .where(eq(items.projectId, two?.id as string))
    expect(newItems).toHaveLength(6)
    const oldIds = new Set(Object.values(ids))
    for (const i of newItems) expect(oldIds.has(i.id)).toBe(false)
    const newIds = new Set(newItems.map((i) => i.id))
    const e = await db()
      .select()
      .from(edges)
      .where(eq(edges.projectId, two?.id as string))
    expect(e).toHaveLength(8)
    for (const x of e) {
      expect(newIds.has(x.srcId)).toBe(true)
      if (x.dstId && !x.dstRef.startsWith('shared:')) expect(newIds.has(x.dstId)).toBe(true)
      if (/^[0-9a-f-]{36}$/.test(x.dstRef)) expect(x.dstRef).toBe(x.dstId) // typed edges follow the new ids
    }
    expect(e.find((x) => x.dstRef === 'shared:style-guide')?.dstId).toBe(ids.sDoc)
    // revision snapshots carry the new spoor_id
    const revs = await db()
      .select()
      .from(itemRevisions)
      .where(inArray(itemRevisions.itemId, [...newIds]))
    for (const r of revs) expect(r.frontmatter.spoor_id).toBe(r.itemId)
    // the original project is untouched
    expect((await db().select().from(items).where(eq(items.projectId, acme.id))).length).toBe(6)
  })

  it('history=0 imports one synthesised revision per item at the item revision', async () => {
    const { app } = buildApp()
    const { ids } = await seed()
    const ia = await adminClient(app)
    const zip = await bytes(await ia.get('/api/v1/projects/acme/export?history=0'))
    const res = await upload(app, ia, '/api/v1/projects/import', zip, { slug: 'lite', remap_ids: 'true' })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ counts: { items: 6, revisions: 6, edges: 8, audit: 0 } })
    const [lite] = await db().select().from(projects).where(eq(projects.slug, 'lite'))
    const rows = await db()
      .select()
      .from(items)
      .where(eq(items.projectId, lite?.id as string))
    const revs = await db()
      .select()
      .from(itemRevisions)
      .where(
        inArray(
          itemRevisions.itemId,
          rows.map((r) => r.id),
        ),
      )
    expect(revs).toHaveLength(6)
    for (const r of revs) {
      const it = rows.find((x) => x.id === r.itemId)
      expect(r).toMatchObject({ revision: it?.revision, change: 'import', via: 'import', actorUserId: null })
      expect(r.title).toBe(it?.title)
      expect(r.body).toBe(it?.body)
    }
    expect(rows.find((r) => r.slug === 'session-store')?.revision).toBe(3)
    // the lite project exports with history again: its snapshots are the current content
    const again = parseExport(await bytes(await ia.get('/api/v1/projects/lite/export')))
    expect(Object.values(again.revisions).every((l) => l.length === 1)).toBe(true)
    expect(Object.keys(again.revisions)).toHaveLength(6)
    void ids
  })

  it('links to the shared space that cannot be resolved stay dangling and are listed', async () => {
    const { app } = buildApp()
    const { acme, shared } = await seed()
    const ia = await adminClient(app)
    const zip = await bytes(await ia.get('/api/v1/projects/acme/export'))
    await purgeProject(acme.id)
    await purgeSharedItems(shared.id)
    const res = await upload(app, ia, '/api/v1/projects/import', zip, { slug: 'acme' })
    expect(res.status).toBe(200)
    const body = await json<{ dangling_edges: { from: string; dst_ref: string }[] }>(res)
    expect(body.dangling_edges.sort((a, b) => a.dst_ref.localeCompare(b.dst_ref))).toEqual([
      { from: 'm1', dst_ref: 'shared:memories/shared-rule' },
      { from: 'm1', dst_ref: 'shared:style-guide' },
    ])
    const [p] = await db().select().from(projects).where(eq(projects.slug, 'acme'))
    const e = await db()
      .select()
      .from(edges)
      .where(eq(edges.projectId, p?.id as string))
    expect(e.filter((x) => x.dstRef.startsWith('shared:')).every((x) => x.dstId === null)).toBe(true)
    // the second export differs from the first only in those dst_ids
    const second = parseExport(await bytes(await ia.get('/api/v1/projects/acme/export')))
    expect(
      second.manifest.edges.filter((x) => x.dst_id === null && String(x.dst_ref).startsWith('shared:')),
    ).toHaveLength(2)
  })

  it('importing the shared space resolves links that were dangling in projects', async () => {
    const { app } = buildApp()
    const { shared, acme, ids } = await seed()
    const ia = await adminClient(app)
    const sharedZip = await bytes(await ia.get('/api/v1/projects/_shared/export'))
    await purgeSharedItems(shared.id) // the FK nulls dst_id of acme's links
    expect(
      (
        await db()
          .select()
          .from(edges)
          .where(and(eq(edges.projectId, acme.id), eq(edges.dstRef, 'shared:style-guide')))
      )[0]?.dstId,
    ).toBeNull()
    const res = await upload(app, ia, '/api/v1/projects/_shared/import', sharedZip)
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ project: { slug: '_shared' }, counts: { items: 2 } })
    const e = await db().select().from(edges).where(eq(edges.projectId, acme.id))
    expect(e.find((x) => x.dstRef === 'shared:style-guide')?.dstId).toBe(ids.sDoc)
    expect(e.find((x) => x.dstRef === 'shared:memories/shared-rule')?.dstId).toBe(ids.sMem)
  })

  it('an edited Markdown file appends one revision on top and is listed', async () => {
    const { app } = buildApp()
    const { ids } = await seed()
    const ia = await adminClient(app)
    const zip = await bytes(await ia.get('/api/v1/projects/acme/export'))
    const files = Object.fromEntries(readZip(zip, allow))
    const path = 'memories/new-session-store.md'
    const text = new TextDecoder()
      .decode(files[path])
      .replace('Replaces [[session-store]].', 'Edited by hand.')
    files[path] = strToU8(text)
    const res = await upload(app, ia, '/api/v1/projects/import', writeZip(files, new Date()), {
      slug: 'edited',
      remap_ids: 'true',
    })
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ appended_revisions: ['m6'], counts: { revisions: 10 } })
    const [p] = await db().select().from(projects).where(eq(projects.slug, 'edited'))
    const [item] = await db()
      .select()
      .from(items)
      .where(and(eq(items.projectId, p?.id as string), eq(items.slug, 'new-session-store')))
    expect(item).toMatchObject({ revision: 2, body: 'Edited by hand.\n' })
    const revs = await db()
      .select()
      .from(itemRevisions)
      .where(eq(itemRevisions.itemId, item?.id as string))
      .orderBy(asc(itemRevisions.revision))
    expect(revs.map((r) => [r.revision, r.change, r.via])).toEqual([
      [1, 'create', 'import'],
      [2, 'import', 'import'],
    ])
    expect(revs[0]?.body).toBe('Replaces [[session-store]].\n')
    void ids
  })
})

describe('import: targets and roles', () => {
  it('imports into an empty existing project as its admin, refuses a non-empty one', async () => {
    const { app } = buildApp()
    const { acme } = await seed()
    const pa = await createUser(db(), { email: 'pa@example.com' })
    const target = await createProject(db(), { slug: 'target' })
    await addMember(db(), target.id, pa.id, 'admin')
    await addMember(db(), acme.id, pa.id, 'editor')
    const ia = await adminClient(app)
    const zip = await bytes(await ia.get('/api/v1/projects/acme/export'))
    const c = await loginAs(app, 'pa@example.com', DEFAULT_PASSWORD)

    const ok = await upload(app, c, '/api/v1/projects/target/import', zip, { remap_ids: 'true' })
    expect(ok.status).toBe(200)
    expect(await json(ok)).toMatchObject({ project: { slug: 'target' }, counts: { items: 6 } })
    expect((await db().select().from(items).where(eq(items.projectId, target.id))).length).toBe(6)

    const again = await upload(app, c, '/api/v1/projects/target/import', zip, { remap_ids: 'true' })
    expect(again.status).toBe(409)
    expect(await json(again)).toMatchObject({ error: 'project_not_empty' })
    expect((await db().select().from(items).where(eq(items.projectId, target.id))).length).toBe(6)

    // only an editor of acme: no import there; an admin of nothing: no import into a new project
    expect((await upload(app, c, '/api/v1/projects/acme/import', zip)).status).toBe(403)
    expect((await upload(app, c, '/api/v1/projects/import', zip, { slug: 'nope' })).status).toBe(403)
    expect((await upload(app, c, '/api/v1/projects/_shared/import', zip)).status).toBe(403)
  })

  it('an archive of a project cannot go into the shared space or the reverse', async () => {
    const { app } = buildApp()
    const { shared } = await seed()
    const ia = await adminClient(app)
    const projectZip = await bytes(await ia.get('/api/v1/projects/acme/export'))
    const sharedZip = await bytes(await ia.get('/api/v1/projects/_shared/export'))
    await purgeSharedItems(shared.id)
    const a = await upload(app, ia, '/api/v1/projects/_shared/import', projectZip, { remap_ids: 'true' })
    expect(a.status).toBe(422)
    const empty = await createProject(db(), { slug: 'empty' })
    const b = await upload(app, ia, '/api/v1/projects/empty/import', sharedZip, { remap_ids: 'true' })
    expect(b.status).toBe(422)
    expect((await db().select().from(items).where(eq(items.projectId, empty.id))).length).toBe(0)
    const c = await upload(app, ia, '/api/v1/projects/import', sharedZip, {
      slug: 'fromshared',
      remap_ids: 'true',
    })
    expect(c.status).toBe(422)
    expect((await db().select().from(projects).where(eq(projects.slug, 'fromshared'))).length).toBe(0)
  })

  it('validates the form: slug taken, bad slug, unknown field, missing file', async () => {
    const { app } = buildApp()
    await seed()
    const ia = await adminClient(app)
    const zip = await bytes(await ia.get('/api/v1/projects/acme/export'))
    expect(
      (await upload(app, ia, '/api/v1/projects/import', zip, { slug: 'acme', remap_ids: 'true' })).status,
    ).toBe(409)
    expect((await upload(app, ia, '/api/v1/projects/import', zip, { slug: 'Bad Slug' })).status).toBe(400)
    expect(
      (await upload(app, ia, '/api/v1/projects/import', zip, { slug: 'x1', surprise: '1' })).status,
    ).toBe(400)
    expect(
      (await upload(app, ia, '/api/v1/projects/import', zip, { slug: 'x1', remap_ids: 'maybe' })).status,
    ).toBe(400)
    const form = new FormData()
    form.set('slug', 'x1')
    const noFile = await app.request(`${TEST_ORIGIN}/api/v1/projects/import`, {
      method: 'POST',
      headers: { origin: TEST_ORIGIN, cookie: ia.cookieHeader() as string },
      body: form,
    })
    expect(noFile.status).toBe(400)
  })

  it('refuses a second import or export while one is running (busy)', async () => {
    const { transfer } = buildApp()
    const { admin, acme } = await seed()
    await purgeProject(acme.id)
    const ctx = {
      user: { id: admin.id, email: admin.email, name: admin.name, isAdmin: true, sharedEditor: false },
      project: null,
      role: null,
      via: 'cookie' as const,
      clientName: 'web',
    }
    const zip = writeZip({ 'docs/a.md': strToU8('# A\n'), 'docs/b.md': strToU8('# B\n') }, new Date())
    const [r1, r2] = await Promise.allSettled([
      transfer.importNew(ctx, { file: zip, slug: 'one', remapIds: false }),
      transfer.importNew(ctx, { file: zip, slug: 'two', remapIds: false }),
    ])
    const results = [r1, r2]
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({ code: 'busy' })
  })
})

describe('import: hardening over HTTP', () => {
  /** One app and one seeded database per test; each crafted zip must be refused and leave nothing behind. */
  const harness = async () => {
    const { app } = buildApp()
    await seed()
    const ia = await adminClient(app)
    const before = (await db().select().from(items)).length
    return async (zip: Uint8Array, status: number, error: string) => {
      const res = await upload(app, ia, '/api/v1/projects/import', zip, { slug: 'evil' })
      expect(res.status).toBe(status)
      expect(await json(res)).toMatchObject({ error })
      expect((await db().select().from(projects).where(eq(projects.slug, 'evil'))).length).toBe(0)
      expect((await db().select().from(items)).length).toBe(before)
    }
  }

  it('path traversal, absolute and backslash names are 422 invalid_archive', async () => {
    const rejects = await harness()
    for (const name of ['../manifest.json', '/etc/passwd', 'docs/../../x.md', 'docs\\a.md', 'C:docs.md']) {
      await rejects(rawZip([{ name, data: strToU8('x') }]), 422, 'invalid_archive')
    }
  })

  it('names outside the allowlist and duplicates are 422', async () => {
    const rejects = await harness()
    await rejects(rawZip([{ name: 'evil.sh', data: strToU8('x') }]), 422, 'invalid_archive')
    await rejects(rawZip([{ name: 'docs/a.md' }, { name: 'docs/a.md' }]), 422, 'invalid_archive')
  })

  it('zip bombs and oversized entries are 413 zip_limits', async () => {
    const rejects = await harness()
    await rejects(
      rawZip([{ name: 'docs/a.md', data: new Uint8Array(6 * 1024 * 1024), method: 8 }]),
      413,
      'zip_limits',
    )
    await rejects(
      rawZip([{ name: 'docs/a.md', data: strToU8('x'), usize: 6 * 1024 * 1024 }]),
      413,
      'zip_limits',
    )
    await rejects(
      rawZip(Array.from({ length: 20_001 }, (_, i) => ({ name: `docs/n${i}.md` }))),
      413,
      'zip_limits',
    )
  })

  it('a lying size or a bad CRC is 422', async () => {
    const rejects = await harness()
    await rejects(
      rawZip([{ name: 'docs/a.md', data: new Uint8Array(1024 * 1024), method: 8, usize: 10 }]),
      422,
      'invalid_archive',
    )
    await rejects(rawZip([{ name: 'docs/a.md', data: strToU8('abc'), crc: 1 }]), 422, 'invalid_archive')
  })

  it('a broken manifest, bad UTF-8 and a tampered hash are handled', async () => {
    const rejects = await harness()
    await rejects(
      rawZip([{ name: 'manifest.json', data: strToU8('{"format":"spoor-export/1"}') }]),
      422,
      'invalid_archive',
    )
    await rejects(rawZip([{ name: 'manifest.json', data: strToU8('not json') }]), 422, 'invalid_archive')
    await rejects(
      rawZip([{ name: 'manifest.json', data: new Uint8Array([0xff, 0xfe, 0xfd]) }]),
      422,
      'invalid_archive',
    )
    await rejects(rawZip([{ name: 'docs/a.md', data: new Uint8Array([0xc3, 0x28]) }]), 422, 'invalid_archive')
  })

  it('a corrupted archive that references something it does not carry is 422', async () => {
    const { app } = buildApp()
    await seed()
    const ia = await adminClient(app)
    const zip = await bytes(await ia.get('/api/v1/projects/acme/export'))
    const files = Object.fromEntries(readZip(zip, allow))
    delete files['docs/auth-flow.md']
    const res = await upload(app, ia, '/api/v1/projects/import', writeZip(files, new Date()), {
      slug: 'half',
      remap_ids: 'true',
    })
    expect(res.status).toBe(422)
    expect((await db().select().from(projects).where(eq(projects.slug, 'half'))).length).toBe(0)
  })

  it('an upload over 50 MB is 413 payload_too_large', async () => {
    const { app } = buildApp()
    await seed()
    const ia = await adminClient(app)
    const big = new Uint8Array(51 * 1024 * 1024)
    const res = await upload(app, ia, '/api/v1/projects/import', big, { slug: 'big' })
    expect(res.status).toBe(413)
    expect(await json(res)).toMatchObject({ error: 'payload_too_large' })
  })
})

describe('import: a folder of Markdown files', () => {
  it('creates items with new numbers in a non-empty project and resolves links as designed', async () => {
    const { app } = buildApp()
    const { acme, shared, ids } = await seed()
    const pa = await createUser(db(), { email: 'pa@example.com' })
    await addMember(db(), acme.id, pa.id, 'admin')
    const c = await loginAs(app, 'pa@example.com', DEFAULT_PASSWORD)
    const zip = writeZip(
      {
        'memories/cache-ttl.md': strToU8(
          '---\ntype: fact\ntitle: Cache TTL\ntags: [cache]\npinned: true\nrelations:\n  - kind: supports\n    to: use-redis\n  - kind: refines\n    to: session-store\n  - kind: supports\n    to: shared:docs/style-guide\n---\nSee [[auth-flow]] and [[shared:style-guide]] and [[use-redis]].\n',
        ),
        // ADR 4 is held by acme: renumbered
        'decisions/0004-use-redis.md': strToU8('# ADR-0004: Use Redis\n\nFor caching.\n'),
        'docs/runbook.md': strToU8('no frontmatter\n'),
      },
      new Date(),
    )
    const res = await upload(app, c, '/api/v1/projects/acme/import', zip)
    expect(res.status).toBe(200)
    const body = await json<{ counts: Record<string, number>; notes: string[] }>(res)
    expect(body.counts).toMatchObject({ items: 3, revisions: 3 })
    // `session-store` is an item of the TARGET project: never resolved from a relation, so it is listed
    expect(body.notes.some((n) => n.includes('session-store'))).toBe(true)

    const rows = await db().select().from(items).where(eq(items.projectId, acme.id))
    expect(rows).toHaveLength(9)
    const ttl = rows.find((r) => r.slug === 'cache-ttl')
    const redis = rows.find((r) => r.slug === 'use-redis')
    expect(ttl).toMatchObject({ number: 59, pinned: true, title: 'Cache TTL', revision: 1, createdBy: null })
    expect(redis).toMatchObject({
      space: 'decisions',
      adrNumber: 13,
      status: 'accepted',
      title: 'Use Redis',
      frontmatter: { renumbered_from: 4 },
    })
    expect(redis?.number).toBe(57)
    expect(rows.find((r) => r.slug === 'runbook')).toMatchObject({
      number: 58,
      space: 'docs',
      title: 'Runbook',
    })
    const [p] = await db().select().from(projects).where(eq(projects.id, acme.id))
    expect(p).toMatchObject({ nextItemNumber: 60, nextAdrNumber: 14 })
    const e = await db()
      .select()
      .from(edges)
      .where(eq(edges.srcId, ttl?.id as string))
    const key = (x: (typeof e)[number]) => `${x.kind}:${x.dstRef}`
    expect(e.map(key).sort()).toEqual(
      [
        `supports:${redis?.id}`,
        'supports:shared:docs/style-guide',
        'wikilink:auth-flow',
        'wikilink:shared:style-guide',
        'wikilink:use-redis',
      ].sort(),
    )
    expect(e.find((x) => x.dstRef === 'auth-flow')?.dstId).toBe(ids.d4)
    expect(e.find((x) => x.dstRef === 'shared:style-guide')?.dstId).toBe(ids.sDoc)
    expect(
      e.find((x) => x.dstRef === 'supports:shared:docs/style-guide' || x.dstRef === 'shared:docs/style-guide')
        ?.dstId,
    ).toBe(ids.sDoc)
    expect(e.find((x) => x.dstRef === 'use-redis')?.dstId).toBe(redis?.id)
    const revs = await db()
      .select()
      .from(itemRevisions)
      .where(eq(itemRevisions.itemId, ttl?.id as string))
    expect(revs).toEqual([
      expect.objectContaining({
        revision: 1,
        change: 'import',
        via: 'import',
        actorUserId: null,
        actorLabel: 'imported: pa@example.com',
      }),
    ])
    void shared
  })

  it('revisions or audit rows without a manifest are refused', async () => {
    const { app } = buildApp()
    await seed()
    const ia = await adminClient(app)
    const res = await upload(
      app,
      ia,
      '/api/v1/projects/import',
      writeZip({ 'audit.jsonl': strToU8(''), 'docs/a.md': strToU8('x') }, new Date()),
      { slug: 'nomani' },
    )
    expect(res.status).toBe(422)
  })
})

describe('import: phase-2 review regressions', () => {
  const folder = (files: Record<string, string>) =>
    writeZip(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), new Date())

  it('supersedes / drafted_from never resolve into the shared space (S2)', async () => {
    const { app } = buildApp()
    const { acme, ids } = await seed()
    const pa = await createUser(db(), { email: 'pa@example.com' })
    await addMember(db(), acme.id, pa.id, 'admin')
    const c = await loginAs(app, 'pa@example.com', DEFAULT_PASSWORD)
    const sharedRow = (await db().select().from(items).where(eq(items.id, ids.sMem)))[0]
    const ref = `S:m${sharedRow?.number}`
    const res = await upload(
      app,
      c,
      '/api/v1/projects/acme/import',
      folder({
        'memories/secret-plan.md': `---\ntype: fact\nsupersedes: ${ref}\nrelations:\n  - kind: supports\n    to: shared:memories/${sharedRow?.slug}\n---\nplan\n`,
        'decisions/0050-x.md': `---\ndrafted_from: [shared:memories/${sharedRow?.slug}]\n---\n# X\n`,
      }),
    )
    expect(res.status).toBe(200)
    const body = await json<{ notes: string[] }>(res)
    expect(body.notes.some((n) => n.includes(ref))).toBe(true)
    const intoShared = await db().select().from(edges).where(eq(edges.dstId, ids.sMem))
    expect(intoShared.filter((e) => e.kind === 'supersedes' || e.kind === 'drafted_from')).toEqual([])
    // a relation into the shared space is still fine
    expect(intoShared.some((e) => e.kind === 'supports')).toBe(true)
  })

  it('a lossless supersedes edge into the shared space is kept dangling (S2)', async () => {
    const { app } = buildApp()
    const { acme, ids } = await seed()
    const sharedRow = (await db().select().from(items).where(eq(items.id, ids.sMem)))[0]
    await db()
      .insert(edges)
      .values({
        projectId: acme.id,
        srcId: ids.m2,
        kind: 'supersedes',
        dstRef: `shared:memories/${sharedRow?.slug}`,
        dstId: ids.sMem,
      })
    const ia = await adminClient(app)
    const zip = await bytes(await ia.get('/api/v1/projects/acme/export'))
    const res = await upload(app, ia, '/api/v1/projects/import', zip, { slug: 'acme3', remap_ids: 'true' })
    expect(res.status).toBe(200)
    const [p] = await db().select().from(projects).where(eq(projects.slug, 'acme3'))
    const sup = await db()
      .select()
      .from(edges)
      .where(and(eq(edges.projectId, p?.id as string), eq(edges.kind, 'supersedes')))
    expect(sup.filter((e) => e.dstRef.startsWith('shared:')).map((e) => e.dstId)).toEqual([null])
  })

  it('a future last_verified is clamped to the import time (D-clamp)', async () => {
    const { app } = buildApp()
    const { acme } = await seed()
    const ia = await adminClient(app)
    const res = await upload(
      app,
      ia,
      '/api/v1/projects/acme/import',
      folder({ 'memories/new-note.md': '---\ntype: fact\nlast_verified: 2099-01-01\n---\nx\n' }),
    )
    expect(res.status).toBe(200)
    const [row] = await db()
      .select()
      .from(items)
      .where(and(eq(items.projectId, acme.id), eq(items.slug, 'new-note')))
    expect(row?.lastVerifiedAt.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('a folder import claims the target project’s dangling links (D-claim)', async () => {
    const { app } = buildApp()
    const { acme, ids } = await seed()
    await db()
      .insert(edges)
      .values({ projectId: acme.id, srcId: ids.m1, kind: 'wikilink', dstRef: 'new-note', dstId: null })
    const ia = await adminClient(app)
    const res = await upload(
      app,
      ia,
      '/api/v1/projects/acme/import',
      folder({ 'memories/new-note.md': '---\ntype: fact\n---\nx\n' }),
    )
    expect(res.status).toBe(200)
    const [created] = await db()
      .select()
      .from(items)
      .where(and(eq(items.projectId, acme.id), eq(items.slug, 'new-note')))
    const [link] = await db()
      .select()
      .from(edges)
      .where(and(eq(edges.srcId, ids.m1), eq(edges.dstRef, 'new-note')))
    expect(link?.dstId).toBe(created?.id)
  })
})

// ---- library pages (ADR-0014) ----------------------------------------------------------------------------

describe('import: library pages (ADR-0014)', () => {
  type Body = {
    counts: Record<string, number>
    dangling_edges: { from: string; dst_ref: string }[]
    notes: string[]
  }
  const edgeRow = (
    projectId: string,
    srcId: string,
    kind: (typeof edges.$inferInsert)['kind'],
    dstRef: string,
    dstId: string | null,
  ) => ({ projectId, srcId, kind, dstRef, dstId })

  /** seed() plus library page `graphics-guide` in acme: m1 refines it, it refines m2 and links [[auth-flow]]. */
  async function seedLibrary() {
    const s = await seed()
    const lib = await createItem(db(), {
      projectId: s.acme.id,
      space: 'library',
      slug: 'graphics-guide',
      title: 'Graphics guide',
      body: 'Use tokens. See [[auth-flow]].\n',
    })
    await db()
      .insert(edges)
      .values([
        edgeRow(s.acme.id, s.ids.m1, 'refines', lib.id, lib.id),
        edgeRow(s.acme.id, lib.id, 'refines', s.ids.m2, s.ids.m2),
        edgeRow(s.acme.id, lib.id, 'wikilink', 'auth-flow', s.ids.d4),
      ])
    return { ...s, lib }
  }

  /** Rewrite the manifest of an export zip. */
  function withManifest(zip: Uint8Array, fn: (m: Exported['manifest']) => void): Uint8Array {
    const files = Object.fromEntries(readZip(zip, allow))
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json'])) as Exported['manifest']
    fn(manifest)
    files['manifest.json'] = strToU8(JSON.stringify(manifest))
    return writeZip(files, new Date())
  }

  const projectId = async (slug: string) =>
    ((await db().select().from(projects).where(eq(projects.slug, slug)))[0] as { id: string }).id

  it('a lossless round trip keeps the page, its revisions and its links both ways', async () => {
    const { app } = buildApp()
    const { acme, lib } = await seedLibrary()
    const ia = await adminClient(app)
    const zip = await bytes(await ia.get('/api/v1/projects/acme/export'))
    const first = parseExport(zip)
    expect(first.names).toContain('library/graphics-guide.md')

    await purgeProject(acme.id)
    const res = await upload(app, ia, '/api/v1/projects/import', zip, { slug: 'acme' })
    expect(res.status).toBe(200)
    expect(await json<Body>(res)).toMatchObject({ counts: { items: 7, edges: 11 }, dangling_edges: [] })
    const second = parseExport(await bytes(await ia.get('/api/v1/projects/acme/export')))
    expect(normalise(second)).toEqual(normalise(first))
    const [row] = await db().select().from(items).where(eq(items.id, lib.id))
    expect(row).toMatchObject({ space: 'library', lifecycle: 'active', provenance: 'human', pinned: false })
    const linked = await db()
      .select()
      .from(edges)
      .where(inArray(edges.srcId, [lib.id]))
    expect(linked.map((e) => `${e.kind}:${e.dstId === null ? 'null' : 'set'}`).sort()).toEqual([
      'refines:set',
      'wikilink:set',
    ])
    expect((await db().select().from(edges).where(eq(edges.dstId, lib.id))).map((e) => e.kind)).toEqual([
      'refines',
    ])
  })

  it('a crafted manifest is normalised to the library shape and the change is noted', async () => {
    const { app } = buildApp()
    const { lib } = await seedLibrary()
    const ia = await adminClient(app)
    const zip = withManifest(await bytes(await ia.get('/api/v1/projects/acme/export')), (m) => {
      const it = m.items.find((i) => i.id === lib.id) as Record<string, unknown>
      Object.assign(it, {
        lifecycle: 'stale',
        stale_since: '2026-09-10T00:00:00.000Z',
        expires_at: '2026-12-01T00:00:00.000Z',
        source_path: 'docs/graphics.md',
        push_conflict_at: '2026-09-11T00:00:00.000Z',
        pinned: true,
        provenance: 'agent',
      })
    })
    const res = await upload(app, ia, '/api/v1/projects/import', zip, { slug: 'crafted', remap_ids: 'true' })
    expect(res.status).toBe(200)
    const body = await json<Body>(res)
    expect(body.notes).toContain(
      'library/graphics-guide.md: library page normalised (stale → active, expiry dropped, unpinned, provenance human, not repo-mirrored).',
    )
    const [row] = await db()
      .select()
      .from(items)
      .where(and(eq(items.projectId, await projectId('crafted')), eq(items.space, 'library')))
    expect(row).toMatchObject({
      lifecycle: 'active',
      staleSince: null,
      expiresAt: null,
      sourcePath: null,
      pushConflictAt: null,
      pinned: false,
      provenance: 'human',
      status: 'active',
    })
  })

  it('drops and lists conflicts_with / supersedes across the boundary; keeps library → other links', async () => {
    const { app } = buildApp()
    const { ids, lib } = await seedLibrary()
    const ia = await adminClient(app)
    const extra = (src: string, kind: string, dstRef: string, dstId: string | null) => ({
      id: uuid(),
      src_id: src,
      kind,
      dst_ref: dstRef,
      dst_id: dstId,
      created_at: '2026-09-05T10:00:00.000Z',
      created_by_label: 'ann@example.com',
      client_name: null,
    })
    const zip = withManifest(await bytes(await ia.get('/api/v1/projects/acme/export')), (m) => {
      m.edges.push(
        extra(lib.id, 'conflicts_with', ids.m1, ids.m1),
        extra(ids.m3, 'conflicts_with', lib.id, lib.id),
        extra(ids.m2, 'supersedes', lib.id, lib.id),
        extra(lib.id, 'conflicts_with', 'shared:docs/nowhere', null),
        extra(lib.id, 'supports', 'shared:docs/nowhere', null),
        extra(lib.id, 'depends_on', ids.d4, ids.d4),
      )
    })
    const res = await upload(app, ia, '/api/v1/projects/import', zip, { slug: 'dropped', remap_ids: 'true' })
    expect(res.status).toBe(200)
    const body = await json<Body>(res)
    // seed's 8 edges, the library page's 3, two of the six added
    expect(body.counts.edges).toBe(13)
    expect(body.notes.filter((n) => n.includes('dropped (library link rule)'))).toHaveLength(4)
    expect(body.notes.some((n) => n.includes('conflicts_with edge to shared:docs/nowhere dropped'))).toBe(
      true,
    )
    expect(body.dangling_edges).toContainEqual({ from: 'L57', dst_ref: 'shared:docs/nowhere' })

    const pid = await projectId('dropped')
    const [newLib] = await db()
      .select()
      .from(items)
      .where(and(eq(items.projectId, pid), eq(items.space, 'library')))
    const all = await db().select().from(edges).where(eq(edges.projectId, pid))
    const libId = newLib?.id as string
    expect(
      all.filter((e) => e.kind === 'conflicts_with' || e.kind === 'supersedes').map((e) => e.srcId),
    ).toEqual(
      // only seed's own m6 supersedes m1 is left
      [all.find((e) => e.kind === 'supersedes')?.srcId],
    )
    expect(all.some((e) => e.dstId === libId && e.kind !== 'refines')).toBe(false)
    expect(
      all
        .filter((e) => e.srcId === libId)
        .map((e) => e.kind)
        .sort(),
    ).toEqual(['depends_on', 'refines', 'supports', 'wikilink'])
  })

  it('renames handle-shaped slugs (l3 → x-l3) in an archive and a folder, with a note', async () => {
    const { app } = buildApp()
    const { acme, ids } = await seed()
    const l3 = await createItem(db(), { projectId: acme.id, space: 'docs', slug: 'l3', title: 'Level three' })
    await db()
      .insert(edges)
      .values(edgeRow(acme.id, ids.m2, 'wikilink', 'l3', l3.id))
    const ia = await adminClient(app)
    const zip = await bytes(await ia.get('/api/v1/projects/acme/export'))
    const res = await upload(app, ia, '/api/v1/projects/import', zip, { slug: 'renamed', remap_ids: 'true' })
    expect(res.status).toBe(200)
    expect((await json<Body>(res)).notes).toContain(
      'docs/l3.md: the slug "l3" has the shape of a handle; imported as "x-l3".',
    )
    const pid = await projectId('renamed')
    const [doc] = await db()
      .select()
      .from(items)
      .where(and(eq(items.projectId, pid), eq(items.title, 'Level three')))
    expect(doc?.slug).toBe('x-l3')
    const [link] = await db()
      .select()
      .from(edges)
      .where(and(eq(edges.projectId, pid), eq(edges.dstId, doc?.id as string)))
    expect(link).toMatchObject({ kind: 'wikilink', dstRef: 'x-l3' })

    const folder = writeZip({ 'docs/l7.md': strToU8('# Seven\n') }, new Date())
    const f = await upload(app, ia, '/api/v1/projects/acme/import', folder)
    expect(f.status).toBe(200)
    expect((await json<Body>(f)).notes).toContain(
      'docs/l7.md: the slug "l7" has the shape of a handle; imported as "x-l7".',
    )
    const [seven] = await db()
      .select()
      .from(items)
      .where(and(eq(items.projectId, acme.id), eq(items.title, 'Seven')))
    expect(seven?.slug).toBe('x-l7')
  })

  it('a folder with library/ into a non-empty project: claims follow the library link rule', async () => {
    const { app } = buildApp()
    const { acme, ids } = await seed()
    const old = await createItem(db(), {
      projectId: acme.id,
      space: 'library',
      slug: 'old-guide',
      title: 'Old guide',
    })
    await db()
      .insert(edges)
      .values([
        edgeRow(acme.id, old.id, 'wikilink', 'graphics-guide', null),
        edgeRow(acme.id, old.id, 'wikilink', 'deploy-runbook', null),
        edgeRow(acme.id, old.id, 'wikilink', 'auth-flow', ids.d4),
        edgeRow(acme.id, ids.m2, 'wikilink', 'graphics-guide', null),
        edgeRow(acme.id, ids.m2, 'wikilink', 'deploy-runbook', null),
      ])
    const pa = await createUser(db(), { email: 'pa@example.com' })
    await addMember(db(), acme.id, pa.id, 'admin')
    const c = await loginAs(app, 'pa@example.com', DEFAULT_PASSWORD)
    const zip = writeZip(
      {
        'library/graphics-guide.md': strToU8(
          '---\npinned: true\nrelations:\n  - kind: refines\n    to: deploy-runbook\n---\n# Graphics guide\n\nSee [[auth-flow]] and [[m1]].\n',
        ),
        'library/auth-flow.md': strToU8('# Auth flow for designers\n'),
        'docs/deploy-runbook.md': strToU8('# Deploy runbook\n'),
      },
      new Date(),
    )
    const res = await upload(app, c, '/api/v1/projects/acme/import', zip)
    expect(res.status).toBe(200)
    expect((await json<Body>(res)).notes).toContain(
      'library/graphics-guide.md: library page normalised (unpinned).',
    )

    const rows = await db().select().from(items).where(eq(items.projectId, acme.id))
    const by = (space: string, slug: string) =>
      rows.find((r) => r.space === space && r.slug === slug) as (typeof rows)[number]
    const guide = by('library', 'graphics-guide')
    const libAuth = by('library', 'auth-flow')
    const runbook = by('docs', 'deploy-runbook')
    expect(guide).toMatchObject({ pinned: false, provenance: 'human', lifecycle: 'active' })
    const link = async (src: string, ref: string) =>
      (
        await db()
          .select()
          .from(edges)
          .where(and(eq(edges.srcId, src), eq(edges.dstRef, ref)))
      )[0]?.dstId
    // a memory's dangling links are claimed by any new item
    expect(await link(ids.m2, 'graphics-guide')).toBe(guide.id)
    expect(await link(ids.m2, 'deploy-runbook')).toBe(runbook.id)
    // a library page's dangling link only by a library page; its resolved link is never taken over
    expect(await link(old.id, 'graphics-guide')).toBe(guide.id)
    expect(await link(old.id, 'deploy-runbook')).toBeNull()
    expect(await link(old.id, 'auth-flow')).toBe(ids.d4)
    // a memory's resolved slug link moves to the library page (library ranks first for every source)
    expect(await link(ids.m1, 'auth-flow')).toBe(libAuth.id)
    // the new page's own links resolve in any space at import time (a human's choice of target)
    expect(await link(guide.id, 'auth-flow')).toBe(libAuth.id)
    expect(await link(guide.id, 'm1')).toBe(ids.m1)
    expect(await link(guide.id, runbook.id)).toBe(runbook.id)
  })

  it('the shared space with library pages imports into _shared; project library links obey the rule', async () => {
    const { app } = buildApp()
    const { shared, acme, ids } = await seed()
    const house = await createItem(db(), {
      projectId: shared.id,
      space: 'library',
      slug: 'house-style',
      title: 'House style',
    })
    const lib = await createItem(db(), {
      projectId: acme.id,
      space: 'library',
      slug: 'graphics-guide',
      title: 'Graphics guide',
    })
    await db()
      .insert(edges)
      .values([
        edgeRow(acme.id, lib.id, 'refines', 'shared:library/house-style', house.id),
        edgeRow(acme.id, lib.id, 'wikilink', 'shared:style-guide', null),
        edgeRow(acme.id, lib.id, 'conflicts_with', 'shared:docs/style-guide', null),
        edgeRow(acme.id, ids.m2, 'supports', 'shared:library/house-style', house.id),
      ])
    const ia = await adminClient(app)
    const sharedZip = await bytes(await ia.get('/api/v1/projects/_shared/export'))
    expect(parseExport(sharedZip).names).toContain('library/house-style.md')
    await purgeSharedItems(shared.id)

    const res = await upload(app, ia, '/api/v1/projects/_shared/import', sharedZip)
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ project: { slug: '_shared' }, counts: { items: 3 } })
    const [back] = await db()
      .select()
      .from(items)
      .where(and(eq(items.projectId, shared.id), eq(items.space, 'library')))
    expect(back).toMatchObject({ id: house.id, slug: 'house-style', provenance: 'human' })
    const e = await db().select().from(edges).where(eq(edges.projectId, acme.id))
    const dst = (src: string, kind: string, ref: string) =>
      e.find((x) => x.srcId === src && x.kind === kind && x.dstRef === ref)?.dstId
    expect(dst(lib.id, 'refines', 'shared:library/house-style')).toBe(house.id)
    expect(dst(ids.m2, 'supports', 'shared:library/house-style')).toBe(house.id)
    // not captured by the shared doc, and no SPL01 from the conflicts_with ref
    expect(dst(lib.id, 'wikilink', 'shared:style-guide')).toBeNull()
    expect(dst(lib.id, 'conflicts_with', 'shared:docs/style-guide')).toBeNull()
    expect(dst(ids.m1, 'wikilink', 'shared:style-guide')).toBe(ids.sDoc)
  })
})
