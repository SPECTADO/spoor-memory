// The library space's read-only enforcement (ADR-0014; the plan's section 3 matrix): every write path
// against library page L3 for every kind of caller, the flagged viewer (LV) refused on every other item,
// library wikilinks never captured or taken over, and the `_shared` library.
//
// Actors: IA instance admin, PA project admin, LE editor with the library flag, LV viewer with the flag,
// ED editor without it, VW viewer without it (all six in the web UI); UT a user token of ED, LT a user token
// of LE (a library-right holder) and ST a service token (CLI bearer); MCP the real tool handlers with an
// editor token.
import { and, eq, sql } from 'drizzle-orm'
import { strToU8 } from 'fflate'
import { pino } from 'pino'
import { beforeEach, describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import {
  addMember,
  createAdmin,
  createItem,
  createProject,
  createSharedProject,
  createToken,
  createUser,
} from '../../../test/factories.js'
import { Client, json, loginAs, TEST_ORIGIN, testApp } from '../../../test/http.js'
import { stubPorts } from '../../../test/ports.js'
import { edges, itemRevisions, items, memberships, projects } from '../../db/schema.js'
import type { AuthContext } from '../../lib/auth-context.js'
import { pgError } from '../../lib/db.js'
import { ApiError } from '../../lib/errors.js'
import {
  buildAuthExtra,
  decideTool,
  docWriteTool,
  type McpServices,
  relateTool,
  rememberTool,
  supersedeTool,
  verifyTool,
} from '../mcp/handlers.js'
import {
  decideInput,
  docWriteInput,
  relateInput,
  rememberInput,
  supersedeInput,
  verifyInput,
} from '../mcp/tools.js'
import { writeZip } from '../transfer/zip.js'
import { mapEdgeError } from './links.js'
import { libraryGuardError } from './writes.js'

const db = () => testDb()
const P = '/api/v1/projects/acme'
const SH = '/api/v1/projects/_shared'

const WEB = ['IA', 'PA', 'LE', 'LV', 'ED', 'VW'] as const
type WebActor = (typeof WEB)[number]
type Actor = WebActor | 'UT' | 'LT' | 'ST' | 'MCP'

async function seed() {
  const { app, modules } = testApp({ ports: stubPorts() })
  const shared = await createSharedProject(db())
  const acme = await createProject(db(), { slug: 'acme' })
  const users = {
    IA: await createAdmin(db()),
    PA: await createUser(db()),
    LE: await createUser(db()),
    LV: await createUser(db()),
    ED: await createUser(db()),
    VW: await createUser(db()),
  }
  const se = await createUser(db(), { sharedEditor: true })
  await addMember(db(), acme.id, users.PA.id, 'admin')
  await addMember(db(), acme.id, users.LE.id, 'editor', { libraryEditor: true })
  await addMember(db(), acme.id, users.LV.id, 'viewer', { libraryEditor: true })
  await addMember(db(), acme.id, users.ED.id, 'editor')
  await addMember(db(), acme.id, users.VW.id, 'viewer')
  // m1, d2, L3, m4, L5 (one shared counter: library numbers are sparse)
  const m1 = await createItem(db(), { projectId: acme.id, slug: 'session-store', title: 'Session store' })
  const d2 = await createItem(db(), {
    projectId: acme.id,
    space: 'docs',
    slug: 'some-doc',
    title: 'Some doc',
  })
  const L3 = await createItem(db(), { projectId: acme.id, space: 'library', slug: 'guide', title: 'Guide' })
  const m4 = await createItem(db(), { projectId: acme.id, title: 'Another memory' })
  const L5 = await createItem(db(), { projectId: acme.id, space: 'library', slug: 'style', title: 'Style' })
  const ut = await createToken(db(), { projectId: acme.id, userId: users.ED.id })
  const lt = await createToken(db(), { projectId: acme.id, userId: users.LE.id })
  const st = await createToken(db(), { projectId: acme.id, kind: 'service', role: 'editor' })
  const items = modules.items.items
  const services: McpServices = {
    items,
    search: modules.search.search,
    context: modules.search.context,
    logger: pino({ level: 'silent' }),
  }
  const auth: AuthContext & { project: NonNullable<AuthContext['project']> } = {
    user: {
      id: users.ED.id,
      email: users.ED.email,
      name: users.ED.name,
      isAdmin: false,
      sharedEditor: false,
    },
    project: { id: acme.id, slug: 'acme', name: acme.name, kind: 'project' },
    role: 'editor',
    via: 'bearer',
    tokenId: ut.id,
    clientName: 'claude-code/2.1.303',
  }
  const mcpX = buildAuthExtra(auth, shared.id, 'req-1')
  const clients = new Map<string, Client>()
  const web = async (a: WebActor) => {
    let c = clients.get(a)
    if (!c) {
      c = await loginAs(app, users[a].email, users[a].password)
      clients.set(a, c)
    }
    return c
  }
  const bearer = (secret: string, path: string, body: unknown) =>
    new Client(app).request('POST', `/p/acme/api${path}`, {
      body,
      origin: null,
      headers: { authorization: `Bearer ${secret}`, 'user-agent': 'spoor-cli/0.1.0' },
    })
  const bearerGet = (secret: string, path: string) =>
    new Client(app).request('GET', `/p/acme/api${path}`, {
      origin: null,
      headers: { authorization: `Bearer ${secret}`, 'user-agent': 'spoor-cli/0.1.0' },
    })
  const tokenSecret = (a: 'UT' | 'LT' | 'ST') => (a === 'UT' ? ut : a === 'LT' ? lt : st).secret
  return {
    app,
    items,
    services,
    mcpX,
    shared,
    acme,
    users,
    se,
    m1,
    d2,
    L3,
    m4,
    L5,
    ut,
    lt,
    st,
    web,
    bearer,
    bearerGet,
    tokenSecret,
  }
}
type Ctx = Awaited<ReturnType<typeof seed>>

let s: Ctx
beforeEach(async () => {
  s = await seed()
})

// ---- outcomes ----------------------------------------------------------------------------------------

const SHORT: Record<string, string> = {
  read_only_space: 'RO',
  forbidden: 'FB',
  wrong_space: 'WS',
  invalid_input: 'II',
}

/** `201`, `RO`, `FB`, `WS`, `II`, or `<status> <code>` for anything unexpected. */
async function outcome(r: Response): Promise<string> {
  if (r.status < 300) return String(r.status)
  const b = await json<{ error: string }>(r)
  return SHORT[b.error] ?? `${r.status} ${b.error}`
}

/** A service or tool call: `ok`, or the short code of the ApiError. */
async function called(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'ok'
  } catch (e) {
    if (e instanceof ApiError) return SHORT[e.code] ?? e.code
    throw e
  }
}

