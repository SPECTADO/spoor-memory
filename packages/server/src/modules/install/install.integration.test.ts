// GET /p/:slug/install.md and /p/:slug/install.json (api.md 11.1, 11.1a; cli-and-hooks.md 7, 9; I35, I39).
import { beforeEach, describe, expect, it } from 'vitest'
import { cliSurfaceApp } from '../../../test/cli-surface-app.js'
import { testDb } from '../../../test/db.js'
import {
  addMember,
  createProject,
  createSharedProject,
  createToken,
  createUser,
} from '../../../test/factories.js'
import { Client, json, loginAs, TEST_ORIGIN } from '../../../test/http.js'
import { renderInstallJson } from './templates.js'

const db = () => testDb()

let app: ReturnType<typeof cliSurfaceApp>['app']
let secret: string
beforeEach(async () => {
  app = cliSurfaceApp({ version: '0.1.0' }).app
  await createSharedProject(db())
  const acme = await createProject(db(), {
    slug: 'acme',
    name: 'Top Secret Project Name',
    settings: { digest: { default_budget: 2000 } },
  })
  const u = await createUser(db())
  await addMember(db(), acme.id, u.id, 'editor')
  secret = (await createToken(db(), { projectId: acme.id, userId: u.id })).secret
})

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(`${TEST_ORIGIN}${path}`, { headers })

describe('GET /p/:slug/install.md', () => {
  it('is public Markdown, no-cache, with URL, slug, version and the project budget', async () => {
    const r = await get('/p/acme/install.md')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(r.headers.get('cache-control')).toBe('no-cache')
    const md = await r.text()
    expect(md).toContain(`spoor login --server ${TEST_ORIGIN} --project acme --no-browser`)
    expect(md).toContain('npm i -g spoor-memory@0.1.0')
    expect(md).toContain('exec npx --yes --prefer-offline spoor-memory@0.1.0 hook session-start')
    expect(md).toContain('about 2000 tokens')
    expect(md).toContain(`curl -s ${TEST_ORIGIN}/p/acme/install.md`)
    expect(md).toContain('WebFetch(domain:localhost)')
    expect(md).toContain('SPOOR_TOKEN_ACME')
  })

  it('carries no project name, no token and nothing per user, logged in or not', async () => {
    const anon = await (await get('/p/acme/install.md')).text()
    expect(anon).not.toContain('Top Secret Project Name')
    expect(anon).not.toMatch(/sprs?_/)
    const withToken = await (await get('/p/acme/install.md', { authorization: `Bearer ${secret}` })).text()
    expect(withToken).toBe(anon)
    const u = await createUser(db())
    const web = await loginAs(app, u.email, u.password)
    const withCookie = await (await web.get('/p/acme/install.md')).text()
    expect(withCookie).toBe(anon)
    expect(withCookie).not.toContain(u.email)
  })

  it('is a text/plain 404 for an unknown slug and for _shared', async () => {
    for (const slug of ['nope', '_shared', 'ACME']) {
      const r = await get(`/p/${slug}/install.md`)
      expect(r.status).toBe(404)
      expect(r.headers.get('content-type')).toMatch(/^text\/plain/)
    }
  })
})

describe('GET /p/:slug/install.json', () => {
  it('is the documented JSON with the literal server URL, slug and version', async () => {
    const r = await get('/p/acme/install.json')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/^application\/json/)
    expect(r.headers.get('cache-control')).toBe('no-cache')
    const b = await json(r)
    expect(b).toEqual(
      renderInstallJson({
        server: TEST_ORIGIN,
        slug: 'acme',
        version: '0.1.0',
        budget: 2000,
        memoryExclusive: true,
      }),
    )
    expect(b).toMatchObject({
      version: '0.1.0',
      server: TEST_ORIGIN,
      project: 'acme',
      mcp_json: { mcpServers: { spoor: { url: `${TEST_ORIGIN}/p/acme/mcp` } } },
      gitignore: ['.claude/settings.local.json', '.spoor/'],
    })
    const text = JSON.stringify(b)
    expect(text).not.toContain('Top Secret Project Name')
    expect(text).not.toMatch(/sprs?_/)
  })

  it('is a JSON 404 for an unknown slug and for _shared', async () => {
    for (const slug of ['nope', '_shared']) {
      const r = await new Client(app).get(`/p/${slug}/install.json`)
      expect(r.status).toBe(404)
      expect((await json(r)).error).toBe('not_found')
    }
  })
})
