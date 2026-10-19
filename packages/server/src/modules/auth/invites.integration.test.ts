// Invites and password-reset invites (auth-and-security.md sections 2 and 5; api.md section 2.1).
import { eq, sql } from 'drizzle-orm'
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
import { Client, json, loginAs, TEST_ORIGIN, testApp } from '../../../test/http.js'
import { auditLog, invites, memberships, sessions, tokens, users } from '../../db/schema.js'
import { sha256 } from '../../lib/crypto.js'

const db = () => testDb()
const NEW_PASSWORD = 'a fresh passphrase'

type Created = {
  invite: { id: string; email: string | null; reset: boolean; status: string }
  token: string
  link: string
}

async function setup() {
  const { app } = testApp()
  const admin = await createAdmin(db(), { email: 'admin@example.com' })
  const ia = await loginAs(app, admin.email, DEFAULT_PASSWORD)
  return { app, admin, ia }
}

async function createInvite(c: Client, body: Record<string, unknown>): Promise<Created> {
  const res = await c.post('/api/v1/invites', body)
  if (res.status !== 201) throw new Error(`invite create: ${res.status} ${await res.text()}`)
  return json<Created>(res)
}

describe('creating invites', () => {
  it('an instance admin gets a one-time spi_ token in a fragment link; the DB keeps only its sha256', async () => {
    const { ia, admin } = await setup()
    const p = await createProject(db(), { slug: 'acme', name: 'Acme' })
    const res = await ia.post('/api/v1/invites', {
      email: 'New@Example.com',
      grants: [{ project: 'acme', role: 'editor' }],
      shared_editor: true,
    })
    expect(res.status).toBe(201)
    const body = await json<Created & { invite: Record<string, unknown> }>(res)
    expect(body.token).toMatch(/^spi_[A-Za-z0-9_-]{43}$/)
    expect(body.link).toBe(`${TEST_ORIGIN}/invite#${body.token}`)
    expect(body.invite).toMatchObject({
      email: 'new@example.com',
      shared_editor: true,
      is_admin: false,
      reset: false,
      status: 'open',
      grants: [{ project: { slug: 'acme', name: 'Acme' }, role: 'editor' }],
      created_by: admin.id,
    })
    const hours = (Date.parse(body.invite.expires_at as string) - Date.now()) / 3_600_000
    expect(hours).toBeGreaterThan(167.9)
    expect(hours).toBeLessThan(168.1)
    const [row] = await db().select().from(invites)
    expect(row?.tokenHash.equals(sha256(body.token))).toBe(true)
    expect(row?.grants).toEqual([{ project_id: p.id, role: 'editor' }])
    const [audit] = await db().select().from(auditLog).where(eq(auditLog.action, 'invite.create'))
    expect(audit).toMatchObject({ projectId: null, via: 'web', actorUserId: admin.id })
    expect(JSON.stringify(audit?.data)).not.toContain(body.token)
  })

  it('validates expiry bounds, unknown projects, the shared project and duplicates', async () => {
    const { ia } = await setup()
    await createProject(db(), { slug: 'acme' })
    await createProject(db(), { kind: 'shared' })
    for (const body of [
      { expires_in_hours: 0 },
      { expires_in_hours: 721 },
      { grants: [{ project: 'nope', role: 'editor' }] },
      { grants: [{ project: '_shared', role: 'editor' }] },
      { grants: [{ project: 'acme', role: 'owner' }] },
      {
        grants: [
          { project: 'acme', role: 'editor' },
          { project: 'acme', role: 'viewer' },
        ],
      },
      { surprise: true },
    ]) {
      const res = await ia.post('/api/v1/invites', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await json(res)).error).toBe('invalid_input')
    }
  })

  it('project admins may invite only into projects they administer, with non-empty grants and no flags', async () => {
    const { app } = await setup()
    const acme = await createProject(db(), { slug: 'acme' })
    const beta = await createProject(db(), { slug: 'beta' })
    const pa = await createUser(db(), { email: 'pa@example.com' })
    await addMember(db(), acme.id, pa.id, 'admin')
    await addMember(db(), beta.id, pa.id, 'editor')
    const c = await loginAs(app, pa.email, DEFAULT_PASSWORD)

    expect((await c.post('/api/v1/invites', { grants: [{ project: 'acme', role: 'viewer' }] })).status).toBe(
      201,
    )
    const empty = await c.post('/api/v1/invites', { grants: [] })
    expect(empty.status).toBe(400)
    const notTheirs = await c.post('/api/v1/invites', { grants: [{ project: 'beta', role: 'viewer' }] })
    expect(notTheirs.status).toBe(403)
    expect((await json(notTheirs)).error).toBe('forbidden')
    for (const flag of [{ is_admin: true }, { shared_editor: true }, { reset_user_id: pa.id, grants: [] }]) {
      const res = await c.post('/api/v1/invites', { grants: [{ project: 'acme', role: 'viewer' }], ...flag })
      expect(res.status, JSON.stringify(flag)).toBe(403)
    }
    // a plain member (editor) is not a project admin
    const ed = await createUser(db(), { email: 'ed@example.com' })
    await addMember(db(), acme.id, ed.id, 'editor')
    const e = await loginAs(app, ed.email, DEFAULT_PASSWORD)
    expect((await e.post('/api/v1/invites', { grants: [{ project: 'acme', role: 'viewer' }] })).status).toBe(
      403,
    )
  })

  it('needs a session', async () => {
    const { app } = testApp()
    expect((await new Client(app).post('/api/v1/invites', { grants: [] })).status).toBe(401)
  })
})