const mcp = {
  remember: (a: unknown) => rememberTool(s.services)(rememberInput.parse(a), s.mcpX, {}),
  decide: (a: unknown) => decideTool(s.services)(decideInput.parse(a), s.mcpX, {}),
  docWrite: (a: unknown) => docWriteTool(s.services)(docWriteInput.parse(a), s.mcpX, {}),
  supersede: (a: unknown) => supersedeTool(s.services)(supersedeInput.parse(a), s.mcpX, {}),
  relate: (a: unknown) => relateTool(s.services)(relateInput.parse(a), s.mcpX, {}),
  verify: (a: unknown) => verifyTool(s.services)(verifyInput.parse(a), s.mcpX, {}),
}

const seedEdge = async (src: { id: string; projectId: string }, kind: 'refines', dst: { id: string }) => {
  const [e] = await db()
    .insert(edges)
    .values({
      projectId: src.projectId,
      srcId: src.id,
      kind,
      dstRef: dst.id,
      dstId: dst.id,
      createdByLabel: 't',
    })
    .returning({ id: edges.id })
  return (e as { id: string }).id
}
const archive = (id: string) =>
  db()
    .update(items)
    .set({ lifecycle: 'archived', archivedAt: sql`now()`, archiveReason: 'manual' })
    .where(eq(items.id, id))
const bulkOutcome = async (r: Response, handle: string) => {
  if (r.status !== 200) return outcome(r)
  const b = await json<{ done: string[]; skipped: { handle: string; reason: string }[] }>(r)
  if (b.done.includes(handle)) return 'done'
  const k = b.skipped.find((x) => x.handle === handle)
  return k ? `skipped:${SHORT[k.reason] ?? k.reason}` : 'missing'
}

// ---- the matrix ----------------------------------------------------------------------------------------

interface Row {
  row: string
  path: string
  run: (a: Actor) => Promise<string>
  expected: Partial<Record<Actor, string>>
}

/** The four humans holding the library right get `ok`, ED `ed`, VW `vw`, plus any extra actors. */
const humans = (ok: string, ed: string, vw: string, extra: Partial<Record<Actor, string>> = {}) => ({
  IA: ok,
  PA: ok,
  LE: ok,
  LV: ok,
  ED: ed,
  VW: vw,
  ...extra,
})

/** A web route for the six web actors, or an MCP / service call for `MCP`. */
const route =
  (webCall: (c: Client) => Promise<Response>, mcpCall?: () => Promise<unknown>) => async (a: Actor) => {
    if (a === 'MCP') return called((mcpCall as () => Promise<unknown>)())
    return outcome(await webCall(await s.web(a as WebActor)))
  }

/** A path only the MCP column reaches. */
const mcpOnly = (mcpCall: () => Promise<unknown>) => async (_a: Actor) => called(mcpCall())

