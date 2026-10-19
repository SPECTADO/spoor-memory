/**
 * The assembled server: `createApp` with every module mounted and the REAL ports of src/runtime.ts (the
 * search module's SearchService behind SearchPort, the jobs module's scheduler behind JobsPort), with the
 * deterministic fake embedding provider. Each test crosses at least two modules, the way production does:
 * items write chunks through search, search reads what items wrote, the scheduler runs search's jobs,
 * transfer rebuilds chunks through search, the review / undrafted lists read what push wrote.
 */
import { sql } from 'drizzle-orm'
import { unzipSync } from 'fflate'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { testDb, testPool } from '../test/db.js'
import { addMember, createAdmin, createToken, createUser, DEFAULT_PASSWORD } from '../test/factories.js'
import { type Client, json, loginAs, TEST_ORIGIN, testConfig } from '../test/http.js'
import { FakeEmbeddingProvider, StaticEmbeddingRegistry } from '../test/ports.js'
import { createApp, createAppModules } from './app.js'
import { createRuntime } from './runtime.js'
import { newReadyState } from './types.js'

const db = () => testDb()

function assemble() {
  const config = testConfig()
  const logger = pino({ level: 'silent' })
  const provider = new FakeEmbeddingProvider()
  const rt = createRuntime(
    { config, logger, db: db() },
    { embeddings: new StaticEmbeddingRegistry(provider), scheduler: { instanceId: 'it:app' } },
  )
  const modules = createAppModules(rt.deps, { scheduler: rt.scheduler, search: rt.search })
  const state = newReadyState()
  Object.assign(state, { db: 'ok', migrations: 'ok', embedding: 'ok', ready: true })
  const app = createApp({ config, logger, state, ports: rt.ports, modules })
  return { app, rt, modules, provider }
}

type App = ReturnType<typeof assemble>['app']

async function setup() {
  const a = assemble()
  const admin = await createAdmin(db(), { email: 'admin@example.com' })
  const dev = await createUser(db(), { email: 'dev@example.com' })
  const client = await loginAs(a.app, 'admin@example.com', DEFAULT_PASSWORD)
  const res = await client.post('/api/v1/projects', { slug: 'acme', name: 'Acme' })
  expect(res.status).toBe(201)
  const project = await json<{ id: string; embedding: { model: string } }>(res)
  await addMember(db(), project.id, dev.id, 'editor')
  const devClient = await loginAs(a.app, 'dev@example.com', DEFAULT_PASSWORD)
  return { ...a, admin, dev, client, devClient, project }
}

const bearer = (app: App, method: string, path: string, token: string, body?: unknown) =>
  app.request(`${TEST_ORIGIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

interface ItemRes {
  item: { id: string; handle: string; revision: number }
  warnings: { code: string }[]
}

/** `GET …/search` (api.md section 6): `{items: [{item, score, snippet}], notes}`. */
const searchHandles = async (c: Client, slug: string, q: string) => {
  const res = await c.get(`/api/v1/projects/${slug}/search?q=${encodeURIComponent(q)}`)
  expect(res.status).toBe(200)
  const body = await json<{ items: { item: { handle: string; title: string } }[] }>(res)
  return body.items.map((i) => i.item)
}

const createMemory = async (c: Client, title: string, body: string, extra: Record<string, unknown> = {}) => {
  const res = await c.post('/api/v1/projects/acme/spaces/memories/items', {
    title,
    body,
    type: 'fact',
    ...extra,
  })
  expect(res.status).toBe(201)
  return json<ItemRes>(res)
}

const chunkCount = async (itemId: string, where = sql`true`) =>
  Number(
    (
      await db().execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM chunks WHERE item_id = ${itemId} AND ${where}`,
      )
    ).rows[0]?.n,
  )

