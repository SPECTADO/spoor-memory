// The agent request log (ADR-0018, api.md 10.3) through the assembled app: MCP tool calls and CLI calls are
// recorded with actor, token, agent, operation, space, type, handles, query and outcome; admins read the log,
// other members get 403; every member sees the last read and write on the dashboard.
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { DashboardResponse, RequestRowJson } from '@spoor/shared'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
import { json, loginAs, TEST_ORIGIN, testApp } from '../../../test/http.js'
import { memberships } from '../../db/schema.js'

const db = () => testDb()
const P = '/api/v1/projects/acme'
const open: McpClient[] = []

async function seed() {
  const { app, modules } = testApp()
  await createSharedProject(db())
  const acme = await createProject(db(), { slug: 'acme' })
  const projectAdmin = await createUser(db())
  const editor = await createUser(db(), { email: 'dev@example.com' })
  const viewer = await createUser(db())
  const outsider = await createUser(db())
  const admin = await createAdmin(db())
  await addMember(db(), acme.id, projectAdmin.id, 'admin')
  await addMember(db(), acme.id, editor.id, 'editor')
  await addMember(db(), acme.id, viewer.id, 'viewer')
  const token = await createToken(db(), { projectId: acme.id, userId: editor.id, name: 'laptop' })
  const login = (u: { email: string }) => loginAs(app, u.email, DEFAULT_PASSWORD)
  return { app, modules, acme, projectAdmin, editor, viewer, outsider, admin, token, login }
}

let s: Awaited<ReturnType<typeof seed>>
beforeEach(async () => {
  s = await seed()
})
afterEach(async () => {
  for (const c of open.splice(0)) await c.close().catch(() => {})
})