const MATRIX: Row[] = [
  {
    row: '1',
    path: 'POST spaces/library/items (MCP: the create service as an agent)',
    run: route(
      (c) => c.post(`${P}/spaces/library/items`, { title: 'New page', body: 'Text.' }),
      () =>
        s.items.create(
          { ctx: s.mcpX.auth, via: 'mcp', project: { id: s.acme.id, slug: 'acme', kind: 'project' } },
          'library',
          { title: 'Agent page' },
        ),
    ),
    expected: humans('201', 'RO', 'FB', { MCP: 'RO' }),
  },
  {
    row: '2',
    path: 'PATCH items/L3 (MCP: spoor_doc_write id=L3)',
    run: route(
      (c) =>
        c.patch(`${P}/items/L3`, { revision: 1, title: 'Edited', tags: ['ops'], anchors: ['src/app.ts'] }),
      () => mcp.docWrite({ id: 'L3', revision: 1, title: 'Edited', body: 'x' }),
    ),
    expected: humans('200', 'RO', 'FB', { MCP: 'RO' }),
  },
  {
    row: '2m',
    path: 'spoor_remember id=L3',
    run: mcpOnly(() => mcp.remember({ id: 'L3', revision: 1, title: 'Edited guide' })),
    expected: { MCP: 'RO' },
  },
  {
    row: '2a',
    path: 'PATCH slug of an item (schema row, not a library guard: slug is immutable for every item; VW meets the viewer guard first)',
    run: route((c) => c.patch(`${P}/items/L3`, { revision: 1, slug: 'other' })),
    expected: humans('II', 'II', 'FB'),
  },
  {
    row: '2b',
    path: 'PATCH space of an item (schema row, not a library guard: space is immutable for every item; VW meets the viewer guard first)',
    run: route((c) => c.patch(`${P}/items/m1`, { revision: 1, space: 'library' })),
    expected: humans('II', 'II', 'FB'),
  },
  {
    row: '3',
    path: 'POST items/L3/pin',
    run: route((c) => c.post(`${P}/items/L3/pin`, {})),
    expected: humans('WS', 'RO', 'FB'),
  },
  {
    row: '3u',
    path: 'POST items/L3/unpin',
    run: route((c) => c.post(`${P}/items/L3/unpin`, {})),
    expected: humans('WS', 'RO', 'FB'),
  },
  {
    row: '4',
    path: 'POST items/L3/verify (MCP: spoor_verify [L3])',
    run: async (a) => {
      if (a !== 'MCP') return outcome(await (await s.web(a as WebActor)).post(`${P}/items/L3/verify`, {}))
      const text = String(await mcp.verify({ ids: ['L3'] }))
      return /skipped: L3 read_only_space/.test(text) ? 'skipped:RO' : text
    },
    expected: humans('WS', 'RO', 'FB', { MCP: 'skipped:RO' }),
  },
  {
    row: '5',
    path: 'POST items/L3/archive',
    run: route((c) => c.post(`${P}/items/L3/archive`, {})),
    expected: humans('200', 'RO', 'FB'),
  },
  {
    row: '6',
    path: 'POST items/L3/restore',
    run: async (a) => {
      await archive(s.L3.id)
      return route((c) => c.post(`${P}/items/L3/restore`, {}))(a)
    },
    expected: humans('200', 'RO', 'FB'),
  },
  {
    row: '6a',
    path: 'restore L3 with promote_to_fact',
    run: async (a) => {
      await archive(s.L3.id)
      return route((c) => c.post(`${P}/items/L3/restore`, { promote_to_fact: true, revision: 1 }))(a)
    },
    expected: humans('WS', 'RO', 'FB'),
  },
  {
    row: '7',
    path: 'supersede L3 (route; MCP: spoor_supersede old=L3)',
    run: route(
      (c) => c.post(`${P}/items/L3/supersede`, { new: { title: 'Newer guide' } }),
      () => mcp.supersede({ old: 'L3', new: { title: 'Newer guide' } }),
    ),
    expected: humans('WS', 'RO', 'FB', { MCP: 'RO' }),
  },
  {
    row: '7c',
    path: 'create a library page with supersedes: L3',
    run: route((c) => c.post(`${P}/spaces/library/items`, { title: 'Next guide', supersedes: 'L3' })),
    expected: humans('WS', 'RO', 'FB'),
  },
  {
    row: '7n',
    path: 'spoor_supersede old=m1 new_id=L3',
    run: mcpOnly(() => mcp.supersede({ old: 'm1', new_id: 'L3' })),
    expected: { MCP: 'RO' },
  },
  {
    row: '7d',
    path: 'spoor_decide supersedes=L3',
    run: mcpOnly(() => mcp.decide({ title: 'Use the new guide', supersedes: 'L3' })),
    expected: { MCP: 'RO' },
  },
  {
    row: '8',
    path: 'DELETE items/L3',
    run: route((c) => c.delete(`${P}/items/L3?confirm=L3`)),
    expected: { IA: '204', PA: '204', LE: 'FB', LV: 'FB', ED: 'FB', VW: 'FB' },
  },
  {
    row: '9',
    path: 'edge L3 → L5 (MCP: spoor_relate from=L3)',
    run: route(
      (c) => c.post(`${P}/items/L3/edges`, { kind: 'refines', to: 'L5' }),
      () => mcp.relate({ from: 'L3', kind: 'refines', to: 'L5' }),
    ),
    expected: humans('201', 'RO', 'FB', { MCP: 'RO' }),
  },
  {
    row: '10',
    path: 'edge L3 → m1 refines',
    run: route(
      (c) => c.post(`${P}/items/L3/edges`, { kind: 'refines', to: 'm1' }),
      () => mcp.relate({ from: 'L3', kind: 'refines', to: 'm1' }),
    ),
    expected: humans('201', 'RO', 'FB', { MCP: 'RO' }),
  },
  {
    row: '10a',
    path: 'edge L3 conflicts_with m1',
    run: route(
      (c) => c.post(`${P}/items/L3/edges`, { kind: 'conflicts_with', to: 'm1' }),
      () => mcp.relate({ from: 'L3', kind: 'conflicts_with', to: 'm1' }),
    ),
    expected: humans('WS', 'RO', 'FB', { MCP: 'RO' }),
  },
  ...(['refines', 'supports', 'depends_on'] as const).map((kind) => ({
    row: '11',
    path: `edge m1 → L3 ${kind} (MCP: spoor_relate m1→L3)`,
    run: route(
      (c) => c.post(`${P}/items/m1/edges`, { kind, to: 'L3' }),
      () => mcp.relate({ from: 'm1', kind, to: 'L3' }),
    ),
    expected: { IA: '201', PA: '201', LE: '201', LV: 'FB', ED: '201', VW: 'FB', MCP: 'ok' },
  })),
  {
    row: '11r',
    path: 'spoor_remember id=m1 relations supports L3',
    run: mcpOnly(() =>
      mcp.remember({
        id: 'm1',
        revision: 1,
        title: 'Session store',
        relations: [{ kind: 'supports', to: 'L3' }],
      }),
    ),
    expected: { MCP: 'ok' },
  },
  {
    row: '11a',
    path: 'edge m1 conflicts_with L3',
    run: route(
      (c) => c.post(`${P}/items/m1/edges`, { kind: 'conflicts_with', to: 'L3' }),
      () => mcp.relate({ from: 'm1', kind: 'conflicts_with', to: 'L3' }),
    ),
    expected: { IA: 'WS', PA: 'WS', LE: 'WS', LV: 'FB', ED: 'WS', VW: 'FB', MCP: 'WS' },
  },
  {
    row: '12',
    path: 'remove an edge whose source is L3 (MCP: spoor_relate remove=true)',
    run: async (a) => {
      const id = await seedEdge(s.L3, 'refines', s.L5)
      return route(
        (c) => c.delete(`${P}/edges/${id}`),
        () => mcp.relate({ from: 'L3', kind: 'refines', to: 'L5', remove: true }),
      )(a)
    },
    expected: humans('204', 'RO', 'FB', { MCP: 'RO' }),
  },
  {
    row: '13',
    path: 'remove the edge m1 → L3',
    run: async (a) => {
      const id = await seedEdge(s.m1, 'refines', s.L3)
      return route(
        (c) => c.delete(`${P}/edges/${id}`),
        () => mcp.relate({ from: 'm1', kind: 'refines', to: 'L3', remove: true }),
      )(a)
    },
    expected: { IA: '204', PA: '204', LE: '204', LV: 'FB', ED: '204', VW: 'FB', MCP: 'ok' },
  },
  {
    row: '14',
    path: 'POST review/bulk verify [L3]',
    run: async (a) =>
      bulkOutcome(
        await (await s.web(a as WebActor)).post(`${P}/review/bulk`, { action: 'verify', refs: ['L3'] }),
        'L3',
      ),
    expected: { IA: 'skipped:WS', PA: 'skipped:WS', LE: 'skipped:WS', LV: 'FB', ED: 'skipped:RO', VW: 'FB' },
  },
  {
    row: '15',
    path: 'POST review/bulk archive [L3]',
    run: async (a) =>
      bulkOutcome(
        await (await s.web(a as WebActor)).post(`${P}/review/bulk`, { action: 'archive', refs: ['L3'] }),
        'L3',
      ),
    expected: { IA: 'done', PA: 'done', LE: 'done', LV: 'FB', ED: 'skipped:RO', VW: 'FB' },
  },
  {
    row: '16',
    path: 'POST /p/acme/api/push with spoor_id = L3',
    run: async (a) =>
      outcome(
        await s.bearer(s.tokenSecret(a as 'UT' | 'LT' | 'ST'), '/push', {
          space: 'docs',
          source_path: 'docs/guide.md',
          content: `---\nspoor_id: ${s.L3.id}\n---\n# Guide\n\nOverwritten.\n`,
        }),
      ),
    // LT: the library right is web-only, so its holder's own token is refused too
    expected: { UT: 'RO', LT: 'RO', ST: 'RO' },
  },
  {
    row: '17',
    path: 'push cannot name the library space',
    run: async (a) =>
      outcome(
        await s.bearer(s.tokenSecret(a as 'UT' | 'LT' | 'ST'), '/push', {
          space: 'library',
          source_path: 'docs/guide.md',
          content: '# Guide\n',
        }),
      ),
    expected: { UT: 'II', LT: 'II', ST: 'II' },
  },
  {
    row: '23',
    path: 'reads: GET L3, the library list, its history (UT/ST: the bearer digest lists L3; MCP: get as an agent)',
    run: async (a) => {
      if (a === 'UT' || a === 'ST') {
        // the bearer surface has no item read; the digest is how a CLI token reads library pages
        const r = await s.bearerGet(s.tokenSecret(a), '/context?format=json')
        if (r.status !== 200) return outcome(r)
        const b = await json<{ items: string[] }>(r)
        return b.items.includes('L3') ? '200' : `200 without L3: ${b.items.join(',')}`
      }
      return route(
        async (c) => {
          for (const p of [`${P}/items/L3`, `${P}/spaces/library/items`, `${P}/items/L3/revisions`]) {
            const r = await c.get(p)
            if (r.status !== 200) return r
          }
          return new Response('{}', { status: 200 })
        },
        () =>
          s.items.get(
            { ctx: s.mcpX.auth, via: 'mcp', project: { id: s.acme.id, slug: 'acme', kind: 'project' } },
            'L3',
          ),
      )(a)
    },
    expected: { ...humans('200', '200', '200'), UT: '200', ST: '200', MCP: 'ok' },
  },
]

