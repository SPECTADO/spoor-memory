// Reading the audit log (api.md section 10).
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
import { Client, json, loginAs, testApp } from '../../../test/http.js'
import { type AuditActor, systemActor, writeAudit } from '../../lib/audit.js'
import type { AuthContext } from '../../lib/auth-context.js'

const db = () => testDb()

type Row = {
  id: number
  action: string
  item_handle: string | null
  item_id: string | null
  actor: { label: string; via: string; client_name: string | null; user_id: string | null }
}
type Page = { items: Row[]; next_cursor: string | null }

const agent = (label: string): AuditActor => ({
  ctx: {
    user: null,
    project: null,
    role: 'editor',
    via: 'bearer',
    tokenName: label,
    clientName: 'claude-code/2.1',
  },
  via: 'mcp',
})

async function setup() {
  const { app } = testApp()
  const p = await createProject(db(), { slug: 'acme' })
  const viewer = await createUser(db(), { email: 'vi@example.com' })
  await addMember(db(), p.id, viewer.id, 'viewer')
  const ann: AuthContext = {
    user: { id: viewer.id, email: 'ann@example.com', name: 'Ann', isAdmin: false, sharedEditor: false },
    project: null,
    role: null,
    via: 'cookie',
    clientName: 'web',
  }
  const item = await createItem(db(), { projectId: p.id }) // m1
  await writeAudit(
    db(),
    { ctx: ann, via: 'web' },
    { projectId: p.id, action: 'item.create', summary: 'a', itemId: item.id, itemHandle: 'm1' },
  )
  await writeAudit(db(), agent('ci'), {
    projectId: p.id,
    action: 'item.update',
    summary: 'b',
    itemId: item.id,
    itemHandle: 'm1',
  })
  await writeAudit(db(), agent('ci'), { projectId: p.id, action: 'edge.add', summary: 'c' })
  // an item deleted since: only its handle snapshot remains
  await writeAudit(
    db(),
    { ctx: ann, via: 'web' },
    { projectId: p.id, action: 'item.delete', summary: 'd', itemHandle: 'm7' },
  )
  await writeAudit(db(), systemActor, {
    projectId: p.id,
    action: 'item.stale',
    summary: 'e',
    itemId: item.id,
    itemHandle: 'm1',
  })
  // other project and instance-level rows never show up in acme's log
  const other = await createProject(db(), { slug: 'other' })
  await writeAudit(db(), systemActor, { projectId: other.id, action: 'item.create', summary: 'x' })
  await writeAudit(db(), systemActor, { action: 'user.create', summary: 'y' })
  const c = await loginAs(app, viewer.email, DEFAULT_PASSWORD)
  return { app, p, c, item }
}

describe('GET /api/v1/projects/:slug/audit', () => {
  it('members read the project log newest first with actor objects', async () => {
    const { c } = await setup()
    const page = await json<Page>(await c.get('/api/v1/projects/acme/audit'))
    expect(page.items.map((r) => r.action)).toEqual([
      'item.stale',
      'item.delete',
      'edge.add',
      'item.update',
      'item.create',
    ])
    expect(page.items[1]).toMatchObject({ item_handle: 'm7', item_id: null })
    expect(page.items[3]?.actor).toEqual({
      user_id: null,
      label: 'service:ci',
      via: 'mcp',
      client_name: 'claude-code/2.1',
    })
    expect(page.next_cursor).toBeNull()
  })

  it('filters: action (exact and prefix), actor substring, via, item ref, time range', async () => {
    const { c } = await setup()
    const actions = async (q: string) =>
      (await json<Page>(await c.get(`/api/v1/projects/acme/audit?${q}`))).items.map((r) => r.action)
    expect(await actions('action=edge.add')).toEqual(['edge.add'])
    expect(await actions('action=item.&action=edge.add')).toEqual([
      'item.stale',
      'item.delete',
      'edge.add',
      'item.update',
      'item.create',
    ])
    expect(await actions('action=item.')).toHaveLength(4)
    expect(await actions('action=item%25')).toEqual([]) // LIKE wildcards are escaped
    expect(await actions('actor=CI')).toEqual(['edge.add', 'item.update'])
    expect(await actions('via=system')).toEqual(['item.stale'])
    expect(await actions('item=m1')).toEqual(['item.stale', 'item.update', 'item.create'])
    expect(await actions('item=m7')).toEqual(['item.delete']) // deleted item: by handle snapshot
    expect(await actions('item=no-such-slug')).toEqual([])
    expect(await actions('since=2099-01-01T00:00:00Z')).toEqual([])
    expect(await actions('until=2099-01-01T00:00:00Z')).toHaveLength(5)
    expect((await c.get('/api/v1/projects/acme/audit?via=email')).status).toBe(400)
    expect((await c.get('/api/v1/projects/acme/audit?bogus=1')).status).toBe(400)
  })

  it('cursor pagination on id desc never skips or repeats', async () => {
    const { c } = await setup()
    const first = await json<Page>(await c.get('/api/v1/projects/acme/audit?limit=2'))
    const second = await json<Page>(
      await c.get(`/api/v1/projects/acme/audit?limit=2&cursor=${first.next_cursor}`),
    )
    const third = await json<Page>(
      await c.get(`/api/v1/projects/acme/audit?limit=2&cursor=${second.next_cursor}`),
    )
    const ids = [...first.items, ...second.items, ...third.items].map((r) => r.id)
    expect(ids).toHaveLength(5)
    expect([...ids].sort((a, b) => b - a)).toEqual(ids)
    expect(third.next_cursor).toBeNull()
    expect((await c.get('/api/v1/projects/acme/audit?cursor=garbage')).status).toBe(400)
  })

  it('non-members get 404; _shared is readable by any logged-in user; anonymous is 401', async () => {
    const { app } = await setup()
    const shared = await createSharedProject(db())
    await writeAudit(db(), systemActor, { projectId: shared.id, action: 'item.create', summary: 's' })
    const stranger = await createUser(db())
    const s = await loginAs(app, stranger.email, DEFAULT_PASSWORD)
    expect((await s.get('/api/v1/projects/acme/audit')).status).toBe(404)
    const sharedLog = await json<Page>(await s.get('/api/v1/projects/_shared/audit'))
    expect(sharedLog.items.map((r) => r.action)).toEqual(['item.create'])
    expect((await new Client(app).get('/api/v1/projects/acme/audit')).status).toBe(401)
  })
})

