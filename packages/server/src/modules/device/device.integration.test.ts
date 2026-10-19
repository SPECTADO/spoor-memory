// Device login (auth-and-security.md section 6, api.md section 3, deviations I33, I39, X4): the public CLI
// side (code, token) and the cookie side (lookup, approve, deny), including the abuse cases.

import { DEVICE_GRANT_TYPE } from '@spoor/shared'
import { and, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { cliSurfaceApp } from '../../../test/cli-surface-app.js'
import { testDb } from '../../../test/db.js'
import {
  addMember,
  createAdmin,
  createProject,
  createSharedProject,
  createUser,
  DEFAULT_PASSWORD,
} from '../../../test/factories.js'
import { Client, json, loginAs, TEST_ORIGIN } from '../../../test/http.js'
import { auditLog, deviceCodes, memberships, tokens } from '../../db/schema.js'
import { sha256 } from '../../lib/crypto.js'

const db = () => testDb()
type Body = Record<string, unknown> & { error?: string }

async function seed() {
  await createSharedProject(db())
  const acme = await createProject(db(), { slug: 'acme', name: 'Acme Secret Name' })
  const other = await createProject(db(), { slug: 'other' })
  const dev = await createUser(db())
  const viewer = await createUser(db())
  const outsider = await createUser(db())
  const admin = await createAdmin(db())
  await addMember(db(), acme.id, dev.id, 'editor')
  await addMember(db(), acme.id, viewer.id, 'viewer')
  await addMember(db(), other.id, outsider.id, 'admin')
  return { acme, other, dev, viewer, outsider, admin, ...bind() }
}

/** The app and its CLI-side helpers (`device` options: e.g. a small row cap). */
function bind(device?: NonNullable<Parameters<typeof cliSurfaceApp>[0]>['device']) {
  const { app } = cliSurfaceApp({ device })
  const cli = new Client(app)
  /** A public CLI call: no Origin, no cookie; optionally from a given TCP peer. */
  const pub = async (path: string, body: unknown, peer = '::ffff:203.0.113.7') => {
    const raw = JSON.stringify(body)
    return app.request(
      `${TEST_ORIGIN}${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)) },
        body: raw,
      },
      { incoming: { socket: { remoteAddress: peer } } },
    )
  }
  const requestCode = async (slug = 'acme', client_name = 'spoor-cli/0.1.0 on laptop') => {
    const r = await pub(`/p/${slug}/device/code`, { client_name })
    expect(r.status).toBe(200)
    return json<{ device_code: string; user_code: string; interval: number }>(r)
  }
  const poll = (device_code: string, slug = 'acme', grant_type = DEVICE_GRANT_TYPE) =>
    pub(`/p/${slug}/device/token`, { grant_type, device_code })
  const login = (u: { email: string }) => loginAs(app, u.email, DEFAULT_PASSWORD)
  return { app, cli, pub, requestCode, poll, login }
}

let s: Awaited<ReturnType<typeof seed>>
beforeEach(async () => {
  s = await seed()
})

const rowOf = async (deviceCode: string) =>
  (
    await db()
      .select()
      .from(deviceCodes)
      .where(eq(deviceCodes.deviceCodeHash, sha256(deviceCode)))
  )[0]
/** Pretend the last poll was `secs` seconds ago (time comes from the database). */
const pollAgo = (deviceCode: string, secs: number) =>
  db()
    .update(deviceCodes)
    .set({ lastPolledAt: sql`now() - make_interval(secs => ${secs})` })
    .where(eq(deviceCodes.deviceCodeHash, sha256(deviceCode)))

describe('POST /p/:slug/device/code', () => {
  it('returns the RFC 8628 shape and stores only the hash, the bare user code and the peer IP', async () => {
    const r = await s.pub('/p/acme/device/code', { client_name: 'spoor-cli/0.1.0 on laptop' })
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    const b = await json<Body>(r)
    expect(Object.keys(b).sort()).toEqual([
      'device_code',
      'expires_in',
      'interval',
      'user_code',
      'verification_uri',
    ])
    expect(b.verification_uri).toBe(`${TEST_ORIGIN}/device`)
    expect(b.expires_in).toBe(600)
    expect(b.interval).toBe(5)
    expect(b.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    expect(b.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const [row] = await db().select().from(deviceCodes)
    expect(row?.deviceCodeHash.equals(sha256(b.device_code as string))).toBe(true)
    expect(row?.userCode).toBe((b.user_code as string).replace('-', ''))
    expect(row?.requesterIp).toBe('203.0.113.7')
    expect(row?.clientName).toBe('spoor-cli/0.1.0 on laptop')
    expect(row?.status).toBe('pending')
    const ttl = await db().execute(
      sql`SELECT extract(epoch from expires_at - created_at)::int AS s FROM device_codes`,
    )
    expect(ttl.rows[0]?.s).toBe(600)
    // the plaintext device code is stored nowhere
    const dump = JSON.stringify(await db().select().from(deviceCodes))
    expect(dump).not.toContain(b.device_code)
  })

  it('is 404 for an unknown slug and for _shared', async () => {
    for (const slug of ['nope', '_shared']) {
      const r = await s.pub(`/p/${slug}/device/code`, { client_name: 'x' })
      expect(r.status).toBe(404)
      expect((await json<Body>(r)).error).toBe('not_found')
    }
  })

  it('cuts client_name to 64 characters and strips control and bidi characters (X4)', async () => {
    const long = `spoor-cli/0.1.0 on ${'h'.repeat(200)}`
    await s.requestCode('acme', long)
    await s.requestCode('acme', 'evil‮name\r\nInjected: line')
    await s.pub('/p/acme/device/code', {})
    const names = (await db().select({ n: deviceCodes.clientName }).from(deviceCodes)).map((r) => r.n).sort()
    expect(names).toContain(long.slice(0, 64))
    expect(names).toContain('evilnameInjected: line')
    expect(names).toContain('unknown client')
  })

  it('rejects unknown fields, non-JSON bodies and oversized bodies', async () => {
    expect((await s.pub('/p/acme/device/code', { client_name: 'x', scope: 'all' })).status).toBe(400)
    const form = await s.app.request(`${TEST_ORIGIN}/p/acme/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'client_name=x',
    })
    expect(form.status).toBe(400)
    const big = await s.pub('/p/acme/device/code', { client_name: 'x'.repeat(20_000) })
    expect(big.status).toBe(413)
  })

  it('caps rows instance-wide: finished rows go first, then the oldest pending; 503 when nothing can go', async () => {
    s = { ...s, ...bind({ maxRows: 3 }) }
    // one finished (expired) row in another project, two pending
    const expired = await s.requestCode('other')
    await db()
      .update(deviceCodes)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(deviceCodes.deviceCodeHash, sha256(expired.device_code)))
    const a = await s.requestCode()
    const b = await s.requestCode()
    const c = await s.requestCode() // evicts the expired row
    expect(await rowOf(expired.device_code)).toBeUndefined()
    const d = await s.requestCode() // evicts the oldest pending (a)
    expect(await rowOf(a.device_code)).toBeUndefined()
    expect((await json<Body>(await s.poll(a.device_code))).error).toBe('invalid_grant')
    for (const x of [b, c, d]) expect(await rowOf(x.device_code)).toBeDefined()
    // every row approved and unconsumed: nothing may be evicted
    await db().update(deviceCodes).set({ status: 'approved', userId: s.dev.id })
    const r = await s.pub('/p/acme/device/code', { client_name: 'x' })
    expect(r.status).toBe(503)
    expect((await json<Body>(r)).error).toBe('too_many_pending')
  })
})