describe('library read-only matrix (ADR-0014)', () => {
  const cases = MATRIX.flatMap((r) =>
    Object.entries(r.expected).map(([actor, expected]) => ({ ...r, actor: actor as Actor, expected })),
  )
  it.each(cases)('$row $path · $actor → $expected', async ({ run, actor, expected }) => {
    expect(await run(actor)).toBe(expected)
  })

  it('a refused write leaves L3 as it was; an allowed one writes a human web revision', async () => {
    const ed = await s.web('ED')
    expect(await outcome(await ed.patch(`${P}/items/L3`, { revision: 1, title: 'Hijacked' }))).toBe('RO')
    await called(mcp.docWrite({ id: 'L3', revision: 1, title: 'Hijacked', body: 'x' }))
    const [row] = await db().select().from(items).where(eq(items.id, s.L3.id))
    expect(row).toMatchObject({ title: 'Guide', revision: 1 })
    const lv = await s.web('LV')
    expect(await outcome(await lv.patch(`${P}/items/L3`, { revision: 1, body: 'Fresh text.' }))).toBe('200')
    const revs = await db().select().from(itemRevisions).where(eq(itemRevisions.itemId, s.L3.id))
    expect(revs.map((r) => r.via).sort()).toEqual(['web', 'web'])
    const [after] = await db().select().from(items).where(eq(items.id, s.L3.id))
    expect(after).toMatchObject({ provenance: 'human', status: 'active', pinned: false })
  })

  it('library rules for an authorised human: pinned and a non-active status are invalid_input', async () => {
    const le = await s.web('LE')
    const pinned = await le.post(`${P}/spaces/library/items`, { title: 'Pinned page', pinned: true })
    expect(await json(pinned)).toMatchObject({
      error: 'invalid_input',
      details: { issues: [{ path: 'pinned' }] },
    })
    const typed = await le.post(`${P}/spaces/library/items`, { title: 'Typed page', type: 'fact' })
    expect(await outcome(typed)).toBe('II')
    const status = await le.patch(`${P}/items/L3`, { revision: 1, status: 'superseded' })
    expect(await outcome(status)).toBe('II')
    const created = await le.post(`${P}/spaces/library/items`, { title: 'A guide', slug: 'a-guide' })
    expect(await json(created)).toMatchObject({ item: { handle: 'L6', space: 'library', status: 'active' } })
  })

  it('library → non-library supports and depends_on are allowed for an authorised human', async () => {
    const le = await s.web('LE')
    for (const kind of ['supports', 'depends_on']) {
      expect(await outcome(await le.post(`${P}/items/L3/edges`, { kind, to: 'd2' }))).toBe('201')
    }
  })
})