describe('GET /api/v1/audit', () => {
  it('instance-level rows for instance admins only', async () => {
    const { app, c } = await setup()
    expect((await c.get('/api/v1/audit')).status).toBe(403)
    const admin = await createAdmin(db())
    const ia = await loginAs(app, admin.email, DEFAULT_PASSWORD)
    const page = await json<Page>(await ia.get('/api/v1/audit'))
    expect(page.items.map((r) => r.action)).toEqual(['user.create'])
    expect((await ia.get('/api/v1/audit?item=m1')).status).toBe(400) // no item filter at instance level
  })
})

describe('handle snapshots of _shared rows (phase-2 review SC1)', () => {
  it('are plain like the item page, and ?item= finds the history after a hard delete', async () => {
    const { app } = await setup()
    await createSharedProject(db())
    const admin = await createAdmin(db())
    const ia = await loginAs(app, admin.email, DEFAULT_PASSWORD)
    const created = await ia.post('/api/v1/projects/_shared/spaces/memories/items', {
      title: 'Rule',
      type: 'fact',
    })
    expect(created.status).toBe(201)
    const handle = (await json<{ item: { handle: string } }>(created)).item.handle
    expect(handle).toBe('m1')
    const log = await json<Page>(await ia.get('/api/v1/projects/_shared/audit'))
    expect(log.items.map((r) => `${r.action}:${r.item_handle ?? ''}`)).toContain('item.create:m1')
    expect((await ia.delete(`/api/v1/projects/_shared/items/m1?confirm=m1`)).status).toBe(204)
    const after = await json<Page>(await ia.get('/api/v1/projects/_shared/audit?item=m1'))
    expect(after.items.map((r) => r.action).sort()).toEqual(['item.create', 'item.delete'])
  })
})

describe('library handles (ADR-0014)', () => {
  it('?item=L<n> finds a library page’s history, live (either letter case) and after a hard delete', async () => {
    const { app } = await setup()
    const admin = await createAdmin(db())
    const ia = await loginAs(app, admin.email, DEFAULT_PASSWORD)
    const created = await ia.post('/api/v1/projects/acme/spaces/library/items', {
      title: 'Graphics guide',
      body: 'Use tokens.',
    })
    expect(created.status).toBe(201)
    const handle = (await json<{ item: { handle: string } }>(created)).item.handle
    expect(handle).toBe('L2') // m1 holds number 1 of the shared counter
    const actions = async (q: string) =>
      (await json<Page>(await ia.get(`/api/v1/projects/acme/audit?item=${q}`))).items.map(
        (r) => `${r.action}:${r.item_handle ?? ''}`,
      )
    expect(await actions('L2')).toEqual(['item.create:L2'])
    expect(await actions('l2')).toEqual(['item.create:L2'])
    // m2 / d2 name nothing: the number belongs to the library page
    expect(await actions('m2')).toEqual([])
    expect((await ia.delete('/api/v1/projects/acme/items/L2?confirm=L2')).status).toBe(204)
    expect((await actions('L2')).sort()).toEqual(['item.create:L2', 'item.delete:L2'])
    expect((await actions('l2')).sort()).toEqual(['item.create:L2', 'item.delete:L2'])
  })
})
