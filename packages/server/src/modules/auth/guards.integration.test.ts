// The /api/v1 request guards (auth-and-security.md section 4; api.md section 0.1; deviation I28).
import { describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import { createUser, DEFAULT_PASSWORD } from '../../../test/factories.js'
import { Client, json, loginAs, testApp } from '../../../test/http.js'

const login = { email: 'ann@example.com', password: DEFAULT_PASSWORD }

describe('origin check on unsafe /api/v1 requests', () => {
  it('accepts the public origin and rejects any other, never trusting Host', async () => {
    const { app } = testApp()
    await createUser(testDb(), { email: 'ann@example.com' })
    expect((await new Client(app).post('/api/v1/auth/login', login)).status).toBe(200)
    for (const origin of ['http://evil.example', 'http://localhost:3001', 'null', 'https://localhost:3000']) {
      const res = await new Client(app, origin).post('/api/v1/auth/login', login, {
        headers: { host: new URL(origin === 'null' ? 'http://x' : origin).host },
      })
      expect(res.status, origin).toBe(403)
      expect(await json(res)).toMatchObject({ error: 'forbidden_origin' })
    }
  })

  it('without Origin, requires Sec-Fetch-Site: same-origin', async () => {
    const { app } = testApp()
    await createUser(testDb(), { email: 'ann@example.com' })
    const c = new Client(app)
    const none = await c.post('/api/v1/auth/login', login, { origin: null })
    expect(none.status).toBe(403)
    expect((await json(none)).error).toBe('forbidden_origin')
    const cross = await c.post('/api/v1/auth/login', login, {
      origin: null,
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    expect(cross.status).toBe(403)
    const same = await c.post('/api/v1/auth/login', login, {
      origin: null,
      headers: { 'sec-fetch-site': 'same-origin' },
    })
    expect(same.status).toBe(200)
  })

  it('applies to logged-in mutations too (a stolen-cookie CSRF attempt fails)', async () => {
    const { app } = testApp()
    await createUser(testDb(), { email: 'ann@example.com' })
    const c = await loginAs(app, 'ann@example.com', DEFAULT_PASSWORD)
    const res = await c.patch('/api/v1/me', { name: 'Pwned' }, { origin: 'http://evil.example' })
    expect(res.status).toBe(403)
    expect((await c.get('/api/v1/me', { origin: 'http://evil.example' })).status).toBe(200) // GET is not checked
  })

  it('requires application/json when a body is present, and only then', async () => {
    const { app } = testApp()
    await createUser(testDb(), { email: 'ann@example.com' })
    const c = new Client(app)
    for (const type of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
    ]) {
      const res = await c.request('POST', '/api/v1/auth/login', {
        raw: JSON.stringify(login),
        headers: { 'content-type': type },
      })
      expect(res.status, type).toBe(400)
      expect((await json(res)).error).toBe('invalid_input')
    }
    const charset = await c.request('POST', '/api/v1/auth/login', {
      raw: JSON.stringify(login),
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
    expect(charset.status).toBe(200)
    // bodyless unsafe request: no Content-Type needed, the origin check alone protects it
    const out = await c.request('POST', '/api/v1/auth/logout')
    expect(out.status).toBe(204)
  })

  it('lets multipart through only on the import upload paths', async () => {
    const { app } = testApp()
    const c = new Client(app)
    const res = await c.request('POST', '/api/v1/projects/acme/import', {
      raw: '--x--',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
    })
    expect(res.status).not.toBe(400) // passes the guard (the import module is not built yet)
    expect((await json(res)).error).not.toBe('forbidden_origin')
  })
})

describe('other /api/v1 guards', () => {
  it('rejects an Authorization header with 400', async () => {
    const { app } = testApp()
    const res = await new Client(app).get('/api/v1/me', { headers: { authorization: 'Bearer spr_x' } })
    expect(res.status).toBe(400)
    expect(await json(res)).toMatchObject({ error: 'invalid_input', hint: expect.stringContaining('/p/') })
  })

  it('caps JSON bodies at 1 MB', async () => {
    const { app } = testApp()
    const res = await new Client(app).request('POST', '/api/v1/auth/login', {
      raw: JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(1024 * 1024) }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.status).toBe(413)
    expect((await json(res)).error).toBe('payload_too_large')
  })

  it('sends the security headers on every response', async () => {
    const { app } = testApp()
    for (const path of ['/api/v1/me', '/healthz', '/api/v1/instance']) {
      const res = await new Client(app).get(path)
      expect(res.headers.get('content-security-policy'), path).toContain("frame-ancestors 'none'")
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('referrer-policy')).toBe('same-origin')
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    }
  })
})