describe('a viewer with the library flag (LV) writes library pages and nothing else', () => {
  const PATHS: { path: string; run: (c: Client) => Promise<Response> }[] = [
    {
      path: 'create a memory',
      run: (c) => c.post(`${P}/spaces/memories/items`, { title: 'A fact', type: 'fact' }),
    },
    { path: 'create a doc', run: (c) => c.post(`${P}/spaces/docs/items`, { title: 'A doc' }) },
    { path: 'edit m1', run: (c) => c.patch(`${P}/items/m1`, { revision: 1, title: 'Changed' }) },
    { path: 'edit d2', run: (c) => c.patch(`${P}/items/d2`, { revision: 1, title: 'Changed' }) },
    { path: 'pin m1', run: (c) => c.post(`${P}/items/m1/pin`, {}) },
    { path: 'unpin m1', run: (c) => c.post(`${P}/items/m1/unpin`, {}) },
    { path: 'verify m1', run: (c) => c.post(`${P}/items/m1/verify`, {}) },
    { path: 'archive m1', run: (c) => c.post(`${P}/items/m1/archive`, {}) },
    {
      path: 'restore m1',
      run: async (c) => {
        await archive(s.m1.id)
        return c.post(`${P}/items/m1/restore`, {})
      },
    },
    { path: 'supersede m1', run: (c) => c.post(`${P}/items/m1/supersede`, { new: { title: 'Newer fact' } }) },
    { path: 'supersede m1 by m4', run: (c) => c.post(`${P}/items/m1/supersede`, { new_id: 'm4' }) },
    { path: 'edge m1 → m4', run: (c) => c.post(`${P}/items/m1/edges`, { kind: 'refines', to: 'm4' }) },
    { path: 'edge m1 → L3', run: (c) => c.post(`${P}/items/m1/edges`, { kind: 'supports', to: 'L3' }) },
    {
      path: 'remove edge m1 → m4',
      run: async (c) => c.delete(`${P}/edges/${await seedEdge(s.m1, 'refines', s.m4)}`),
    },
    { path: 'delete m1', run: (c) => c.delete(`${P}/items/m1?confirm=m1`) },
    {
      path: 'review bulk verify',
      run: (c) => c.post(`${P}/review/bulk`, { action: 'verify', refs: ['m1'] }),
    },
    {
      path: 'review bulk archive',
      run: (c) => c.post(`${P}/review/bulk`, { action: 'archive', refs: ['m1'] }),
    },
  ]
  it.each(PATHS)('$path → forbidden', async ({ run }) => {
    expect(await outcome(await run(await s.web('LV')))).toBe('FB')
    const [m1] = await db().select().from(items).where(eq(items.id, s.m1.id))
    expect(m1).toMatchObject({ title: 'Session store', revision: 1, pinned: false })
  })
})

