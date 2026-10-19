// API tokens (api.md 4.3), the bearer middleware of /p/:slug/api (mcp.md section 2) and whoami (api.md 7.2).
import { eq, sql } from 'drizzle-orm'
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
import { auditLog, projects, tokens, users } from '../../db/schema.js'
import { sha256 } from '../../lib/crypto.js'
import { VERSION } from '../../version.js'

const db = () => testDb()

async function setup() {
  const { app } = testApp()
  const p = await createProject(db(), { slug: 'acme', name: 'Acme' })
  const pa = await createUser(db(), { email: 'pa@example.com' })
  const ed = await createUser(db(), { email: 'ed@example.com' })
  const vi = await createUser(db(), { email: 'vi@example.com' })
  await addMember(db(), p.id, pa.id, 'admin')
  await addMember(db(), p.id, ed.id, 'editor')
  await addMember(db(), p.id, vi.id, 'viewer')
  return { app, p, pa, ed, vi }
}

type App = Awaited<ReturnType<typeof setup>>['app']
type Token = { id: string; kind: string; role: string | null; prefix: string; origin: string; user: unknown }

const bearer = (
  app: App,
  path: string,
  token: string | null,
  init: RequestInit & { headers?: Record<string, string> } = {},
) =>
  app.request(`http://localhost:3000${path}`, {
    ...init,
    headers: { ...(token !== null ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  })

describe('cookie token routes', () => {
  it('any member creates their own user token; the secret is shown once and stored as sha256', async () => {
    const { app, p, vi } = await setup()
    const c = await loginAs(app, vi.email, DEFAULT_PASSWORD)
    const res = await c.post('/api/v1/projects/acme/tokens', { kind: 'user', name: 'laptop' })
    expect(res.status).toBe(201)
    const body = await json<{ token: Token; secret: string }>(res)
    expect(body.secret).toMatch(/^spr_[A-Za-z0-9_-]{43}$/)
    expect(body.secret).toHaveLength(47)
    expect(body.token).toMatchObject({
      kind: 'user',
      origin: 'web',
      name: 'laptop',
      role: null,
      prefix: body.secret.slice(0, 12),
      user: { id: vi.id, label: 'vi@example.com' },
      expires_at: null,
      revoked_at: null,
    })
    const [row] = await db().select().from(tokens).where(eq(tokens.id, body.token.id))
    expect(row?.tokenHash.equals(sha256(body.secret))).toBe(true)
    expect(JSON.stringify(row)).not.toContain(body.secret)
    const [audit] = await db().select().from(auditLog).where(eq(auditLog.action, 'token.create'))
    expect(audit).toMatchObject({ projectId: p.id, actorLabel: 'vi@example.com', via: 'web' })
    expect(JSON.stringify(audit?.data)).not.toContain(body.secret)
    // never listed again with the secret
    const list = await json<{ items: Record<string, unknown>[] }>(await c.get('/api/v1/projects/acme/tokens'))
    expect(JSON.stringify(list)).not.toContain(body.secret)
  })

  it('service tokens: project admins only, role required (editor or viewer), sprs_ prefix', async () => {
    const { app, ed, pa } = await setup()
    const edC = await loginAs(app, ed.email, DEFAULT_PASSWORD)
    const denied = await edC.post('/api/v1/projects/acme/tokens', {
      kind: 'service',
      name: 'ci',
      role: 'viewer',
    })
    expect(denied.status).toBe(403)
    const paC = await loginAs(app, pa.email, DEFAULT_PASSWORD)
    expect((await paC.post('/api/v1/projects/acme/tokens', { kind: 'service', name: 'ci' })).status).toBe(400)
    expect(
      (await paC.post('/api/v1/projects/acme/tokens', { kind: 'service', name: 'ci', role: 'admin' })).status,
    ).toBe(400)
    const ok = await json<{ token: Token; secret: string }>(
      await paC.post('/api/v1/projects/acme/tokens', { kind: 'service', name: 'ci', role: 'editor' }),
    )
    expect(ok.secret).toMatch(/^sprs_/)
    expect(ok.token).toMatchObject({ kind: 'service', role: 'editor', user: null })
  })

  it('expiry must be in the future', async () => {
    const { app, ed } = await setup()
    const c = await loginAs(app, ed.email, DEFAULT_PASSWORD)
    const past = await c.post('/api/v1/projects/acme/tokens', {
      kind: 'user',
      name: 'x',
      expires_at: '2020-01-01T00:00:00Z',
    })
    expect(past.status).toBe(400)
    const future = await c.post('/api/v1/projects/acme/tokens', {
      kind: 'user',
      name: 'x',
      role: 'viewer',
      expires_at: '2099-01-01T00:00:00.000Z',
    })
    expect((await json<{ token: { expires_at: string; role: string } }>(future)).token).toEqual(
      expect.objectContaining({ expires_at: '2099-01-01T00:00:00.000Z', role: 'viewer' }),
    )
  })

  it('members list only their own user tokens; project admins see all; include=revoked', async () => {
    const { app, p, ed, vi, pa } = await setup()
    const mine = await createToken(db(), { projectId: p.id, userId: ed.id, name: 'mine' })
    await createToken(db(), { projectId: p.id, userId: vi.id, name: 'theirs' })
    await createToken(db(), { projectId: p.id, kind: 'service', role: 'viewer', name: 'ci' })
    const gone = await createToken(db(), { projectId: p.id, userId: ed.id, name: 'old' })
    await db().update(tokens).set({ revokedAt: sql`now()` }).where(eq(tokens.id, gone.id))

    const edC = await loginAs(app, ed.email, DEFAULT_PASSWORD)
    const own = await json<{ items: Token[] }>(await edC.get('/api/v1/projects/acme/tokens'))
    expect(own.items.map((t) => t.id)).toEqual([mine.id])
    const withRevoked = await json<{ items: Token[] }>(
      await edC.get('/api/v1/projects/acme/tokens?include=revoked'),
    )
    expect(withRevoked.items.map((t) => t.id).sort()).toEqual([mine.id, gone.id].sort())
    const paC = await loginAs(app, pa.email, DEFAULT_PASSWORD)
    const all = await json<{ items: Token[] }>(await paC.get('/api/v1/projects/acme/tokens'))
    expect(all.items).toHaveLength(3)
  })

  it('revoke: owner, project admin or instance admin; idempotent; audited', async () => {
    const { app, p, ed, vi, pa } = await setup()
    const edTok = await createToken(db(), { projectId: p.id, userId: ed.id })
    const viTok = await createToken(db(), { projectId: p.id, userId: vi.id })
    const svc = await createToken(db(), { projectId: p.id, kind: 'service', role: 'viewer' })
    const edC = await loginAs(app, ed.email, DEFAULT_PASSWORD)
    expect((await edC.delete(`/api/v1/projects/acme/tokens/${viTok.id}`)).status).toBe(404)
    expect((await edC.delete(`/api/v1/projects/acme/tokens/${svc.id}`)).status).toBe(404)
    expect((await edC.delete(`/api/v1/projects/acme/tokens/${edTok.id}`)).status).toBe(204)
    expect((await edC.delete(`/api/v1/projects/acme/tokens/${edTok.id}`)).status).toBe(204)
    const paC = await loginAs(app, pa.email, DEFAULT_PASSWORD)
    expect((await paC.delete(`/api/v1/projects/acme/tokens/${viTok.id}`)).status).toBe(204)
    const admin = await createAdmin(db())
    const ia = await loginAs(app, admin.email, DEFAULT_PASSWORD)
    expect((await ia.delete(`/api/v1/projects/acme/tokens/${svc.id}`)).status).toBe(204)
    const audits = await db().select().from(auditLog).where(eq(auditLog.action, 'token.revoke'))
    expect(audits).toHaveLength(3)
    const rows = await db().select().from(tokens)
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true)
  })

  it('tokens never target _shared; non-members get 404', async () => {
    const { app } = await setup()
    await createSharedProject(db())
    const admin = await createAdmin(db())
    const ia = await loginAs(app, admin.email, DEFAULT_PASSWORD)
    expect((await ia.post('/api/v1/projects/_shared/tokens', { kind: 'user', name: 'x' })).status).toBe(404)
    expect((await ia.get('/api/v1/projects/_shared/tokens')).status).toBe(404)
    const stranger = await createUser(db())
    const s = await loginAs(app, stranger.email, DEFAULT_PASSWORD)
    expect((await s.post('/api/v1/projects/acme/tokens', { kind: 'user', name: 'x' })).status).toBe(404)
  })

  it('an instance admin without a membership may create a user token for the project', async () => {
    const { app } = await setup()
    const admin = await createAdmin(db())
    const ia = await loginAs(app, admin.email, DEFAULT_PASSWORD)
    const res = await ia.post('/api/v1/projects/acme/tokens', { kind: 'user', name: 'admin laptop' })
    expect(res.status).toBe(201)
    const { secret } = await json<{ secret: string }>(res)
    const who = await json<{ token: { role: string } }>(await bearer(app, '/p/acme/api/whoami', secret))
    expect(who.token.role).toBe('admin')
  })
})

describe('bearer middleware on /p/:slug/api', () => {
  it('whoami: project, token, effective role, next ADR number, label, version', async () => {
    const { app, p, ed } = await setup()
    await db().update(projects).set({ nextAdrNumber: 13 }).where(eq(projects.id, p.id))
    const t = await createToken(db(), { projectId: p.id, userId: ed.id, name: 'laptop' })
    const res = await bearer(app, '/p/acme/api/whoami', t.secret, {
      headers: { 'user-agent': 'spoor-cli/0.1.0' },
    })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      project: { slug: 'acme', name: 'Acme', next_adr_number: 13 },
      token: {
        id: t.id,
        name: 'laptop',
        kind: 'user',
        prefix: t.secret.slice(0, 12),
        role: 'editor',
        expires_at: null,
      },
      user: { label: 'ed@example.com' },
      server: { version: VERSION },
    })
    // a token with an expiry reports it (spoor status, spoor login)
    const exp = new Date(Date.now() + 86_400_000)
    await db().update(tokens).set({ expiresAt: exp }).where(eq(tokens.id, t.id))
    const again = await json<{ token: { expires_at: string } }>(
      await bearer(app, '/p/acme/api/whoami', t.secret),
    )
    expect(again.token.expires_at).toBe(exp.toISOString())
  })

  it('effective role: membership capped by the token role; service tokens keep their fixed role', async () => {
    const { app, p, pa, vi } = await setup()
    const role = async (secret: string) =>
      (await json<{ token: { role: string } }>(await bearer(app, '/p/acme/api/whoami', secret))).token.role
    expect(await role((await createToken(db(), { projectId: p.id, userId: pa.id })).secret)).toBe('admin')
    expect(
      await role((await createToken(db(), { projectId: p.id, userId: pa.id, role: 'viewer' })).secret),
    ).toBe('viewer')
    expect(
      await role((await createToken(db(), { projectId: p.id, userId: pa.id, role: 'editor' })).secret),
    ).toBe('editor')
    // a cap above the membership does not raise it
    expect(
      await role((await createToken(db(), { projectId: p.id, userId: vi.id, role: 'editor' })).secret),
    ).toBe('viewer')
    const svc = await createToken(db(), { projectId: p.id, kind: 'service', role: 'editor', name: 'ci' })
    const who = await json<{ token: { role: string; kind: string }; user: { label: string } }>(
      await bearer(app, '/p/acme/api/whoami', svc.secret),
    )
    expect(who).toMatchObject({ token: { role: 'editor', kind: 'service' }, user: { label: 'service:ci' } })
  })

  it('401 invalid_token with WWW-Authenticate for missing, malformed, unknown, revoked, expired tokens', async () => {
    const { app, p, ed } = await setup()
    const revoked = await createToken(db(), { projectId: p.id, userId: ed.id })
    await db().update(tokens).set({ revokedAt: sql`now()` }).where(eq(tokens.id, revoked.id))
    const expired = await createToken(db(), { projectId: p.id, userId: ed.id })
    await db()
      .update(tokens)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(tokens.id, expired.id))
    const cases: (string | null)[] = [
      null,
      'not-a-token',
      `spr_${'A'.repeat(43)}`,
      revoked.secret,
      expired.secret,
    ]
    for (const secret of cases) {
      const res = await bearer(app, '/p/acme/api/whoami', secret)
      expect(res.status, String(secret)).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer realm="spoor"')
      expect((await json(res)).error).toBe('invalid_token')
    }
    // the basic scheme is not bearer
    expect(
      (await bearer(app, '/p/acme/api/whoami', null, { headers: { authorization: 'Basic eDp5' } })).status,
    ).toBe(401)
  })

  it('401 for a disabled user and for a user who is no longer a member (no caching)', async () => {
    const { app, p, ed } = await setup()
    const t = await createToken(db(), { projectId: p.id, userId: ed.id })
    expect((await bearer(app, '/p/acme/api/whoami', t.secret)).status).toBe(200)
    await db().update(users).set({ disabledAt: sql`now()` }).where(eq(users.id, ed.id))
    expect((await bearer(app, '/p/acme/api/whoami', t.secret)).status).toBe(401)
    const outsider = await createUser(db())
    const t2 = await createToken(db(), { projectId: p.id, userId: outsider.id }) // never a member
    expect((await bearer(app, '/p/acme/api/whoami', t2.secret)).status).toBe(401)
  })

  it('a valid token of another project is 403 token_project_mismatch; an invalid one is 401 even for an unknown slug', async () => {
    const { app, p, ed } = await setup()
    await createProject(db(), { slug: 'other' })
    const t = await createToken(db(), { projectId: p.id, userId: ed.id })
    const res = await bearer(app, '/p/other/api/whoami', t.secret)
    expect(res.status).toBe(403)
    expect((await json(res)).error).toBe('token_project_mismatch')
    expect((await bearer(app, '/p/nope/api/whoami', t.secret)).status).toBe(403)
    expect((await bearer(app, '/p/nope/api/whoami', `spr_${'B'.repeat(43)}`)).status).toBe(401)
  })

  it('cookies are ignored on the bearer surface', async () => {
    const { app, pa } = await setup()
    const c = await loginAs(app, pa.email, DEFAULT_PASSWORD)
    const res = await c.get('/p/acme/api/whoami')
    expect(res.status).toBe(401)
  })

  it('bumps last_used_at at most once a minute', async () => {
    const { app, p, ed } = await setup()
    const t = await createToken(db(), { projectId: p.id, userId: ed.id })
    await bearer(app, '/p/acme/api/whoami', t.secret)
    const [first] = await db().select().from(tokens).where(eq(tokens.id, t.id))
    expect(first?.lastUsedAt).toBeInstanceOf(Date)
    await bearer(app, '/p/acme/api/whoami', t.secret)
    const [second] = await db().select().from(tokens).where(eq(tokens.id, t.id))
    expect(second?.lastUsedAt?.getTime()).toBe(first?.lastUsedAt?.getTime())
    await db()
      .update(tokens)
      .set({ lastUsedAt: sql`now() - interval '2 minutes'` })
      .where(eq(tokens.id, t.id))
    await bearer(app, '/p/acme/api/whoami', t.secret)
    const [third] = await db().select().from(tokens).where(eq(tokens.id, t.id))
    expect((third?.lastUsedAt?.getTime() ?? 0) > Date.now() - 30_000).toBe(true)
  })

  it('bearer routes answer only after authentication; bodies over 1 MB are 413', async () => {
    const { app, p, ed } = await setup()
    const t = await createToken(db(), { projectId: p.id, userId: ed.id })
    expect((await bearer(app, '/p/acme/api/activity', null)).status).toBe(401)
    expect((await bearer(app, '/p/acme/api/activity', t.secret)).status).toBe(200)
    const big = await bearer(app, '/p/acme/api/push', t.secret, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(1024 * 1024 + 10) }),
    })
    expect(big.status).toBe(413)
  })
})
