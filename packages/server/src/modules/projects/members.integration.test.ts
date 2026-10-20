// Memberships (api.md 4.2; auth-and-security.md 7 rules: last project admin).
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import {
  addMember,
  createAdmin,
  createProject,
  createSharedProject,
  createToken,
  createUser,
  DEFAULT_PASSWORD,
} from '../../../test/factories.js'
import { json, loginAs, testApp } from '../../../test/http.js'
import { auditLog, memberships } from '../../db/schema.js'

const db = () => testDb()

async function setup() {
  const { app } = testApp()
  const p = await createProject(db(), { slug: 'acme' })
  const pa = await createUser(db(), { email: 'pa@example.com' })
  await addMember(db(), p.id, pa.id, 'admin')
  const paC = await loginAs(app, pa.email, DEFAULT_PASSWORD)
  return { app, p, pa, paC }
}

type Member = { user: { id: string; email: string }; role: string; library_editor: boolean }

describe('/api/v1/projects/:slug/members', () => {
  it('a project admin lists, adds by email, changes roles and removes members (audited)', async () => {
    const { p, paC } = await setup()
    const ann = await createUser(db(), { email: 'ann@example.com', name: 'Ann' })

    const added = await paC.post('/api/v1/projects/acme/members', {
      email: ' ANN@example.com ',
      role: 'viewer',
    })
    expect(added.status).toBe(201)
    expect(await json<Member>(added)).toMatchObject({
      user: { id: ann.id, email: 'ann@example.com', name: 'Ann' },
      role: 'viewer',
    })
    const list = await json<{ items: Member[] }>(await paC.get('/api/v1/projects/acme/members'))
    expect(list.items.map((m) => [m.user.email, m.role])).toEqual([
      ['ann@example.com', 'viewer'],
      ['pa@example.com', 'admin'],
    ])

    const put = await paC.request('PUT', `/api/v1/projects/acme/members/${ann.id}`, {
      body: { role: 'editor' },
    })
    expect(put.status).toBe(200)
    expect((await json<Member>(put)).role).toBe('editor')

    expect((await paC.delete(`/api/v1/projects/acme/members/${ann.id}`)).status).toBe(204)
    expect(await db().select().from(memberships).where(eq(memberships.userId, ann.id))).toHaveLength(0)

    const audits = await db().select().from(auditLog).where(eq(auditLog.projectId, p.id)).orderBy(auditLog.id)
    expect(audits.map((a) => a.action)).toEqual(['member.set', 'member.set', 'member.remove'])
    expect(audits[1]?.data).toEqual({
      user_id: ann.id,
      role: 'editor',
      previous: 'viewer',
      library_editor: false,
      previous_library_editor: false,
    })
  })

  it('404 user_not_found with the invite hint; 409 already_exists', async () => {
    const { paC, pa } = await setup()
    const missing = await paC.post('/api/v1/projects/acme/members', {
      email: 'nobody@example.com',
      role: 'viewer',
    })
    expect(missing.status).toBe(404)
    expect(await json(missing)).toMatchObject({ error: 'user_not_found', hint: 'create an invite instead' })
    const dup = await paC.post('/api/v1/projects/acme/members', { email: pa.email, role: 'viewer' })
    expect(dup.status).toBe(409)
    expect((await json(dup)).error).toBe('already_exists')
    expect((await paC.post('/api/v1/projects/acme/members', { email: pa.email, role: 'owner' })).status).toBe(
      400,
    )
  })

  it('the last project admin can be neither demoted nor removed', async () => {
    const { paC, pa, p, app } = await setup()
    const put = await paC.request('PUT', `/api/v1/projects/acme/members/${pa.id}`, {
      body: { role: 'editor' },
    })
    expect(put.status).toBe(409)
    expect((await json(put)).error).toBe('last_admin')
    expect((await paC.delete(`/api/v1/projects/acme/members/${pa.id}`)).status).toBe(409)

    // an instance admin is bound by the same rule
    const admin = await createAdmin(db())
    const ia = await loginAs(app, admin.email, DEFAULT_PASSWORD)
    expect((await ia.delete(`/api/v1/projects/acme/members/${pa.id}`)).status).toBe(409)

    // with a second admin, demotion works
    const bob = await createUser(db())
    await addMember(db(), p.id, bob.id, 'admin')
    const ok = await paC.request('PUT', `/api/v1/projects/acme/members/${pa.id}`, {
      body: { role: 'viewer' },
    })
    expect(ok.status).toBe(200)
  })

  it('editors and viewers may not manage members, but may leave', async () => {
    const { app, p, pa } = await setup()
    const ed = await createUser(db())
    await addMember(db(), p.id, ed.id, 'editor')
    const c = await loginAs(app, ed.email, DEFAULT_PASSWORD)
    expect((await c.get('/api/v1/projects/acme/members')).status).toBe(403)
    expect((await c.post('/api/v1/projects/acme/members', { email: pa.email, role: 'viewer' })).status).toBe(
      403,
    )
    expect(
      (await c.request('PUT', `/api/v1/projects/acme/members/${pa.id}`, { body: { role: 'viewer' } })).status,
    ).toBe(403)
    expect((await c.delete(`/api/v1/projects/acme/members/${pa.id}`)).status).toBe(403)
    expect((await c.delete(`/api/v1/projects/acme/members/${ed.id}`)).status).toBe(204)
    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.projectId, p.id), eq(auditLog.action, 'member.remove')))
    expect(audit?.data).toMatchObject({ self: true })
    // no longer a member: the project is now invisible
    expect((await c.get('/api/v1/projects/acme')).status).toBe(404)
  })

  it('removing a membership makes the user’s project tokens unusable at once', async () => {
    const { app, p, paC } = await setup()
    const ann = await createUser(db())
    await addMember(db(), p.id, ann.id, 'editor')
    const t = await createToken(db(), { projectId: p.id, userId: ann.id })
    const whoami = () =>
      app.request('/p/acme/api/whoami', { headers: { authorization: `Bearer ${t.secret}` } })
    expect((await whoami()).status).toBe(200)
    expect((await paC.delete(`/api/v1/projects/acme/members/${ann.id}`)).status).toBe(204)
    expect((await whoami()).status).toBe(401)
    // re-adding the user (any role) does not revive the old token: removal revoked it (phase-2 review S3)
    expect(
      (await paC.post('/api/v1/projects/acme/members', { email: ann.email, role: 'viewer' })).status,
    ).toBe(201)
    expect((await whoami()).status).toBe(401)
    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.projectId, p.id), eq(auditLog.action, 'member.remove')))
    expect(audit?.data).toMatchObject({ tokens_revoked: 1 })
  })

  it('the shared project has no members (404); unknown member ids are 404', async () => {
    const { paC, app } = await setup()
    await createSharedProject(db())
    const admin = await createAdmin(db())
    const ia = await loginAs(app, admin.email, DEFAULT_PASSWORD)
    expect((await ia.get('/api/v1/projects/_shared/members')).status).toBe(404)
    expect(
      (await ia.post('/api/v1/projects/_shared/members', { email: admin.email, role: 'admin' })).status,
    ).toBe(404)
    const u = await createUser(db())
    expect(
      (await paC.request('PUT', `/api/v1/projects/acme/members/${u.id}`, { body: { role: 'viewer' } }))
        .status,
    ).toBe(404)
    expect((await paC.delete('/api/v1/projects/acme/members/not-a-uuid')).status).toBe(404)
  })
})