describe('library wikilinks: a human choice at save time, never captured or taken over', () => {
  const wiki = (srcId: string) =>
    db()
      .select({ dstRef: edges.dstRef, dstId: edges.dstId })
      .from(edges)
      .where(and(eq(edges.srcId, srcId), eq(edges.kind, 'wikilink')))
      .orderBy(edges.dstRef)

  it('[[some-doc]] and [[m1]] resolve; a missing slug stays dangling and is claimed only by a library page', async () => {
    const le = await s.web('LE')
    const body = 'See [[some-doc]], [[m1]], [[L5]] and [[missing-page]].'
    expect(await outcome(await le.patch(`${P}/items/L3`, { revision: 1, body }))).toBe('200')
    expect(await wiki(s.L3.id)).toEqual([
      { dstRef: 'l5', dstId: s.L5.id },
      { dstRef: 'm1', dstId: s.m1.id },
      { dstRef: 'missing-page', dstId: null },
      { dstRef: 'some-doc', dstId: s.d2.id },
    ])
    // an agent's memory with that slug does not capture the link
    expect(await called(mcp.remember({ title: 'Missing page', type: 'fact', allow_duplicate: true }))).toBe(
      'ok',
    )
    const agentRows = await db()
      .select({ slug: items.slug })
      .from(items)
      .where(and(eq(items.projectId, s.acme.id), eq(items.space, 'memories'), eq(items.slug, 'missing-page')))
    expect(agentRows).toHaveLength(1)
    // nor does a human's doc with it
    const ed = await s.web('ED')
    expect(
      await outcome(await ed.post(`${P}/spaces/docs/items`, { title: 'Missing', slug: 'missing-page' })),
    ).toBe('201')
    expect((await wiki(s.L3.id)).find((e) => e.dstRef === 'missing-page')?.dstId).toBeNull()
    // a new library page claims it
    const r = await le.post(`${P}/spaces/library/items`, { title: 'Missing page', slug: 'missing-page' })
    const page = (await json<{ item: { id: string } }>(r)).item
    expect((await wiki(s.L3.id)).find((e) => e.dstRef === 'missing-page')?.dstId).toBe(page.id)
  })

  it('a resolved library link is not taken over by a later same-slug item (a doc link is)', async () => {
    const le = await s.web('LE')
    const ed = await s.web('ED')
    expect(
      await outcome(await le.patch(`${P}/items/L3`, { revision: 1, body: 'Read [[session-store]].' })),
    ).toBe('200')
    // control: a doc's link to the memory slug, which a later doc with that slug takes over
    const d = await ed.post(`${P}/spaces/docs/items`, { title: 'Ops', body: 'Read [[session-store]].' })
    const ops = (await json<{ item: { id: string } }>(d)).item
    expect((await wiki(ops.id))[0]?.dstId).toBe(s.m1.id)
    const twin = await ed.post(`${P}/spaces/docs/items`, {
      title: 'Session store doc',
      slug: 'session-store',
    })
    const twinId = (await json<{ item: { id: string } }>(twin)).item.id
    expect((await wiki(ops.id))[0]?.dstId).toBe(twinId)
    expect(await wiki(s.L3.id)).toEqual([{ dstRef: 'session-store', dstId: s.m1.id }])
  })

  describe('a human re-save keeps the links the page already has (no slug-twin redirect)', () => {
    const link = async (ref: string) => (await wiki(s.L3.id)).find((e) => e.dstRef === ref)?.dstId
    const itemId = async (space: 'docs' | 'library', slug: string) => {
      const [row] = await db()
        .select({ id: items.id, number: items.number })
        .from(items)
        .where(and(eq(items.projectId, s.acme.id), eq(items.space, space), eq(items.slug, slug)))
      return row as { id: string; number: number }
    }
    /** L3 links [[session-store]] (m1) and [[missing-page]] (dangling); an agent then makes doc twins. */
    const setup = async () => {
      const le = await s.web('LE')
      const body = 'Read [[session-store]] and [[missing-page]].'
      expect(await outcome(await le.patch(`${P}/items/L3`, { revision: 1, body }))).toBe('200')
      expect(await wiki(s.L3.id)).toEqual([
        { dstRef: 'missing-page', dstId: null },
        { dstRef: 'session-store', dstId: s.m1.id },
      ])
      for (const slug of ['session-store', 'missing-page']) {
        expect(await called(mcp.docWrite({ title: `Twin ${slug}`, slug, body: 'Agent text.' }))).toBe('ok')
      }
      return le
    }

    it('(a) a title-only PATCH keeps session-store on m1 and missing-page dangling', async () => {
      const le = await setup()
      expect(await outcome(await le.patch(`${P}/items/L3`, { revision: 2, title: 'Guide v2' }))).toBe('200')
      expect(await wiki(s.L3.id)).toEqual([
        { dstRef: 'missing-page', dstId: null },
        { dstRef: 'session-store', dstId: s.m1.id },
      ])
    })

    it('(b) a library page claims the dangling link and a later re-save keeps it', async () => {
      const le = await setup()
      const r = await le.post(`${P}/spaces/library/items`, { title: 'Missing page', slug: 'missing-page' })
      const page = (await json<{ item: { id: string } }>(r)).item
      expect(await link('missing-page')).toBe(page.id)
      expect(await outcome(await le.patch(`${P}/items/L3`, { revision: 2, title: 'Guide v2' }))).toBe('200')
      expect(await link('missing-page')).toBe(page.id)
      expect(await link('session-store')).toBe(s.m1.id)
    })

    it('(b2) a stored dangling link is filled at re-save only by a library page', async () => {
      const le = await setup()
      // a library page that never claimed (written straight to the table): the re-save fills the link
      const page = await createItem(db(), {
        projectId: s.acme.id,
        space: 'library',
        slug: 'missing-page',
        title: 'Missing page',
      })
      expect(await link('missing-page')).toBeNull()
      expect(await outcome(await le.patch(`${P}/items/L3`, { revision: 2, title: 'Guide v2' }))).toBe('200')
      expect(await link('missing-page')).toBe(page.id)
    })

    it('(c) a ref new in this save resolves normally, to the agent doc', async () => {
      const le = await setup()
      expect(await called(mcp.docWrite({ title: 'New doc', slug: 'new-doc', body: 'Agent text.' }))).toBe(
        'ok',
      )
      const body = 'Read [[session-store]], [[missing-page]] and [[new-doc]].'
      expect(await outcome(await le.patch(`${P}/items/L3`, { revision: 2, body }))).toBe('200')
      expect(await wiki(s.L3.id)).toEqual([
        { dstRef: 'missing-page', dstId: null },
        { dstRef: 'new-doc', dstId: (await itemId('docs', 'new-doc')).id },
        { dstRef: 'session-store', dstId: s.m1.id },
      ])
    })

    it("(d) changing [[session-store]] to the twin's handle repoints the link", async () => {
      const le = await setup()
      const twin = await itemId('docs', 'session-store')
      const body = `Read [[d${twin.number}]] and [[missing-page]].`
      expect(await outcome(await le.patch(`${P}/items/L3`, { revision: 2, body }))).toBe('200')
      expect(await wiki(s.L3.id)).toEqual([
        { dstRef: `d${twin.number}`, dstId: twin.id },
        { dstRef: 'missing-page', dstId: null },
      ])
    })
  })
})