describe('assembled app: routes of every module are mounted', () => {
  it.each([
    ['GET', '/api/v1/projects/acme/spaces/memories/items'],
    ['GET', '/api/v1/projects/acme/search?q=x'],
    ['GET', '/api/v1/projects/acme/context'],
    ['GET', '/api/v1/projects/acme/review'],
    ['GET', '/api/v1/projects/acme/jobs'],
    ['GET', '/api/v1/jobs'],
    ['GET', '/api/v1/projects/acme/export'],
    ['GET', '/api/v1/projects/acme/dashboard'],
  ])('%s %s answers', async (method, path) => {
    const { client } = await setup()
    const res = await client.request(method, path)
    expect(res.status).toBe(200)
  })

  it('the bearer surface serves context, push, adr/import, decisions/undrafted, activity and adr|docs/push', async () => {
    const { app, project, dev } = await setup()
    const t = await createToken(db(), { projectId: project.id, userId: dev.id })
    expect((await bearer(app, 'GET', '/p/acme/api/context', t.secret)).status).toBe(200)
    expect((await bearer(app, 'GET', '/p/acme/api/decisions/undrafted', t.secret)).status).toBe(200)
    const push = await bearer(app, 'POST', '/p/acme/api/push', t.secret, {
      space: 'docs',
      source_path: 'docs/intro.md',
      content: '# Intro\n\nHello.\n',
    })
    expect(push.status).toBe(200)
    const imp = await bearer(app, 'POST', '/p/acme/api/adr/import', t.secret, {
      files: [{ source_path: 'docs/adr/0001-x.md', content: '# 1. X\n\n## Status\n\nAccepted\n' }],
    })
    expect(imp.status).toBe(200)
    expect((await bearer(app, 'GET', '/p/acme/api/activity', t.secret)).status).toBe(200)
    const docs = await bearer(app, 'POST', '/p/acme/api/docs/push', t.secret, {
      source_path: 'docs/other.md',
      content: '# Other\n\nHi.\n',
    })
    expect(docs.status).toBe(200)
    expect((await bearer(app, 'GET', '/p/acme/api/no-such-thing', t.secret)).status).toBe(404)
  })

  it('the public device, install and MCP surfaces are mounted', async () => {
    const { app } = await setup()
    const code = await app.request('/p/acme/device/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'test' }),
    })
    expect(code.status).toBe(200)
    expect(await json(code)).toMatchObject({ user_code: expect.stringMatching(/^[A-Z]{4}-[A-Z]{4}$/) })
    expect((await app.request('/p/acme/install.md')).status).toBe(200)
    expect((await app.request('/p/acme/install.json')).status).toBe(200)
    expect((await app.request('/p/acme/mcp', { method: 'POST' })).status).toBe(401)
  })

  it('no route is a 501 stub any more; unknown paths and wrong methods are JSON 404s (review SC3)', async () => {
    const { client } = await setup()
    // the last two stubs (deviations.md G16) are built: bulk validates its body
    expect((await client.post('/api/v1/projects/acme/review/bulk', {})).status).toBe(400)
    for (const [method, path] of [
      ['GET', '/api/v1/no-such-thing'],
      ['PUT', '/api/v1/projects/acme'],
    ] as const) {
      const res = await client.request(method, path)
      expect(res.status, `${method} ${path}`).toBe(404)
      expect(await json(res)).toMatchObject({ error: 'not_found' })
    }
  })

  it('/api/v1/instance lists the providers of the bound registry', async () => {
    const { client, provider } = await setup()
    const body = await json<{ providers: { name: string; tag: string; remote: boolean }[] }>(
      await client.get('/api/v1/instance'),
    )
    expect(body.providers).toEqual([{ name: 'local', tag: provider.tag, dims: 384, remote: false }])
  })
})

describe('items -> search through the real SearchPort', () => {
  it('a web write is chunked and embedded with the project model; search and the digest find it', async () => {
    const { client, project, provider } = await setup()
    expect(project.embedding.model).toBe(provider.tag)
    const { item } = await createMemory(
      client,
      'Postgres connection pooling',
      'We use pgbouncer in transaction mode in front of Postgres.',
      { anchors: ['src/db/**'] },
    )
    expect(await chunkCount(item.id, sql`model = ${provider.tag} AND embedding IS NOT NULL`)).toBeGreaterThan(
      0,
    )

    expect((await searchHandles(client, 'acme', 'pgbouncer')).map((i) => i.handle)).toContain(item.handle)

    const ctx = await json<{ text: string; items: string[] }>(
      await client.get('/api/v1/projects/acme/context?format=json&file=src/db/pool.ts'),
    )
    expect(ctx.items).toContain(item.handle)
    expect(ctx.text).toContain('Postgres connection pooling')
  })

  it('a near-duplicate web create gets the duplicate warning from the vector dedupe', async () => {
    const { client } = await setup()
    const body = 'Release builds are signed with the team key stored in the vault.'
    await createMemory(client, 'Release signing', body)
    const second = await createMemory(client, 'Release signing', body)
    expect(second.warnings.map((w) => w.code)).toContain('near_duplicate')
  })

  it('an update re-indexes the item at its new revision', async () => {
    const { client } = await setup()
    const { item } = await createMemory(client, 'Cache policy', 'Responses are cached for five minutes.')
    const res = await client.patch(`/api/v1/projects/acme/items/${item.handle}`, {
      revision: item.revision,
      body: 'Responses are cached for ten minutes behind varnish.',
    })
    expect(res.status).toBe(200)
    expect((await searchHandles(client, 'acme', 'varnish')).map((i) => i.handle)).toEqual([item.handle])
    const revs = await db().execute<{ item_revision: number }>(
      sql`SELECT DISTINCT item_revision FROM chunks WHERE item_id = ${item.id}`,
    )
    expect(revs.rows.map((r) => r.item_revision)).toEqual([2])
  })
})