describe('requester IP behind a reverse proxy (SPOOR_TRUST_PROXY, deviations.md P3-1)', () => {
  /** A code request from TCP `peer` carrying `xff` as X-Forwarded-For, on an app built with `env`. */
  const requestFrom = async (env: Record<string, string>, peer: string, xff?: string) => {
    const { app } = cliSurfaceApp({ env })
    const raw = JSON.stringify({ client_name: 'spoor-cli' })
    const r = await app.request(
      `${TEST_ORIGIN}/p/acme/device/code`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(xff === undefined ? {} : { 'x-forwarded-for': xff }),
        },
        body: raw,
      },
      { incoming: { socket: { remoteAddress: peer } } },
    )
    expect(r.status).toBe(200)
    const { device_code } = await json<{ device_code: string }>(r)
    return (await rowOf(device_code))?.requesterIp
  }

  it('default off: the TCP peer, X-Forwarded-For ignored', async () => {
    expect(await requestFrom({}, '::ffff:172.18.0.3', '203.0.113.7')).toBe('172.18.0.3')
  })

  it('a trusted peer: the right-most untrusted hop; a spoofed left part does not count', async () => {
    const env = { SPOOR_TRUST_PROXY: 'private' }
    expect(await requestFrom(env, '::ffff:172.18.0.3', '203.0.113.7')).toBe('203.0.113.7')
    expect(await requestFrom(env, '172.18.0.3', '6.6.6.6, 203.0.113.7')).toBe('203.0.113.7')
    expect(await requestFrom(env, '172.18.0.3', '203.0.113.7, 10.0.0.4')).toBe('203.0.113.7')
    expect(await requestFrom(env, '172.18.0.3')).toBe('172.18.0.3')
  })

  it('a peer that is not a trusted proxy cannot set the address', async () => {
    const env = { SPOOR_TRUST_PROXY: '10.0.0.5' }
    expect(await requestFrom(env, '198.51.100.20', '203.0.113.7')).toBe('198.51.100.20')
    expect(await requestFrom(env, '10.0.0.5', '203.0.113.7')).toBe('203.0.113.7')
  })

  it('the approver sees the forwarded address on the lookup', async () => {
    const env = { SPOOR_TRUST_PROXY: 'loopback' }
    const { app } = cliSurfaceApp({ env })
    const r = await app.request(
      `${TEST_ORIGIN}/p/acme/device/code`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.99' },
        body: JSON.stringify({ client_name: 'spoor-cli' }),
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
    )
    const { user_code } = await json<{ user_code: string }>(r)
    const dev = await loginAs(app, s.dev.email, DEFAULT_PASSWORD)
    const look = await dev.get(`/api/v1/device/lookup?code=${user_code}`)
    expect(look.status).toBe(200)
    expect(await json<Body>(look)).toMatchObject({ requester_ip: '203.0.113.99' })
  })
})