describe('the shared library (S:L<n>)', () => {
  it('IA and shared editors write it; others are refused; agents never write it', async () => {
    const se = await loginAs(s.app, s.se.email, s.se.password)
    const r = await se.post(`${SH}/spaces/library/items`, { title: 'Org guide', slug: 'org-guide' })
    expect(r.status).toBe(201)
    expect((await json<{ item: { handle: string } }>(r)).item.handle).toBe('L1')
    expect(await outcome(await se.patch(`${SH}/items/L1`, { revision: 1, title: 'Org guide 2' }))).toBe('200')
    const le = await s.web('LE')
    expect(await outcome(await le.post(`${SH}/spaces/library/items`, { title: 'Nope' }))).toBe('FB')
    expect(await outcome(await le.patch(`${SH}/items/L1`, { revision: 2, title: 'Nope' }))).toBe('FB')
    // from a project: S:L1 is a read and an edge target, never a write position
    const ed = await s.web('ED')
    expect((await json<{ handle: string }>(await ed.get(`${P}/items/S:L1`))).handle).toBe('S:L1')
    expect(await outcome(await ed.post(`${P}/items/m1/edges`, { kind: 'refines', to: 'S:L1' }))).toBe('201')
    expect(await outcome(await ed.patch(`${P}/items/S:L1`, { revision: 2, title: 'x' }))).toBe('RO')
    expect(await called(mcp.relate({ from: 'S:L1', kind: 'refines', to: 'm1' }))).toBe('RO')
    expect(await called(mcp.docWrite({ id: 'S:L1', revision: 2, title: 'x', body: 'y' }))).toBe('RO')
    const second = await se.post(`${SH}/spaces/library/items`, {
      title: 'Second guide',
      slug: 'second-guide',
    })
    expect((await json<{ item: { handle: string } }>(second)).item.handle).toBe('L2')
    expect(await outcome(await le.delete(`${SH}/items/L2?confirm=L2`))).toBe('FB')
    expect(await outcome(await se.delete(`${SH}/items/L2?confirm=L2`))).toBe('204')
    const ia = await s.web('IA')
    expect(await outcome(await ia.delete(`${SH}/items/L1?confirm=L1`))).toBe('204')
  })
})

describe('the database guards answer as API errors', () => {
  it('SPL01 (library conflicts_with doc) is wrong_space; SPL02 (an agent revision) is read_only_space', async () => {
    const edgeErr = await db()
      .insert(edges)
      .values({
        projectId: s.acme.id,
        srcId: s.L3.id,
        kind: 'conflicts_with',
        dstRef: s.d2.id,
        dstId: s.d2.id,
      })
      .catch((e: unknown) => e)
    expect(pgError(edgeErr)?.code).toBe('SPL01')
    expect(() => mapEdgeError(edgeErr)).toThrow(expect.objectContaining({ code: 'wrong_space' }))
    const revErr = await db()
      .insert(itemRevisions)
      .values({
        itemId: s.L3.id,
        revision: 2,
        title: 'x',
        body: '',
        status: 'active',
        frontmatter: {},
        change: 'update',
        actorLabel: 'agent',
        via: 'mcp',
      })
      .catch((e: unknown) => e)
    expect(pgError(revErr)?.code).toBe('SPL02')
    expect(libraryGuardError(revErr)).toMatchObject({ code: 'read_only_space' })
  })
})

// ---- rows 18-20d: import, membership and the computed right ---------------------------------------------

/** A multipart archive upload with the client's session cookie (the Client sends JSON only). */
async function upload(c: Client, path: string, zip: Uint8Array, fields: Record<string, string> = {}) {
  const form = new FormData()
  form.set('file', new File([zip as Uint8Array<ArrayBuffer>], 'archive.zip', { type: 'application/zip' }))
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  const headers: Record<string, string> = { origin: TEST_ORIGIN }
  const cookie = c.cookieHeader()
  if (cookie) headers.cookie = cookie
  return s.app.request(`${TEST_ORIGIN}${path}`, { method: 'POST', headers, body: form })
}

/** A folder archive with one library page that asks to be pinned (normalised away on import). */
const folderZip = () =>
  writeZip(
    { 'library/house-rules.md': strToU8('---\npinned: true\n---\n# House rules\n\nBe kind.\n') },
    new Date(),
  )

