// Login, logout, /me, sessions and passwords (auth-and-security.md sections 2 and 3; api.md section 1).
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import { addMember, createProject, createUser, DEFAULT_PASSWORD } from '../../../test/factories.js'
import { Client, json, loginAs, testApp } from '../../../test/http.js'
import { auditLog, sessions, users } from '../../db/schema.js'
import { sha256 } from '../../lib/crypto.js'
import { hashPassword } from './passwords.js'

const db = () => testDb()

describe('login', () => {
  it('sets an HttpOnly SameSite=Lax session cookie and stores only its sha256', async () => {
    const { app } = testApp()
    const u = await createUser(db(), { email: 'ann@example.com' })
    const c = new Client(app)
    const res = await c.post('/api/v1/auth/login', { email: ' Ann@Example.com ', password: DEFAULT_PASSWORD })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      user: { id: u.id, email: 'ann@example.com', name: u.name, is_admin: false, shared_editor: false },
    })
    const [cookie] = res.headers.getSetCookie()
    expect(cookie).toMatch(/^spoor_sid=[A-Za-z0-9_-]{43};/)
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/SameSite=Lax/)
    expect(cookie).toMatch(/Path=\//)
    expect(cookie).toMatch(/Max-Age=2592000/)
    expect(cookie).not.toMatch(/Secure/)
    const sid = c.cookies.get('spoor_sid') as string
    const rows = await db().select().from(sessions)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.idHash.equals(sha256(sid))).toBe(true)
    // absolute expiry 30 days out
    const days = ((rows[0]?.expiresAt.getTime() ?? 0) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThan(30.1)
  })

  it('uses __Host-spoor_sid with Secure when SPOOR_PUBLIC_URL is https', async () => {
    const { app } = testApp({ env: { SPOOR_PUBLIC_URL: 'https://spoor.example.com' } })
    await createUser(db(), { email: 'ann@example.com' })
    const c = new Client(app, 'https://spoor.example.com')
    const res = await c.post('/api/v1/auth/login', { email: 'ann@example.com', password: DEFAULT_PASSWORD })
    expect(res.status).toBe(200)
    const [cookie] = res.headers.getSetCookie()
    expect(cookie).toMatch(/^__Host-spoor_sid=/)
    expect(cookie).toMatch(/Secure/)
    expect((await c.get('/api/v1/me')).status).toBe(200)
  })

  it('unknown email, wrong password and disabled user all answer the same 401', async () => {
    const { app } = testApp()
    await createUser(db(), { email: 'ann@example.com' })
    await createUser(db(), { email: 'off@example.com', disabled: true })
    const c = new Client(app)
    const bodies = []
    for (const [email, password] of [
      ['nobody@example.com', DEFAULT_PASSWORD],
      ['ann@example.com', 'wrong password!!'],
      ['off@example.com', DEFAULT_PASSWORD],
    ]) {
      const res = await c.post('/api/v1/auth/login', { email, password })
      expect(res.status).toBe(401)
      const b = await json(res)
      bodies.push({ error: b.error, message: b.message })
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1)
    expect(bodies[0]?.error).toBe('invalid_credentials')
    expect(c.cookies.size).toBe(0)
    expect(await db().select().from(sessions)).toHaveLength(0)
  })

  it('re-hashes a password stored with outdated parameters', async () => {
    const { app } = testApp()
    const old = await hashPassword(DEFAULT_PASSWORD, { logN: 14, r: 8, p: 1 })
    const u = await createUser(db(), { email: 'ann@example.com', passwordHash: old })
    await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)
    const [row] = await db().select().from(users).where(eq(users.id, u.id))
    expect(row?.passwordHash.startsWith('scrypt$17$8$1$')).toBe(true)
    await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)
  })

  it('issues a new session id on every login and drops the one the browser already had', async () => {
    const { app } = testApp()
    await createUser(db(), { email: 'ann@example.com' })
    const c = await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)
    const first = c.cookies.get('spoor_sid')
    const res = await c.post('/api/v1/auth/login', { email: 'ann@example.com', password: DEFAULT_PASSWORD })
    expect(res.status).toBe(200)
    const second = c.cookies.get('spoor_sid')
    expect(second).not.toBe(first)
    const rows = await db().select().from(sessions)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.idHash.equals(sha256(second as string))).toBe(true)
  })

  it('validates the body strictly', async () => {
    const { app } = testApp()
    const c = new Client(app)
    const res = await c.post('/api/v1/auth/login', { email: 'a@example.com', password: 'x', remember: true })
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ error: 'invalid_input', details: { issues: expect.any(Array) } })
    const bad = await c.request('POST', '/api/v1/auth/login', {
      raw: '{not json',
      headers: { 'content-type': 'application/json' },
    })
    expect(bad.status).toBe(400)
  })
})