describe('lock order of content writes (phase-2 review D2)', () => {
  it('a supersede and a PATCH of the same memory, both queued behind the project row, do not deadlock', async () => {
    const { client, project } = await setup()
    const { item } = await createMemory(client, 'Retry policy', 'Retry three times.')
    const blocker = await testPool().connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [project.id])
      const supersede = client.post(`/api/v1/projects/acme/items/${item.handle}/supersede`, {
        new: { title: 'Retry policy v2', body: 'Retry five times.' },
      })
      const patch = client.patch(`/api/v1/projects/acme/items/${item.handle}`, {
        revision: item.revision,
        body: 'Retry four times.',
      })
      await new Promise((r) => setTimeout(r, 300)) // both are now waiting for the project row
      await blocker.query('COMMIT')
      const [a, b] = await Promise.all([supersede, patch])
      // one of them wins; the other is a revision conflict, never a 500 (40P01 deadlock)
      expect([a.status, b.status].sort()).toContain(200)
      for (const r of [a, b]) expect([200, 409]).toContain(r.status)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      blocker.release()
    }
  })
})

describe('jobs run the search module through the scheduler', () => {
  it('a write whose embedding failed is pending, nudges embed-pending, and the job fills it in', async () => {
    const { client, provider, rt } = await setup()
    provider.failNext = true
    const { item } = await createMemory(client, 'Feature flags', 'Flags live in unleash.')
    expect(await chunkCount(item.id, sql`embedding IS NULL`)).toBeGreaterThan(0)

    expect(await rt.scheduler.runNow('embed-pending')).toEqual({ started: true })
    await rt.scheduler.idle()
    expect(await chunkCount(item.id, sql`embedding IS NULL`)).toBe(0)
    const run = await db().execute<{ status: string; stats: { embedded: number } }>(
      sql`SELECT status, stats FROM job_runs WHERE name = 'embed-pending' ORDER BY id DESC LIMIT 1`,
    )
    expect(run.rows[0]).toMatchObject({ status: 'ok', stats: { embedded: expect.any(Number) } })
    expect(run.rows[0]?.stats.embedded).toBeGreaterThan(0)
  })

  it('the cleanup job re-chunks an item with no chunks (consistency sweep) and the admin sees the run', async () => {
    const { client, rt } = await setup()
    const { item } = await createMemory(client, 'Lost chunks', 'These chunks will vanish.')
    await db().execute(sql`DELETE FROM chunks WHERE item_id = ${item.id}`)
    expect(await rt.scheduler.runNow('cleanup')).toEqual({ started: true })
    await rt.scheduler.idle()
    expect(await chunkCount(item.id)).toBeGreaterThan(0)
    const jobs = await json<{ jobs: { name: string; last_status: string | null }[] }>(
      await client.get('/api/v1/jobs'),
    )
    expect(jobs.jobs.find((j) => j.name === 'cleanup')?.last_status).toBe('ok')
  })

  it('a provider switch re-embeds the project through the reembed job and cuts over', async () => {
    const config = testConfig({ SPOOR_OPENAI_API_KEY: 'sk-test' })
    const logger = pino({ level: 'silent' })
    const local = new FakeEmbeddingProvider()
    // a second provider named `openai`, deterministic like the fake
    const fake = new FakeEmbeddingProvider({ model: 'fake/openai', dims: 16 })
    const other = Object.assign(fake, { name: 'openai' }) as unknown as FakeEmbeddingProvider
    const rt = createRuntime(
      { config, logger, db: db() },
      {
        embeddings: new StaticEmbeddingRegistry(local, [other]),
        scheduler: { instanceId: 'it:switch' },
      },
    )
    const modules = createAppModules(rt.deps, { scheduler: rt.scheduler, search: rt.search })
    const state = newReadyState()
    Object.assign(state, { db: 'ok', migrations: 'ok', embedding: 'ok', ready: true })
    const app = createApp({ config, logger, state, ports: rt.ports, modules })
    await createAdmin(db(), { email: 'admin@example.com' })
    const client = await loginAs(app, 'admin@example.com', DEFAULT_PASSWORD)
    expect((await client.post('/api/v1/projects', { slug: 'acme', name: 'Acme' })).status).toBe(201)
    const { item } = await createMemory(client, 'Queue', 'Jobs go through rabbitmq.')

    const patched = await client.patch('/api/v1/projects/acme', {
      settings: { embedding: { provider: 'openai' } },
    })
    expect(patched.status).toBe(200)
    expect(await rt.scheduler.runNow('reembed')).toEqual({ started: true })
    await rt.scheduler.idle()
    const p = await db().execute<{ embedding_model: string; embedding_target: string | null }>(
      sql`SELECT embedding_model, embedding_target FROM projects WHERE slug = 'acme'`,
    )
    expect(p.rows[0]).toEqual({ embedding_model: other.tag, embedding_target: null })
    expect(await chunkCount(item.id, sql`model = ${other.tag} AND embedding IS NOT NULL`)).toBeGreaterThan(0)
    expect(await chunkCount(item.id, sql`model = ${local.tag}`)).toBe(0)
    expect((await searchHandles(client, 'acme', 'rabbitmq')).map((i) => i.handle)).toEqual([item.handle])
  })
})