describe('library import and membership rows (matrix 18-20d)', () => {
  // Rows 18 and 19: the FB cells are the generic admin-only import gate (it refuses before the archive is
  // read), so they are authorisation rows, not library rules. The admin cells check that a library page is
  // normalised on import; the library edge and claim rules of an import are unit-tested in
  // transfer/import.test.ts.
  it.each(WEB.map((a) => ({ actor: a, ok: a === 'IA' || a === 'PA' })))(
    '18 POST projects/acme/import with library/ (authorisation: admin-only import gate) · $actor',
    async ({ actor, ok }) => {
      const r = await upload(await s.web(actor), `${P}/import`, folderZip())
      if (!ok) {
        expect(await outcome(r)).toBe('FB')
        return
      }
      expect(r.status).toBe(200)
      expect((await json<{ notes: string[] }>(r)).notes).toContain(
        'library/house-rules.md: library page normalised (unpinned).',
      )
      const [row] = await db()
        .select()
        .from(items)
        .where(and(eq(items.projectId, s.acme.id), eq(items.slug, 'house-rules')))
      expect(row).toMatchObject({ space: 'library', pinned: false, provenance: 'human', lifecycle: 'active' })
    },
  )

  it.each(WEB.map((a) => ({ actor: a, ok: a === 'IA' })))(
    '19 POST projects/import (new project) with library/ (authorisation: instance-admin only) · $actor',
    async ({ actor, ok }) => {
      const zip = new Uint8Array(await (await (await s.web('IA')).get(`${P}/export`)).arrayBuffer())
      const r = await upload(await s.web(actor), '/api/v1/projects/import', zip, {
        slug: `copy-${actor.toLowerCase()}`,
        remap_ids: 'true',
      })
      if (!ok) {
        expect(await outcome(r)).toBe('FB')
        return
      }
      expect(r.status).toBe(200) // the import routes answer 200 (api.md section 9)
      const [p] = await db().select().from(projects).where(eq(projects.slug, 'copy-ia'))
      const lib = await db()
        .select({ slug: items.slug })
        .from(items)
        .where(and(eq(items.projectId, (p as { id: string }).id), eq(items.space, 'library')))
      expect(lib.map((x) => x.slug).sort()).toEqual(['guide', 'style'])
    },
  )

  const member = (path = '') => `${P}/members${path}`
  it.each(WEB.map((a) => ({ actor: a, ok: a === 'IA' || a === 'PA' })))(
    '20 / 20a PUT and POST members with library_editor · $actor',
    async ({ actor, ok }) => {
      const c = await s.web(actor)
      const put = await c.request('PUT', member(`/${s.users.ED.id}`), { body: { library_editor: true } })
      const fresh = await createUser(db())
      const post = await c.post(member(), { email: fresh.email, role: 'viewer', library_editor: true })
      if (!ok) {
        expect([await outcome(put), await outcome(post)]).toEqual(['FB', 'FB'])
        return
      }
      expect(put.status).toBe(200)
      expect(await json(put)).toMatchObject({ role: 'editor', library_editor: true })
      expect(post.status).toBe(201)
      expect(await json(post)).toMatchObject({ role: 'viewer', library_editor: true })
    },
  )

  it('20b demoting an admin clears the flag unless the body sets it; the computed right follows', async () => {
    const pa = await s.web('PA')
    const other = await createUser(db())
    await addMember(db(), s.acme.id, other.id, 'admin')
    const oc = await loginAs(s.app, other.email, other.password)
    const right = async () => (await json<{ can_edit_library: boolean }>(await oc.get(P))).can_edit_library
    expect(await right()).toBe(true)
    const down = await pa.request('PUT', member(`/${other.id}`), { body: { role: 'editor' } })
    expect(await json(down)).toMatchObject({ role: 'editor', library_editor: false })
    expect(await right()).toBe(false)
    expect(await outcome(await oc.patch(`${P}/items/L3`, { revision: 1, title: 'x' }))).toBe('RO')
    await pa.request('PUT', member(`/${other.id}`), { body: { role: 'admin' } })
    const kept = await pa.request('PUT', member(`/${other.id}`), {
      body: { role: 'editor', library_editor: true },
    })
    expect(await json(kept)).toMatchObject({ role: 'editor', library_editor: true })
    expect(await right()).toBe(true)
  })

  it.each(['LE', 'LV', 'ED', 'VW'] as const)(
    '20c self-leave removes the row and the flag · %s',
    async (actor) => {
      const c = await s.web(actor)
      expect((await c.delete(member(`/${s.users[actor].id}`))).status).toBe(204)
      const rows = await db()
        .select()
        .from(memberships)
        .where(and(eq(memberships.projectId, s.acme.id), eq(memberships.userId, s.users[actor].id)))
      expect(rows).toEqual([])
    },
  )

  it.each(['IA', 'PA'] as const)(
    '20c an admin DELETEs a flagged member: the row and the flag go · %s',
    async (actor) => {
      const c = await s.web(actor)
      expect((await c.delete(member(`/${s.users.LE.id}`))).status).toBe(204)
      const rows = await db()
        .select()
        .from(memberships)
        .where(and(eq(memberships.projectId, s.acme.id), eq(memberships.userId, s.users.LE.id)))
      expect(rows).toEqual([])
      const le = await s.web('LE')
      expect(await outcome(await le.patch(`${P}/items/L3`, { revision: 1, title: 'Gone' }))).toBe(
        '404 not_found',
      )
      const [l3] = await db().select().from(items).where(eq(items.id, s.L3.id))
      expect(l3).toMatchObject({ title: 'Guide', revision: 1 })
    },
  )

  it('20d an invite accepted with role admin stores the flag false; the right comes from the role', async () => {
    const ia = await s.web('IA')
    const inv = await json<{ token: string }>(
      await ia.post('/api/v1/invites', { grants: [{ project: 'acme', role: 'admin' }] }),
    )
    const guest = new Client(s.app)
    const res = await guest.post('/api/v1/invites/accept', {
      token: inv.token,
      name: 'New admin',
      email: 'new-admin@example.com',
      password: 'a fresh passphrase',
    })
    expect(res.status).toBe(201)
    const { user } = await json<{ user: { id: string } }>(res)
    const [row] = await db()
      .select()
      .from(memberships)
      .where(and(eq(memberships.projectId, s.acme.id), eq(memberships.userId, user.id)))
    expect(row).toMatchObject({ role: 'admin', libraryEditor: false })
    expect(await json(await guest.get(P))).toMatchObject({ can_edit_library: true })
  })

  it('ProjectJson.can_edit_library per actor; member routes on _shared are 404', async () => {
    const got: Record<string, boolean> = {}
    for (const a of WEB)
      got[a] = (await json<{ can_edit_library: boolean }>(await (await s.web(a)).get(P))).can_edit_library
    expect(got).toEqual({ IA: true, PA: true, LE: true, LV: true, ED: false, VW: false })
    const se = await loginAs(s.app, s.se.email, s.se.password)
    expect((await json<{ can_edit_library: boolean }>(await se.get(SH))).can_edit_library).toBe(true)
    const le = await s.web('LE')
    expect((await json<{ can_edit_library: boolean }>(await le.get(SH))).can_edit_library).toBe(false)
    const ia = await s.web('IA')
    expect((await ia.get(`${SH}/members`)).status).toBe(404)
    expect(
      (await ia.request('PUT', `${SH}/members/${s.se.id}`, { body: { library_editor: true } })).status,
    ).toBe(404)
  })
})