async function connect(token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${TEST_ORIGIN}/p/acme/mcp`), {
    fetch: async (url, init) => s.app.request(String(url), init),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  const client = new McpClient({ name: 'claude-code', version: '2.1.303' })
  await client.connect(transport)
  open.push(client)
  return client
}

const text = (r: Awaited<ReturnType<McpClient['callTool']>>) =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n')

async function list(query = '') {
  const c = await s.login(s.projectAdmin)
  const r = await c.get(`${P}/requests${query}`)
  expect(r.status).toBe(200)
  return (await json<{ items: RequestRowJson[]; next_cursor: string | null }>(r)).items
}

describe('recording', () => {
  it('records MCP tool calls with actor, token, agent, space, type, handles, query and outcome', async () => {
    const mcp = await connect(s.token.secret)
    const created = text(
      await mcp.callTool({ name: 'spoor_remember', arguments: { title: 'Sessions live in Postgres' } }),
    )
    const handle = /OK created (m\d+)/.exec(created)?.[1] as string
    await mcp.callTool({ name: 'spoor_search', arguments: { query: 'sessions', type: 'fact' } })
    await mcp.callTool({ name: 'spoor_get', arguments: { ids: ['m999'] } })

    const [get, search, remember] = await list()
    expect(remember).toMatchObject({
      kind: 'write',
      surface: 'mcp',
      operation: 'spoor_remember',
      actor: {
        user_id: s.editor.id,
        label: 'dev@example.com',
        token: { id: s.token.id, name: 'laptop', prefix: s.token.prefix },
        client_name: 'claude-code/2.1.303',
      },
      space: 'memories',
      memory_type: 'fact',
      handles: [handle],
      query: null,
      outcome: 'ok',
    })
    expect(remember?.duration_ms).toBeGreaterThanOrEqual(0)
    expect(search).toMatchObject({
      kind: 'read',
      operation: 'spoor_search',
      memory_type: 'fact',
      query: 'sessions',
      outcome: 'ok',
    })
    expect(get).toMatchObject({ kind: 'read', operation: 'spoor_get', handles: [], outcome: 'not_found' })
  })

  it('records a refused write with its error code', async () => {
    const writer = await connect(s.token.secret)
    // demoted mid-session: the session keeps its write tools, and each call is refused
    await db()
      .update(memberships)
      .set({ role: 'viewer' })
      .where(and(eq(memberships.projectId, s.acme.id), eq(memberships.userId, s.editor.id)))
    await writer.callTool({ name: 'spoor_remember', arguments: { title: 'Refused' } })
    const [row] = await list()
    expect(row).toMatchObject({ operation: 'spoor_remember', kind: 'write', outcome: 'forbidden_role' })
  })

  it('records CLI calls on the bearer API, but not whoami', async () => {
    const auth = { authorization: `Bearer ${s.token.secret}`, 'user-agent': 'spoor-cli/0.2.0' }
    expect((await s.app.request('/p/acme/api/whoami', { headers: auth })).status).toBe(200)
    const r = await s.app.request('/p/acme/api/context?query=deploy&file=src/app.ts', { headers: auth })
    expect(r.status).toBe(200)
    const rows = await list()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'read',
      surface: 'cli',
      operation: 'GET /context',
      actor: { label: 'dev@example.com', client_name: 'spoor-cli/0.2.0' },
      query: 'deploy',
      outcome: 'ok',
      data: { files: ['src/app.ts'], status: 200 },
    })
  })

  it('records a failed CLI call with its error code', async () => {
    const r = await s.app.request('/p/acme/api/push', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token.secret}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(r.status).toBe(400)
    const [row] = await list()
    expect(row).toMatchObject({ kind: 'write', operation: 'POST /push', outcome: 'invalid_input' })
  })
})

describe('GET /api/v1/projects/:slug/requests', () => {
  it('is for project and instance admins only', async () => {
    const mcp = await connect(s.token.secret)
    await mcp.callTool({ name: 'spoor_search', arguments: { query: 'x' } })
    for (const u of [s.projectAdmin, s.admin]) {
      const r = await (await s.login(u)).get(`${P}/requests`)
      expect(r.status).toBe(200)
    }
    for (const u of [s.editor, s.viewer]) {
      expect((await (await s.login(u)).get(`${P}/requests`)).status).toBe(403)
    }
    expect((await (await s.login(s.outsider)).get(`${P}/requests`)).status).toBe(404)
    expect((await (await s.login(s.admin)).get('/api/v1/projects/_shared/requests')).status).toBe(403)
  })

  it('filters by kind, surface and actor and pages by cursor', async () => {
    const mcp = await connect(s.token.secret)
    await mcp.callTool({ name: 'spoor_remember', arguments: { title: 'One fact' } })
    await mcp.callTool({ name: 'spoor_search', arguments: { query: 'a' } })
    await mcp.callTool({ name: 'spoor_search', arguments: { query: 'b' } })
    expect((await list('?kind=write')).map((r) => r.operation)).toEqual(['spoor_remember'])
    expect(await list('?surface=cli')).toEqual([])
    expect(await list('?actor=laptop')).toHaveLength(3)
    expect(await list('?actor=CLAUDE-CODE')).toHaveLength(3)
    expect(await list('?actor=nobody')).toEqual([])

    const c = await s.login(s.projectAdmin)
    const first = await json<{ items: RequestRowJson[]; next_cursor: string }>(
      await c.get(`${P}/requests?limit=2`),
    )
    expect(first.items.map((r) => r.query)).toEqual(['b', 'a'])
    const second = await json<{ items: RequestRowJson[]; next_cursor: string | null }>(
      await c.get(`${P}/requests?limit=2&cursor=${first.next_cursor}`),
    )
    expect(second.items.map((r) => r.operation)).toEqual(['spoor_remember'])
    expect(second.next_cursor).toBeNull()
  })
})

describe('dashboard last_requests', () => {
  it('shows every member the newest read and write', async () => {
    const viewer = await s.login(s.viewer)
    const before = await json<DashboardResponse>(await viewer.get(`${P}/dashboard`))
    expect(before.last_requests).toEqual({ read: null, write: null })

    const mcp = await connect(s.token.secret)
    await mcp.callTool({ name: 'spoor_remember', arguments: { title: 'A fact' } })
    await mcp.callTool({ name: 'spoor_context', arguments: {} })
    const d = await json<DashboardResponse>(await viewer.get(`${P}/dashboard`))
    expect(d.last_requests.read).toMatchObject({
      surface: 'mcp',
      operation: 'spoor_context',
      actor: { label: 'dev@example.com', client_name: 'claude-code/2.1.303' },
    })
    expect(d.last_requests.write).toMatchObject({ operation: 'spoor_remember' })
  })
})