describe('push -> review / undrafted lists', () => {
  it('a decision memory is undrafted until a pushed ADR is drafted from it', async () => {
    const { app, client, project, dev } = await setup()
    const t = await createToken(db(), { projectId: project.id, userId: dev.id })
    const devClient = await loginAs(app, 'dev@example.com', DEFAULT_PASSWORD)
    const res = await devClient.post('/api/v1/projects/acme/spaces/memories/items', {
      title: 'Use Postgres for everything',
      body: 'One database to operate.',
      type: 'decision',
    })
    expect(res.status).toBe(201)
    const { item } = await json<ItemRes>(res)
    const list = async () =>
      (
        await json<{ items: { handle: string }[] }>(
          await bearer(app, 'GET', '/p/acme/api/decisions/undrafted', t.secret),
        )
      ).items.map((i) => i.handle)
    expect(await list()).toEqual([item.handle])
    const push = await bearer(app, 'POST', '/p/acme/api/push', t.secret, {
      space: 'decisions',
      source_path: 'docs/adr/0001-use-postgres.md',
      content: `---\ndrafted_from: [${item.handle}]\n---\n# 1. Use Postgres\n\n## Status\n\nAccepted\n`,
    })
    expect(push.status).toBe(200)
    expect(await list()).toEqual([])
    // the admin's review queue answers for the same project
    expect((await client.get('/api/v1/projects/acme/review')).status).toBe(200)
  })
})

describe('transfer through the real SearchPort', () => {
  it('export, import as a new project: the imported items are searchable at once, embeddings follow', async () => {
    const { app, client } = await setup()
    const { item } = await createMemory(
      client,
      'Deploy window',
      'Deploys happen on tuesdays after the standup.',
    )
    const exp = await client.get('/api/v1/projects/acme/export')
    expect(exp.status).toBe(200)
    const zip = new Uint8Array(await exp.arrayBuffer())
    expect(Object.keys(unzipSync(zip))).toContain('manifest.json')

    const form = new FormData()
    form.set('file', new File([zip as Uint8Array<ArrayBuffer>], 'acme.zip', { type: 'application/zip' }))
    form.set('slug', 'acme-copy')
    form.set('remap_ids', 'true')
    const imp = await app.request(`${TEST_ORIGIN}/api/v1/projects/import`, {
      method: 'POST',
      headers: { origin: TEST_ORIGIN, cookie: client.cookieHeader() ?? '' },
      body: form,
    })
    expect(imp.status).toBe(200)
    // chunk rows were written in the import transaction (review D-import-chunks): FTS finds it at once
    const chunks = await db().execute<{ n: number; pending: number }>(sql`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE c.embedding IS NULL)::int AS pending
      FROM chunks c JOIN projects p ON p.id = c.project_id WHERE p.slug = 'acme-copy'`)
    expect(chunks.rows[0]?.n).toBeGreaterThan(0)
    expect(chunks.rows[0]?.pending).toBe(chunks.rows[0]?.n)
    const found = await searchHandles(client, 'acme-copy', 'tuesdays')
    expect(found.map((i) => i.title)).toEqual(['Deploy window'])
    expect(found[0]?.handle).toBe(item.handle)
  })
})