describe('POST /p/:slug/device/code under concurrency', () => {
  it('keeps the cap with parallel requests', async () => {
    s = { ...s, ...bind({ maxRows: 2 }) }
    const rs = await Promise.all(
      Array.from({ length: 8 }, () => s.pub('/p/acme/device/code', { client_name: 'flood' })),
    )
    expect(rs.every((r) => r.status === 200)).toBe(true)
    expect(await db().select().from(deviceCodes)).toHaveLength(2)
    const codes = (await db().select({ c: deviceCodes.userCode }).from(deviceCodes)).map((r) => r.c)
    expect(new Set(codes).size).toBe(2)
  })
})

describe('POST /p/:slug/device/token', () => {
  it('pending, slow_down (+5 s for good), pending again after the interval', async () => {
    const { device_code } = await s.requestCode()
    let r = await s.poll(device_code)
    expect(r.status).toBe(400)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect((await json<Body>(r)).error).toBe('authorization_pending')
    // polling too fast
    r = await s.poll(device_code)
    const slow = await json<Body>(r)
    expect(slow.error).toBe('slow_down')
    expect(slow.details).toEqual({ interval: 10 })
    expect((await rowOf(device_code))?.intervalS).toBe(10)
    // 6 s later is still too soon for the new 10 s interval
    await pollAgo(device_code, 6)
    expect((await json<Body>(await s.poll(device_code))).error).toBe('slow_down')
    expect((await rowOf(device_code))?.intervalS).toBe(15)
    await pollAgo(device_code, 16)
    expect((await json<Body>(await s.poll(device_code))).error).toBe('authorization_pending')
    expect((await rowOf(device_code))?.intervalS).toBe(15)
  })

  it('approve read-only → one viewer token (origin device, 90 days), audited with the requester IP', async () => {
    const { device_code, user_code } = await s.requestCode('acme', 'spoor-cli/0.1.0 on laptop')
    const web = await s.login(s.dev)
    const look = await web.get(`/api/v1/device/lookup?code=${encodeURIComponent(user_code.toLowerCase())}`)
    expect(look.status).toBe(200)
    const lb = await json<Body>(look)
    expect(lb).toMatchObject({
      project: { slug: 'acme', name: 'Acme Secret Name' },
      client_name: 'spoor-cli/0.1.0 on laptop',
      requester_ip: '203.0.113.7',
      your_role: 'editor',
    })
    expect(typeof lb.age_s).toBe('number')
    expect(lb.age_s as number).toBeGreaterThanOrEqual(0)
    expect(Date.parse(lb.requested_at as string)).not.toBeNaN()

    const ok = await web.post('/api/v1/device/approve', { code: user_code.replace('-', ''), read_only: true })
    expect(ok.status).toBe(200)
    expect(await json(ok)).toEqual({ status: 'approved', role_cap: 'viewer' })

    const r = await s.poll(device_code)
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    const t = await json<Body>(r)
    expect(t.token_type).toBe('Bearer')
    expect(t.project).toBe('acme')
    expect(t.role).toBe('viewer')
    expect(t.access_token).toMatch(/^spr_[A-Za-z0-9_-]{43}$/)
    expect(t.token_name).toMatch(/^spoor-cli\/0\.1\.0 on laptop \(device \d{4}-\d{2}-\d{2}\)$/)

    const [tok] = await db()
      .select()
      .from(tokens)
      .where(eq(tokens.tokenHash, sha256(t.access_token as string)))
    expect(tok).toMatchObject({ kind: 'user', origin: 'device', role: 'viewer', userId: s.dev.id })
    const days = await db().execute(
      sql`SELECT round(extract(epoch from expires_at - created_at) / 86400)::int AS d FROM tokens WHERE id = ${tok?.id}`,
    )
    expect(days.rows[0]?.d).toBe(90)
    expect((await rowOf(device_code))?.status).toBe('consumed')
    expect((await rowOf(device_code))?.tokenId).toBe(tok?.id)

    // the token works, read-only
    const who = await s.cli.get('/p/acme/api/whoami', {
      origin: null,
      headers: { authorization: `Bearer ${t.access_token}` },
    })
    expect(who.status).toBe(200)
    expect((await json<{ token: { role: string } }>(who)).token.role).toBe('viewer')
    const push = await s.cli.post(
      '/p/acme/api/push',
      { space: 'docs', source_path: 'a.md', content: '# A' },
      { origin: null, headers: { authorization: `Bearer ${t.access_token}` } },
    )
    expect((await json<Body>(push)).error).toBe('forbidden_role')

    // exactly once
    expect((await json<Body>(await s.poll(device_code))).error).toBe('invalid_grant')

    const audit = await db().select().from(auditLog).where(eq(auditLog.projectId, s.acme.id))
    const created = audit.find((a) => a.action === 'token.create')
    expect(created?.data).toMatchObject({ origin: 'device', requester_ip: '203.0.113.7', role: 'viewer' })
    expect(created?.actorUserId).toBe(s.dev.id)
    expect(JSON.stringify(created)).not.toContain(t.access_token as string)
    expect(audit.find((a) => a.action === 'device.approve')?.data).toMatchObject({ role_cap: 'viewer' })
  })

  it('a plain approve inherits the live role; an extra login adds a token, old ones stay', async () => {
    const first = await s.requestCode()
    const web = await s.login(s.dev)
    await web.post('/api/v1/device/approve', { code: first.user_code })
    const t1 = await json<Body>(await s.poll(first.device_code))
    expect(t1.role).toBe('editor')
    const second = await s.requestCode()
    const ok = await web.post('/api/v1/device/approve', { code: second.user_code, read_only: false })
    expect(await json(ok)).toEqual({ status: 'approved', role_cap: null })
    const t2 = await json<Body>(await s.poll(second.device_code))
    expect(t2.access_token).not.toBe(t1.access_token)
    const mine = await db().select().from(tokens).where(eq(tokens.userId, s.dev.id))
    expect(mine).toHaveLength(2)
    expect(mine.every((t) => t.role === null && t.revokedAt === null)).toBe(true)
  })

  it('deny → access_denied; expired → expired_token; unknown or other-project codes → invalid_grant', async () => {
    const denied = await s.requestCode()
    const web = await s.login(s.dev)
    const d = await web.post('/api/v1/device/deny', { code: denied.user_code })
    expect(await json(d)).toEqual({ status: 'denied' })
    expect((await json<Body>(await s.poll(denied.device_code))).error).toBe('access_denied')
    expect((await db().select().from(auditLog).where(eq(auditLog.action, 'device.deny'))).length).toBe(1)

    const late = await s.requestCode()
    await db()
      .update(deviceCodes)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(deviceCodes.deviceCodeHash, sha256(late.device_code)))
    expect((await json<Body>(await s.poll(late.device_code))).error).toBe('expired_token')
    // an expired code cannot be approved any more
    expect((await web.post('/api/v1/device/approve', { code: late.user_code })).status).toBe(404)

    const mine = await s.requestCode('acme')
    expect((await json<Body>(await s.poll(mine.device_code, 'other'))).error).toBe('invalid_grant')
    expect((await json<Body>(await s.poll('x'.repeat(43)))).error).toBe('invalid_grant')
    expect((await json<Body>(await s.poll(''))).error).toBe('invalid_grant')
    expect((await s.poll(mine.device_code, 'nope')).status).toBe(404)
    const g = await s.poll(mine.device_code, 'acme', 'authorization_code')
    expect(g.status).toBe(400)
    expect((await json<Body>(g)).error).toBe('unsupported_grant_type')
  })

  it('two concurrent polls of an approved code mint exactly one token', async () => {
    const c = await s.requestCode()
    const web = await s.login(s.dev)
    await web.post('/api/v1/device/approve', { code: c.user_code })
    const [a, b] = await Promise.all([s.poll(c.device_code), s.poll(c.device_code)])
    expect([a.status, b.status].sort()).toEqual([200, 400])
    const err = await json<Body>(a.status === 400 ? a : b)
    expect(err.error).toBe('invalid_grant')
    expect(await db().select().from(tokens)).toHaveLength(1)
  })

  it('an approver who lost access before the poll gets no token (access_denied, code closed)', async () => {
    const c = await s.requestCode()
    const web = await s.login(s.dev)
    await web.post('/api/v1/device/approve', { code: c.user_code })
    await db()
      .delete(memberships)
      .where(and(eq(memberships.projectId, s.acme.id), eq(memberships.userId, s.dev.id)))
    expect((await json<Body>(await s.poll(c.device_code))).error).toBe('access_denied')
    expect((await rowOf(c.device_code))?.status).toBe('denied')
    expect(await db().select().from(tokens)).toHaveLength(0)
  })
})