describe('preview and accept', () => {
  it('preview shows the invite; accept creates the user with grants, logs in and uses the invite once', async () => {
    const { app, ia } = await setup()
    const acme = await createProject(db(), { slug: 'acme', name: 'Acme' })
    const gone = await createProject(db(), { slug: 'gone' })
    const inv = await createInvite(ia, {
      grants: [
        { project: 'acme', role: 'editor' },
        { project: 'gone', role: 'viewer' },
      ],
    })
    const guest = new Client(app)
    const preview = await guest.post('/api/v1/invites/preview', { token: inv.token })
    expect(preview.status).toBe(200)
    expect(await json(preview)).toMatchObject({ email: null, reset: false, is_admin: false })

    await db().execute(sql`DELETE FROM projects WHERE id = ${gone.id}`) // grants on deleted projects are skipped
    const res = await guest.post('/api/v1/invites/accept', {
      token: inv.token,
      name: 'New‮ Person',
      email: 'NEW@example.com',
      password: NEW_PASSWORD,
    })
    expect(res.status).toBe(201)
    const { user } = await json<{ user: { id: string; email: string; name: string } }>(res)
    expect(user).toMatchObject({ email: 'new@example.com', name: 'New Person', is_admin: false })
    expect(guest.cookies.get('spoor_sid')).toBeTruthy()
    const me = await json<{ memberships: unknown[] }>(await guest.get('/api/v1/me'))
    expect(me.memberships).toEqual([{ project: { id: acme.id, slug: 'acme', name: 'Acme' }, role: 'editor' }])
    const [row] = await db().select().from(invites)
    expect(row?.usedAt).not.toBeNull()
    expect(row?.usedBy).toBe(user.id)

    const again = await new Client(app).post('/api/v1/invites/accept', {
      token: inv.token,
      name: 'Twice',
      email: 'twice@example.com',
      password: NEW_PASSWORD,
    })
    expect(again.status).toBe(404)
    expect((await new Client(app).post('/api/v1/invites/preview', { token: inv.token })).status).toBe(404)
  })

  it('a locked invite takes its own email and refuses a different one', async () => {
    const { app, ia } = await setup()
    const inv = await createInvite(ia, { email: 'locked@example.com' })
    const bad = await new Client(app).post('/api/v1/invites/accept', {
      token: inv.token,
      name: 'X',
      email: 'other@example.com',
      password: NEW_PASSWORD,
    })
    expect(bad.status).toBe(400)
    const ok = await new Client(app).post('/api/v1/invites/accept', {
      token: inv.token,
      name: 'X',
      password: NEW_PASSWORD,
    })
    expect(ok.status).toBe(201)
    expect((await json<{ user: { email: string } }>(ok)).user.email).toBe('locked@example.com')
  })

  it('an open invite needs name and email; a failed accept leaves it unused', async () => {
    const { app, ia } = await setup()
    const inv = await createInvite(ia, {})
    const c = new Client(app)
    expect(
      (await c.post('/api/v1/invites/accept', { token: inv.token, name: 'X', password: NEW_PASSWORD }))
        .status,
    ).toBe(400)
    expect(
      (
        await c.post('/api/v1/invites/accept', {
          token: inv.token,
          email: 'x@example.com',
          password: NEW_PASSWORD,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await c.post('/api/v1/invites/accept', {
          token: inv.token,
          name: 'X',
          email: 'x@example.com',
          password: 'short',
        })
      ).status,
    ).toBe(400)
    const [row] = await db().select().from(invites)
    expect(row?.usedAt).toBeNull()
  })

  it('instance flags of the invite carry over to the new user', async () => {
    const { app, ia } = await setup()
    const inv = await createInvite(ia, { is_admin: true, shared_editor: true })
    const res = await new Client(app).post('/api/v1/invites/accept', {
      token: inv.token,
      name: 'Boss',
      email: 'boss@example.com',
      password: NEW_PASSWORD,
    })
    expect(await json(res)).toMatchObject({ user: { is_admin: true, shared_editor: true } })
  })

  it('expired and revoked invites are 404 for preview and accept', async () => {
    const { app, ia } = await setup()
    const expired = await createInvite(ia, {})
    const revoked = await createInvite(ia, {})
    await db()
      .update(invites)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(invites.tokenHash, sha256(expired.token)))
    expect((await ia.delete(`/api/v1/invites/${revoked.invite.id}`)).status).toBe(204)
    for (const token of [expired.token, revoked.token, 'spi_unknown']) {
      const c = new Client(app)
      expect((await c.post('/api/v1/invites/preview', { token })).status).toBe(404)
      const res = await c.post('/api/v1/invites/accept', {
        token,
        name: 'X',
        email: 'x@example.com',
        password: NEW_PASSWORD,
      })
      expect(res.status).toBe(404)
      expect((await json(res)).error).toBe('not_found')
    }
  })
})

describe('account takeover protection (password-reset fix)', () => {
  it('an ordinary invite naming an existing email is 409 already_exists, writes nothing and stays unused', async () => {
    const { app, ia } = await setup()
    const victim = await createUser(db(), { email: 'victim@example.com' })
    // attacker-controlled open invite (e.g. created by a project admin) used with the victim's email
    const open = await createInvite(ia, {})
    const locked = await createInvite(ia, { email: 'victim@example.com' })
    for (const [token, email] of [
      [open.token, 'Victim@Example.com'],
      [locked.token, undefined],
    ] as const) {
      const res = await new Client(app).post('/api/v1/invites/accept', {
        token,
        name: 'Attacker',
        ...(email ? { email } : {}),
        password: 'attacker password',
      })
      expect(res.status).toBe(409)
      expect((await json(res)).error).toBe('already_exists')
      expect(res.headers.getSetCookie()).toHaveLength(0)
    }
    const [v] = await db().select().from(users).where(eq(users.id, victim.id))
    expect(v?.passwordHash).toBe(victim.passwordHash)
    expect(v?.name).toBe(victim.name)
    expect(await db().select().from(users)).toHaveLength(2) // admin + victim, nobody new
    const rows = await db().select().from(invites)
    expect(rows.every((r) => r.usedAt === null)).toBe(true)
    await loginAs(app, 'victim@example.com', DEFAULT_PASSWORD) // victim's password still works
    expect(
      (
        await new Client(app).post('/api/v1/auth/login', {
          email: 'victim@example.com',
          password: 'attacker password',
        })
      ).status,
    ).toBe(401)
  })

  it('a reset invite changes exactly its user, by id, ignoring any email or name in the body', async () => {
    const { app, ia } = await setup()
    const target = await createUser(db(), { email: 'target@example.com', name: 'Target' })
    const bystander = await createUser(db(), { email: 'bystander@example.com' })
    const inv = await createInvite(ia, { reset_user_id: target.id })
    expect(inv.invite).toMatchObject({ reset: true, email: 'target@example.com' })
    const preview = await json(await new Client(app).post('/api/v1/invites/preview', { token: inv.token }))
    expect(preview).toMatchObject({ reset: true, email: 'target@example.com', grants: [] })

    const res = await new Client(app).post('/api/v1/invites/accept', {
      token: inv.token,
      name: 'Renamed',
      email: 'bystander@example.com',
      password: NEW_PASSWORD,
    })
    expect(res.status).toBe(201)
    expect(await json(res)).toMatchObject({
      user: { id: target.id, email: 'target@example.com', name: 'Target' },
    })
    await loginAs(app, 'target@example.com', NEW_PASSWORD)
    await loginAs(app, 'bystander@example.com', DEFAULT_PASSWORD)
    const [b] = await db().select().from(users).where(eq(users.id, bystander.id))
    expect(b?.passwordHash).toBe(bystander.passwordHash)
    const [audit] = await db().select().from(auditLog).where(eq(auditLog.action, 'user.password_reset'))
    expect(audit).toMatchObject({ actorUserId: target.id, via: 'web' })
  })

  it('a reset deletes all sessions of the user and revokes their tokens (unless told not to)', async () => {
    const { app, ia } = await setup()
    const p = await createProject(db(), { slug: 'acme' })
    const a = await createUser(db(), { email: 'a@example.com' })
    const b = await createUser(db(), { email: 'b@example.com' })
    await addMember(db(), p.id, a.id, 'editor')
    await addMember(db(), p.id, b.id, 'editor')
    const ta = await createToken(db(), { projectId: p.id, userId: a.id })
    const tb = await createToken(db(), { projectId: p.id, userId: b.id })
    const sa = await loginAs(app, 'a@example.com', DEFAULT_PASSWORD)
    const sb = await loginAs(app, 'b@example.com', DEFAULT_PASSWORD)

    const ra = await createInvite(ia, { reset_user_id: a.id })
    const rb = await createInvite(ia, { reset_user_id: b.id, reset_revoke_tokens: false })
    for (const inv of [ra, rb]) {
      expect(
        (await new Client(app).post('/api/v1/invites/accept', { token: inv.token, password: NEW_PASSWORD }))
          .status,
      ).toBe(201)
    }
    expect((await sa.get('/api/v1/me')).status).toBe(401)
    expect((await sb.get('/api/v1/me')).status).toBe(401)
    const live = (await db().select().from(sessions)).filter((s) => s.userId === a.id || s.userId === b.id)
    expect(live.map((s) => s.userId).sort()).toEqual([a.id, b.id].sort()) // only the fresh accept sessions
    const [tokA] = await db().select().from(tokens).where(eq(tokens.id, ta.id))
    const [tokB] = await db().select().from(tokens).where(eq(tokens.id, tb.id))
    expect(tokA?.revokedAt).not.toBeNull()
    expect(tokB?.revokedAt).toBeNull()
    // memberships are untouched by a reset
    expect(await db().select().from(memberships)).toHaveLength(2)
  })

  it('reset invites are instance-admin only, carry no grants or flags, and need an existing user', async () => {
    const { ia } = await setup()
    const u = await createUser(db(), { email: 'u@example.com' })
    await createProject(db(), { slug: 'acme' })
    const withGrant = await ia.post('/api/v1/invites', {
      reset_user_id: u.id,
      grants: [{ project: 'acme', role: 'viewer' }],
    })
    expect(withGrant.status).toBe(400)
    expect((await ia.post('/api/v1/invites', { reset_user_id: u.id, is_admin: true })).status).toBe(400)
    expect((await ia.post('/api/v1/invites', { reset_user_id: u.id, email: 'x@example.com' })).status).toBe(
      400,
    )
    const missing = await ia.post('/api/v1/invites', {
      reset_user_id: '00000000-0000-4000-8000-000000000000',
    })
    expect(missing.status).toBe(404)
    expect((await json(missing)).error).toBe('user_not_found')
  })
})

describe('listing and revoking', () => {
  it('shows each caller only the invites they may manage', async () => {
    const { app, ia, admin } = await setup()
    const acme = await createProject(db(), { slug: 'acme' })
    const beta = await createProject(db(), { slug: 'beta' })
    const pa = await createUser(db(), { email: 'pa@example.com' })
    const other = await createUser(db(), { email: 'other@example.com' })
    await addMember(db(), acme.id, pa.id, 'admin')
    const c = await loginAs(app, pa.email, DEFAULT_PASSWORD)

    const own = await createInvite(c, { grants: [{ project: 'acme', role: 'viewer' }] })
    const acmeByAdmin = await createInvite(ia, { grants: [{ project: 'acme', role: 'editor' }] })
    await createInvite(ia, {
      grants: [
        { project: 'acme', role: 'editor' },
        { project: 'beta', role: 'viewer' },
      ],
    })
    await createInvite(ia, { grants: [{ project: 'acme', role: 'editor' }], shared_editor: true })
    await createInvite(ia, { reset_user_id: other.id })
    await createInvite(ia, {})
    expect(beta.id).toBeTruthy()

    const all = await json<{ items: { id: string }[] }>(await ia.get('/api/v1/invites'))
    expect(all.items).toHaveLength(6)
    const mine = await json<{ items: { id: string }[] }>(await c.get('/api/v1/invites'))
    expect(mine.items.map((i) => i.id).sort()).toEqual([own.invite.id, acmeByAdmin.invite.id].sort())
    const o = await loginAs(app, other.email, DEFAULT_PASSWORD)
    expect((await json<{ items: unknown[] }>(await o.get('/api/v1/invites'))).items).toHaveLength(0)

    // revoke: PA may revoke the admin's acme-only invite, not the instance-flag one; others get 404
    expect((await o.delete(`/api/v1/invites/${acmeByAdmin.invite.id}`)).status).toBe(404)
    expect((await c.delete(`/api/v1/invites/${acmeByAdmin.invite.id}`)).status).toBe(204)
    expect((await c.delete(`/api/v1/invites/${acmeByAdmin.invite.id}`)).status).toBe(204) // idempotent
    const revokes = await db().select().from(auditLog).where(eq(auditLog.action, 'invite.revoke'))
    expect(revokes).toHaveLength(1)
    expect(admin.id).toBeTruthy()
  })

  it('filters by status and paginates with a stable cursor', async () => {
    const { app, ia } = await setup()
    const created: string[] = []
    for (let i = 0; i < 5; i++) created.push((await createInvite(ia, {})).invite.id)
    // two invites share one created_at (same transaction timestamp): the cursor must not skip either
    await db()
      .update(invites)
      .set({ createdAt: sql`(SELECT created_at FROM invites WHERE id = ${created[1]})` })
      .where(eq(invites.id, created[2] as string))
    await ia.delete(`/api/v1/invites/${created[0]}`)
    const used = await new Client(app).post('/api/v1/invites/accept', {
      token: (await createInvite(ia, {})).token,
      name: 'U',
      email: 'u@example.com',
      password: NEW_PASSWORD,
    })
    expect(used.status).toBe(201)

    const seen: string[] = []
    let cursor: string | null = null
    do {
      const q: string = cursor ? `&cursor=${cursor}` : ''
      const pageRes = await json<{ items: { id: string }[]; next_cursor: string | null }>(
        await ia.get(`/api/v1/invites?limit=2${q}`),
      )
      expect(pageRes.items.length).toBeLessThanOrEqual(2)
      seen.push(...pageRes.items.map((i) => i.id))
      cursor = pageRes.next_cursor
    } while (cursor)
    expect(seen).toHaveLength(6)
    expect(new Set(seen).size).toBe(6)

    const count = async (status: string) =>
      (await json<{ items: unknown[] }>(await ia.get(`/api/v1/invites?status=${status}`))).items.length
    expect(await count('open')).toBe(4)
    expect(await count('revoked')).toBe(1)
    expect(await count('used')).toBe(1)
    expect(await count('expired')).toBe(0)
    expect((await ia.get('/api/v1/invites?status=bogus')).status).toBe(400)
    expect((await ia.get('/api/v1/invites?cursor=garbage')).status).toBe(400)
  })
})

describe('races', () => {
  it('two concurrent accepts of one invite: exactly one wins', async () => {
    const { app, ia } = await setup()
    const inv = await createInvite(ia, {})
    const results = await Promise.all(
      ['r1@example.com', 'r2@example.com'].map((email) =>
        new Client(app).post('/api/v1/invites/accept', {
          token: inv.token,
          name: 'R',
          email,
          password: NEW_PASSWORD,
        }),
      ),
    )
    expect(results.map((r) => r.status).sort()).toEqual([201, 404])
  })

  it('two invites accepted concurrently with the same email: one user, one 409', async () => {
    const { app, ia } = await setup()
    const a = await createInvite(ia, {})
    const b = await createInvite(ia, {})
    const results = await Promise.all(
      [a, b].map((inv) =>
        new Client(app).post('/api/v1/invites/accept', {
          token: inv.token,
          name: 'Same',
          email: 'same@example.com',
          password: NEW_PASSWORD,
        }),
      ),
    )
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect(await db().select().from(users).where(eq(users.email, 'same@example.com'))).toHaveLength(1)
    expect((await db().select().from(invites)).filter((r) => r.usedAt !== null)).toHaveLength(1)
  })
})

describe('the creator must still back an invite (phase-2 review S1)', () => {
  const accept = (app: ReturnType<typeof testApp>['app'], token: string, email: string) =>
    new Client(app).post('/api/v1/invites/accept', { token, name: 'N', email, password: NEW_PASSWORD })
  const preview = (app: ReturnType<typeof testApp>['app'], token: string) =>
    new Client(app).post('/api/v1/invites/preview', { token })

  it('an admin invite of a demoted, disabled and deleted instance admin is 404 and revoked', async () => {
    const { app, ia } = await setup()
    const a1 = await createAdmin(db(), { email: 'a1@example.com' })
    const a1c = await loginAs(app, a1.email, DEFAULT_PASSWORD)
    const inv = await createInvite(a1c, { is_admin: true })
    const resetInv = await createInvite(a1c, { reset_user_id: (await createUser(db())).id })
    expect((await ia.request('PATCH', `/api/v1/users/${a1.id}`, { body: { is_admin: false } })).status).toBe(
      200,
    )
    expect((await preview(app, inv.token)).status).toBe(404)
    expect((await accept(app, inv.token, 'x@example.com')).status).toBe(404)
    expect((await accept(app, resetInv.token, 'y@example.com')).status).toBe(404)
    const rows = await db().select().from(invites)
    expect(rows.every((r) => r.revokedAt !== null && r.usedAt === null)).toBe(true)
    expect(await db().select().from(users).where(eq(users.email, 'x@example.com'))).toHaveLength(0)
  })

  it('the accept gate refuses even when the invite was not revoked (deleted creator)', async () => {
    const { app, ia } = await setup()
    const a1 = await createAdmin(db(), { email: 'a1@example.com' })
    const a1c = await loginAs(app, a1.email, DEFAULT_PASSWORD)
    const inv = await createInvite(a1c, { is_admin: true })
    // simulate a path that bypassed revocation: the creator simply disappears
    await db().update(invites).set({ createdBy: null })
    expect((await accept(app, inv.token, 'x@example.com')).status).toBe(404)
    await db().update(invites).set({ createdBy: a1.id })
    await db().update(users).set({ disabledAt: sql`now()` }).where(eq(users.id, a1.id))
    expect((await accept(app, inv.token, 'x@example.com')).status).toBe(404)
    await db().update(users).set({ disabledAt: null }).where(eq(users.id, a1.id))
    const ok = await accept(app, inv.token, 'x@example.com')
    expect(ok.status).toBe(201)
    expect((await json<{ user: { is_admin: boolean } }>(ok)).user.is_admin).toBe(true)
    // deleting the creator revokes their remaining open invites
    const inv2 = await createInvite(a1c, { is_admin: true })
    expect((await ia.delete(`/api/v1/users/${a1.id}?confirm=${encodeURIComponent(a1.email)}`)).status).toBe(
      204,
    )
    expect((await accept(app, inv2.token, 'z@example.com')).status).toBe(404)
    const [row] = await db().select().from(invites).where(eq(invites.id, inv2.invite.id))
    expect(row?.revokedAt).not.toBeNull()
  })

  it('a project invite of a removed or demoted project admin grants nothing', async () => {
    const { app, ia } = await setup()
    const p = await createProject(db(), { slug: 'acme' })
    await createProject(db(), { slug: 'beta' })
    const pa = await createUser(db(), { email: 'pa@example.com' })
    await addMember(db(), p.id, pa.id, 'admin')
    const other = await createUser(db())
    await addMember(db(), p.id, other.id, 'admin')
    const pac = await loginAs(app, pa.email, DEFAULT_PASSWORD)
    const inv = await createInvite(pac, { grants: [{ project: 'acme', role: 'admin' }] })
    // demotion revokes it
    expect(
      (await ia.request('PUT', `/api/v1/projects/acme/members/${pa.id}`, { body: { role: 'editor' } }))
        .status,
    ).toBe(200)
    expect((await accept(app, inv.token, 'x@example.com')).status).toBe(404)
    // removal of a project admin: the gate refuses even without the revocation
    await db().update(memberships).set({ role: 'admin' }).where(eq(memberships.userId, pa.id))
    const inv2 = await createInvite(pac, { grants: [{ project: 'acme', role: 'admin' }] })
    await db().delete(memberships).where(eq(memberships.userId, pa.id))
    expect((await accept(app, inv2.token, 'y@example.com')).status).toBe(404)
    // an instance admin's project invite survives the creator's own membership changes
    const iaInv = await createInvite(ia, { grants: [{ project: 'beta', role: 'viewer' }] })
    expect((await accept(app, iaInv.token, 'w@example.com')).status).toBe(201)
  })

  it('removing a project admin revokes their open invites into that project only', async () => {
    const { app, ia } = await setup()
    const p = await createProject(db(), { slug: 'acme' })
    const q = await createProject(db(), { slug: 'beta' })
    const pa = await createUser(db(), { email: 'pa@example.com' })
    await addMember(db(), p.id, pa.id, 'admin')
    await addMember(db(), q.id, pa.id, 'admin')
    await addMember(db(), p.id, (await createUser(db())).id, 'admin')
    const pac = await loginAs(app, pa.email, DEFAULT_PASSWORD)
    const a = await createInvite(pac, { grants: [{ project: 'acme', role: 'editor' }] })
    const b = await createInvite(pac, { grants: [{ project: 'beta', role: 'editor' }] })
    expect((await ia.delete(`/api/v1/projects/acme/members/${pa.id}`)).status).toBe(204)
    const rows = await db().select().from(invites)
    expect(rows.find((r) => r.id === a.invite.id)?.revokedAt).not.toBeNull()
    expect(rows.find((r) => r.id === b.invite.id)?.revokedAt).toBeNull()
    expect((await accept(app, b.token, 'b@example.com')).status).toBe(201)
  })
})