describe('library_editor flag (auth-and-security.md 7)', () => {
  const put = (c: Awaited<ReturnType<typeof setup>>['paC'], id: string, body: Record<string, unknown>) =>
    c.request('PUT', `/api/v1/projects/acme/members/${id}`, { body })
  const flagOf = async (userId: string) =>
    (await db().select().from(memberships).where(eq(memberships.userId, userId)))[0]?.libraryEditor

  it('POST stores the flag (default false, ignored for admin); lists and responses carry it', async () => {
    const { paC } = await setup()
    const ann = await createUser(db(), { email: 'ann@example.com' })
    const bob = await createUser(db(), { email: 'bob@example.com' })
    const cy = await createUser(db(), { email: 'cy@example.com' })
    const a = await paC.post('/api/v1/projects/acme/members', {
      email: ann.email,
      role: 'viewer',
      library_editor: true,
    })
    expect(a.status).toBe(201)
    expect((await json<Member>(a)).library_editor).toBe(true)
    const b = await paC.post('/api/v1/projects/acme/members', { email: bob.email, role: 'editor' })
    expect((await json<Member>(b)).library_editor).toBe(false)
    const c = await paC.post('/api/v1/projects/acme/members', {
      email: cy.email,
      role: 'admin',
      library_editor: true,
    })
    expect((await json<Member>(c)).library_editor).toBe(false)
    const list = await json<{ items: Member[] }>(await paC.get('/api/v1/projects/acme/members'))
    expect(list.items.map((m) => [m.user.email, m.library_editor])).toEqual([
      ['ann@example.com', true],
      ['bob@example.com', false],
      ['cy@example.com', false],
      ['pa@example.com', false],
    ])
  })

  it('PUT sets the flag alone, keeps it across viewer/editor changes and audits it', async () => {
    const { p, paC } = await setup()
    const ann = await createUser(db())
    await addMember(db(), p.id, ann.id, 'viewer')
    const r = await put(paC, ann.id, { library_editor: true })
    expect(r.status).toBe(200)
    expect(await json<Member>(r)).toMatchObject({ role: 'viewer', library_editor: true })
    expect((await json<Member>(await put(paC, ann.id, { role: 'editor' }))).library_editor).toBe(true)
    expect(await flagOf(ann.id)).toBe(true)
    // unchanged: no write, no audit
    await put(paC, ann.id, { library_editor: true })
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.projectId, p.id), eq(auditLog.action, 'member.set')))
      .orderBy(auditLog.id)
    expect(audits).toHaveLength(2)
    expect(audits[0]?.data).toMatchObject({ library_editor: true, previous_library_editor: false })
    expect(audits[0]?.summary).toContain('granted library editing')
    expect((await put(paC, ann.id, {})).status).toBe(400)
  })

  it('promoting to admin clears the flag; demoting sets library_editor ?? false (audited as implied)', async () => {
    const { p, paC } = await setup()
    const ann = await createUser(db())
    await addMember(db(), p.id, ann.id, 'editor', { libraryEditor: true })
    expect((await json<Member>(await put(paC, ann.id, { role: 'admin' }))).library_editor).toBe(false)
    expect(await flagOf(ann.id)).toBe(false)
    const [promo] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.projectId, p.id), eq(auditLog.action, 'member.set')))
    expect(promo?.summary).toContain('revoked library editing')
    expect(promo?.summary).toContain('(implied by role change)')

    expect((await json<Member>(await put(paC, ann.id, { role: 'editor' }))).library_editor).toBe(false)
    await put(paC, ann.id, { role: 'admin' })
    const kept = await put(paC, ann.id, { role: 'viewer', library_editor: true })
    expect(await json<Member>(kept)).toMatchObject({ role: 'viewer', library_editor: true })
  })

  it('the last admin cannot be demoted even with a flag in the body; leaving removes the flag with the row', async () => {
    const { app, p, pa, paC } = await setup()
    expect((await put(paC, pa.id, { role: 'editor', library_editor: true })).status).toBe(409)
    const ann = await createUser(db())
    await addMember(db(), p.id, ann.id, 'viewer', { libraryEditor: true })
    const c = await loginAs(app, ann.email, DEFAULT_PASSWORD)
    expect((await c.delete(`/api/v1/projects/acme/members/${ann.id}`)).status).toBe(204)
    expect(await flagOf(ann.id)).toBeUndefined()
  })
})