describe('browser side: lookup, approve, deny', () => {
  it('needs a session, the origin check and no Authorization header', async () => {
    const c = await s.requestCode()
    const anon = new Client(s.app)
    expect((await anon.get(`/api/v1/device/lookup?code=${c.user_code}`)).status).toBe(401)
    const web = await s.login(s.dev)
    const cross = await web.post(
      '/api/v1/device/approve',
      { code: c.user_code },
      { origin: 'https://evil.example' },
    )
    expect(cross.status).toBe(403)
    expect((await json<Body>(cross)).error).toBe('forbidden_origin')
    const bearer = await web.get(`/api/v1/device/lookup?code=${c.user_code}`, {
      headers: { authorization: 'Bearer spr_x' },
    })
    expect(bearer.status).toBe(400)
    expect((await rowOf(c.device_code))?.status).toBe('pending')
  })

  it('a non-member gets exactly the 404 of an unknown code, for lookup, approve and deny', async () => {
    const c = await s.requestCode()
    const web = await s.login(s.outsider)
    const unknown = await json<Body>(await web.get('/api/v1/device/lookup?code=BBBB-BBBB'))
    for (const r of [
      await web.get(`/api/v1/device/lookup?code=${c.user_code}`),
      await web.post('/api/v1/device/approve', { code: c.user_code }),
      await web.post('/api/v1/device/deny', { code: c.user_code }),
    ]) {
      expect(r.status).toBe(404)
      const b = await json<Body>(r)
      expect({ ...b, request_id: null }).toEqual({ ...unknown, request_id: null })
    }
    expect((await rowOf(c.device_code))?.status).toBe('pending')
  })

  it('a viewer may approve (the token stays viewer); an instance admin without membership may too', async () => {
    const c = await s.requestCode()
    const v = await s.login(s.viewer)
    expect((await json<Body>(await v.get(`/api/v1/device/lookup?code=${c.user_code}`))).your_role).toBe(
      'viewer',
    )
    await v.post('/api/v1/device/approve', { code: c.user_code })
    expect((await json<Body>(await s.poll(c.device_code))).role).toBe('viewer')

    const c2 = await s.requestCode()
    const ia = await s.login(s.admin)
    expect((await json<Body>(await ia.get(`/api/v1/device/lookup?code=${c2.user_code}`))).your_role).toBe(
      'admin',
    )
    await ia.post('/api/v1/device/approve', { code: c2.user_code })
    expect((await json<Body>(await s.poll(c2.device_code))).role).toBe('admin')
  })

  it('a decided code cannot be decided again', async () => {
    const c = await s.requestCode()
    const web = await s.login(s.dev)
    expect((await web.post('/api/v1/device/deny', { code: c.user_code })).status).toBe(200)
    expect((await web.post('/api/v1/device/approve', { code: c.user_code })).status).toBe(404)
    expect((await rowOf(c.device_code))?.status).toBe('denied')
  })

  it('5 misses in 10 minutes lock the user (not others) out of lookup, approve and deny', async () => {
    const c = await s.requestCode()
    const web = await s.login(s.dev)
    for (let i = 0; i < 4; i++) {
      expect((await web.get(`/api/v1/device/lookup?code=BBBB-BBB${'CDFGH'[i]}`)).status).toBe(404)
    }
    const fifth = await web.get('/api/v1/device/lookup?code=not-a-code')
    expect(fifth.status).toBe(403)
    const fb = await json<Body>(fifth)
    expect(fb.error).toBe('forbidden')
    expect(fb.hint).toMatch(/locked/)
    // the right code is refused too, on every endpoint and from a new session
    expect((await web.get(`/api/v1/device/lookup?code=${c.user_code}`)).status).toBe(403)
    const again = await s.login(s.dev)
    expect((await again.post('/api/v1/device/approve', { code: c.user_code })).status).toBe(403)
    expect((await again.post('/api/v1/device/deny', { code: c.user_code })).status).toBe(403)
    expect((await rowOf(c.device_code))?.status).toBe('pending')
    // another member is not affected
    const v = await s.login(s.viewer)
    expect((await v.get(`/api/v1/device/lookup?code=${c.user_code}`)).status).toBe(200)
  })

  it('non-member lookups count as misses (no probing of other projects)', async () => {
    const c = await s.requestCode()
    const web = await s.login(s.outsider)
    for (let i = 0; i < 4; i++)
      expect((await web.get(`/api/v1/device/lookup?code=${c.user_code}`)).status).toBe(404)
    expect((await web.get(`/api/v1/device/lookup?code=${c.user_code}`)).status).toBe(403)
  })

  it('rejects unknown fields and bad codes in the body', async () => {
    const c = await s.requestCode()
    const web = await s.login(s.dev)
    expect((await web.post('/api/v1/device/approve', { code: c.user_code, role: 'admin' })).status).toBe(400)
    expect((await web.post('/api/v1/device/approve', { code: 'x'.repeat(100) })).status).toBe(400)
    expect((await web.get('/api/v1/device/lookup')).status).toBe(400)
    expect((await rowOf(c.device_code))?.status).toBe('pending')
  })
})