describe('session lifecycle', () => {
  it('GET /me needs a session and lists memberships', async () => {
    const { app } = testApp()
    const u = await createUser(db(), { email: 'ann@example.com' })
    const p = await createProject(db(), { slug: 'acme', name: 'Acme' })
    await addMember(db(), p.id, u.id, 'editor')
    const anon = await new Client(app).get('/api/v1/me')
    expect(anon.status).toBe(401)
    expect(await json(anon)).toMatchObject({ error: 'unauthenticated', request_id: expect.any(String) })
    const c = await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)
    const me = await json(await c.get('/api/v1/me'))
    expect(me).toEqual({
      user: { id: u.id, email: 'ann@example.com', name: u.name, is_admin: false, shared_editor: false },
      memberships: [{ project: { id: p.id, slug: 'acme', name: 'Acme' }, role: 'editor' }],
    })
  })

  it('logout deletes the session row and clears the cookie', async () => {
    const { app } = testApp()
    await createUser(db(), { email: 'ann@example.com' })
    const c = await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)
    const sid = c.cookies.get('spoor_sid') as string
    const res = await c.post('/api/v1/auth/logout')
    expect(res.status).toBe(204)
    expect(res.headers.getSetCookie()[0]).toMatch(/^spoor_sid=;.*Max-Age=0/)
    expect(await db().select().from(sessions)).toHaveLength(0)
    // replaying the old cookie does not work
    const replay = new Client(app)
    replay.cookies.set('spoor_sid', sid)
    expect((await replay.get('/api/v1/me')).status).toBe(401)
    expect((await new Client(app).post('/api/v1/auth/logout')).status).toBe(401)
  })

  it('expires sessions absolutely after 30 days and when idle for 14 days', async () => {
    const { app } = testApp()
    const u = await createUser(db(), { email: 'ann@example.com' })
    const a = await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)
    const b = await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)
    const ha = sha256(a.cookies.get('spoor_sid') as string)
    const hb = sha256(b.cookies.get('spoor_sid') as string)
    await db()
      .update(sessions)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(sessions.idHash, ha))
    await db()
      .update(sessions)
      .set({ lastSeenAt: sql`now() - interval '14 days 1 minute'` })
      .where(eq(sessions.idHash, hb))
    const ra = await a.get('/api/v1/me')
    expect(ra.status).toBe(401)
    expect(ra.headers.getSetCookie()[0]).toMatch(/Max-Age=0/) // the dead cookie is cleared
    expect((await b.get('/api/v1/me')).status).toBe(401)
    expect(u.id).toBeTruthy()
  })

  it('writes last_seen_at at most every 5 minutes', async () => {
    const { app } = testApp()
    await createUser(db(), { email: 'ann@example.com' })
    const c = await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)
    const h = sha256(c.cookies.get('spoor_sid') as string)
    const seen = async () =>
      (await db().select().from(sessions).where(eq(sessions.idHash, h)))[0]?.lastSeenAt.getTime()
    await db()
      .update(sessions)
      .set({ lastSeenAt: sql`now() - interval '2 minutes'` })
      .where(eq(sessions.idHash, h))
    const before = await seen()
    await c.get('/api/v1/me')
    expect(await seen()).toBe(before)
    await db()
      .update(sessions)
      .set({ lastSeenAt: sql`now() - interval '6 minutes'` })
      .where(eq(sessions.idHash, h))
    await c.get('/api/v1/me')
    expect(Date.now() - ((await seen()) ?? 0)).toBeLessThan(60_000)
  })

  it('a disabled user loses access even with a live session row', async () => {
    const { app } = testApp()
    const u = await createUser(db(), { email: 'ann@example.com' })
    const c = await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)
    await db().update(users).set({ disabledAt: sql`now()` }).where(eq(users.id, u.id))
    expect((await c.get('/api/v1/me')).status).toBe(401)
  })
})

describe('own account', () => {
  it('PATCH /me strips control and bidi characters from the name', async () => {
    const { app } = testApp()
    await createUser(db(), { email: 'ann@example.com' })
    const c = await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)
    const res = await c.patch('/api/v1/me', { name: ' Ann‮\u0007 Smith\n' })
    expect(res.status).toBe(200)
    expect((await json<{ user: { name: string } }>(res)).user.name).toBe('Ann Smith')
    expect((await c.patch('/api/v1/me', { name: '‏' })).status).toBe(400)
    const audit = await db().select().from(auditLog).where(eq(auditLog.action, 'user.update'))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ via: 'web', actorLabel: 'ann@example.com', projectId: null })
  })

  it('password change checks the current password and keeps only the current session', async () => {
    const { app } = testApp()
    const u = await createUser(db(), { email: 'ann@example.com' })
    const other = await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)
    const c = await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)

    const wrong = await c.post('/api/v1/me/password', {
      current_password: 'not my password',
      new_password: 'a brand new secret',
    })
    expect(wrong.status).toBe(401)
    expect((await json(wrong)).error).toBe('invalid_credentials')
    const short = await c.post('/api/v1/me/password', {
      current_password: DEFAULT_PASSWORD,
      new_password: 'too short',
    })
    expect(short.status).toBe(400)

    const ok = await c.post('/api/v1/me/password', {
      current_password: DEFAULT_PASSWORD,
      new_password: 'a brand new secret',
    })
    expect(ok.status).toBe(204)
    expect((await c.get('/api/v1/me')).status).toBe(200)
    expect((await other.get('/api/v1/me')).status).toBe(401)
    const rows = await db().select().from(sessions).where(eq(sessions.userId, u.id))
    expect(rows).toHaveLength(1)
    expect(
      (
        await new Client(app).post('/api/v1/auth/login', {
          email: 'ann@example.com',
          password: DEFAULT_PASSWORD,
        })
      ).status,
    ).toBe(401)
    await loginAs(app, 'ann@example.com', 'a brand new secret')
  })
})
