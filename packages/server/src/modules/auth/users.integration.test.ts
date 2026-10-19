// Instance-admin user management (api.md section 2.2; auth-and-security.md sections 3 and 7).
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import {
  addMember,
  createAdmin,
  createProject,
  createToken,
  createUser,
  DEFAULT_PASSWORD,
} from '../../../test/factories.js'
import { Client, json, loginAs, testApp } from '../../../test/http.js'
import { auditLog, memberships, sessions, tokens, users } from '../../db/schema.js'

const db = () => testDb()

async function setup() {
  const { app } = testApp()
  const admin = await createAdmin(db(), { email: 'admin@example.com' })
  const ia = await loginAs(app, admin.email, DEFAULT_PASSWORD)
  return { app, admin, ia }
}

describe('/api/v1/users', () => {
  it('is for instance admins only', async () => {
    const { app } = await setup()
    await createUser(db(), { email: 'ann@example.com' })
    const ann = await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)
    expect((await new Client(app).get('/api/v1/users')).status).toBe(401)
    const res = await ann.get('/api/v1/users')
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('forbidden')
    expect((await ann.patch(`/api/v1/users/${(await createUser(db())).id}`, { is_admin: true })).status).toBe(
      403,
    )
  })

  it('lists with prefix search, memberships and cursor pagination', async () => {
    const { ia } = await setup()
    const p = await createProject(db(), { slug: 'acme', name: 'Acme' })
    const zed = await createUser(db(), { email: 'zed@example.com', name: 'Zed' })
    await createUser(db(), { email: 'bob@example.com', name: 'Robert' })
    await createUser(db(), { email: 'carol@example.com', name: 'Carol' })
    await addMember(db(), p.id, zed.id, 'viewer')

    const first = await json<{ items: { email: string }[]; next_cursor: string }>(
      await ia.get('/api/v1/users?limit=2'),
    )
    expect(first.items.map((u) => u.email)).toEqual(['admin@example.com', 'bob@example.com'])
    const second = await json<{ items: { email: string }[]; next_cursor: string | null }>(
      await ia.get(`/api/v1/users?limit=2&cursor=${first.next_cursor}`),
    )
    expect(second.items.map((u) => u.email)).toEqual(['carol@example.com', 'zed@example.com'])
    expect(second.next_cursor).toBeNull()

    const byName = await json<{ items: { email: string }[] }>(await ia.get('/api/v1/users?q=rob'))
    expect(byName.items.map((u) => u.email)).toEqual(['bob@example.com'])
    const wild = await json<{ items: unknown[] }>(await ia.get('/api/v1/users?q=%25'))
    expect(wild.items).toHaveLength(0) // LIKE wildcards are escaped

    const one = await json(await ia.get(`/api/v1/users/${zed.id}`))
    expect(one).toMatchObject({
      email: 'zed@example.com',
      disabled_at: null,
      memberships: [{ project: { slug: 'acme', name: 'Acme' }, role: 'viewer' }],
    })
    expect((await ia.get('/api/v1/users/not-a-uuid')).status).toBe(404)
    expect((await ia.get('/api/v1/users/00000000-0000-4000-8000-000000000000')).status).toBe(404)
  })

  it('disabling deletes the user’s sessions and blocks login; enabling restores it', async () => {
    const { app, ia } = await setup()
    const ann = await createUser(db(), { email: 'ann@example.com' })
    const s = await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)
    const res = await ia.patch(`/api/v1/users/${ann.id}`, { disabled: true })
    expect(res.status).toBe(200)
    expect((await json<{ disabled_at: string | null }>(res)).disabled_at).not.toBeNull()
    expect(await db().select().from(sessions).where(eq(sessions.userId, ann.id))).toHaveLength(0)
    expect((await s.get('/api/v1/me')).status).toBe(401)
    expect(
      (
        await new Client(app).post('/api/v1/auth/login', {
          email: 'ann@example.com',
          password: DEFAULT_PASSWORD,
        })
      ).status,
    ).toBe(401)

    expect((await ia.patch(`/api/v1/users/${ann.id}`, { disabled: false })).status).toBe(200)
    await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)
    const audit = await db().select().from(auditLog).where(eq(auditLog.action, 'user.update'))
    expect(audit.map((a) => (a.data as { fields: string[] }).fields)).toEqual([['disabled'], ['enabled']])
  })

  it('updates flags and the name (control characters stripped)', async () => {
    const { ia } = await setup()
    const ann = await createUser(db(), { email: 'ann@example.com' })
    const res = await ia.patch(`/api/v1/users/${ann.id}`, {
      name: 'Ann⁦ B',
      shared_editor: true,
      is_admin: true,
    })
    expect(await json(res)).toMatchObject({ name: 'Ann B', shared_editor: true, is_admin: true })
    expect((await ia.patch(`/api/v1/users/${ann.id}`, { email: 'x@example.com' })).status).toBe(400)
  })

  it('never removes the last enabled instance admin (demote, disable, delete)', async () => {
    const { ia, admin } = await setup()
    await createAdmin(db(), { email: 'off-admin@example.com', disabled: true }) // a disabled admin does not count
    for (const patch of [{ is_admin: false }, { disabled: true }]) {
      const res = await ia.patch(`/api/v1/users/${admin.id}`, patch)
      expect(res.status, JSON.stringify(patch)).toBe(409)
      expect((await json(res)).error).toBe('last_admin')
    }
    const del = await ia.delete(`/api/v1/users/${admin.id}?confirm=admin@example.com`)
    expect(del.status).toBe(409)

    const second = await createAdmin(db(), { email: 'second@example.com' })
    expect((await ia.patch(`/api/v1/users/${second.id}`, { is_admin: false })).status).toBe(200)
    await createAdmin(db(), { email: 'third@example.com' })
    expect((await ia.patch(`/api/v1/users/${admin.id}`, { is_admin: false })).status).toBe(200)
    const [row] = await db().select().from(users).where(eq(users.id, admin.id))
    expect(row?.isAdmin).toBe(false)
    expect((await ia.get('/api/v1/users')).status).toBe(403) // the demotion is live for the session
  })

  it('delete needs ?confirm=<email> and cascades sessions, tokens and memberships', async () => {
    const { app, ia } = await setup()
    const p = await createProject(db(), { slug: 'acme' })
    const ann = await createUser(db(), { email: 'ann@example.com' })
    await addMember(db(), p.id, ann.id, 'editor')
    await createToken(db(), { projectId: p.id, userId: ann.id })
    const s = await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)

    expect((await ia.delete(`/api/v1/users/${ann.id}`)).status).toBe(400)
    expect((await ia.delete(`/api/v1/users/${ann.id}?confirm=bob@example.com`)).status).toBe(400)
    expect((await ia.delete(`/api/v1/users/${ann.id}?confirm=ANN@example.com`)).status).toBe(204)
    expect((await s.get('/api/v1/me')).status).toBe(401)
    expect(await db().select().from(tokens)).toHaveLength(0)
    expect(await db().select().from(memberships)).toHaveLength(0)
    const [audit] = await db().select().from(auditLog).where(eq(auditLog.action, 'user.delete'))
    expect(audit).toMatchObject({ projectId: null, via: 'web' })
    expect((await ia.delete(`/api/v1/users/${ann.id}?confirm=ann@example.com`)).status).toBe(404)
  })
})
