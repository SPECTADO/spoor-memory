// The CLI's bearer endpoints (api.md 7.2, 7.3; data-model.md 7; deviation I23): GET activity,
// GET decisions/undrafted, POST adr/import, POST adr/push and docs/push (the per-space forms of POST push),
// with the abuse cases: wrong project, viewer tokens, revoked tokens, traversal in source_path.
import { eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { cliSurfaceApp } from '../../../test/cli-surface-app.js'
import { testDb } from '../../../test/db.js'
import {
  addMember,
  createItem,
  createProject,
  createSharedProject,
  createToken,
  createUser,
  DEFAULT_PASSWORD,
} from '../../../test/factories.js'
import { Client, json, loginAs } from '../../../test/http.js'
import { auditLog, items, tokens } from '../../db/schema.js'

const db = () => testDb()
type Body = Record<string, unknown> & {
  error?: string
  details?: Record<string, unknown>
  warnings?: { code: string; [k: string]: unknown }[]
}

async function seed() {
  const { app } = cliSurfaceApp()
  await createSharedProject(db())
  const acme = await createProject(db(), { slug: 'acme' })
  const other = await createProject(db(), { slug: 'other' })
  const dev = await createUser(db())
  const viewer = await createUser(db())
  await addMember(db(), acme.id, dev.id, 'editor')
  await addMember(db(), acme.id, viewer.id, 'viewer')
  await addMember(db(), other.id, dev.id, 'editor')
  const tok = await createToken(db(), { projectId: acme.id, userId: dev.id })
  const tok2 = await createToken(db(), { projectId: acme.id, userId: dev.id })
  const roTok = await createToken(db(), { projectId: acme.id, userId: viewer.id })
  const otherTok = await createToken(db(), { projectId: other.id, userId: dev.id })
  const svc = await createToken(db(), { projectId: acme.id, kind: 'service', role: 'editor', name: 'ci' })
  const cli = new Client(app)
  const call = (method: 'GET' | 'POST', path: string, body?: unknown, secret: string | null = tok.secret) =>
    cli.request(method, `/p/acme/api${path}`, {
      body,
      origin: null,
      headers: {
        ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
        'user-agent': 'spoor-cli/0.1.0',
      },
    })
  return { app, acme, other, dev, viewer, tok, tok2, roTok, otherTok, svc, call, cli }
}

let s: Awaited<ReturnType<typeof seed>>
beforeEach(async () => {
  s = await seed()
})

const writes = async (secret: string, since?: string) => {
  const r = await s.call(
    'GET',
    `/activity${since ? `?since=${encodeURIComponent(since)}` : ''}`,
    undefined,
    secret,
  )
  expect(r.status).toBe(200)
  return (await json<{ writes: number }>(r)).writes
}
/** An audit row as the MCP module writes it (same table, `via='mcp'`, the token's id). */
const mcpRow = (tokenId: string, action: string, at = sql`now()`) =>
  db().insert(auditLog).values({
    projectId: s.acme.id,
    actorUserId: s.dev.id,
    actorLabel: s.dev.email,
    tokenId,
    via: 'mcp',
    clientName: 'claude-code/2.1.303',
    action,
    summary: 'test',
    at,
  })

describe('GET /p/:slug/api/activity', () => {
  it('counts this token’s content and edge writes via mcp and cli, nothing else', async () => {
    expect(await writes(s.tok.secret)).toBe(0)
    const r = await s.call('POST', '/push', { space: 'docs', source_path: 'docs/a.md', content: '# A' })
    expect(r.status).toBe(200)
    expect(await writes(s.tok.secret)).toBe(1)
    await mcpRow(s.tok.id, 'item.create')
    await mcpRow(s.tok.id, 'edge.add')
    await mcpRow(s.tok.id, 'item.verify')
    expect(await writes(s.tok.secret)).toBe(4)
    // not counted: reads/refusals, other tokens, older than the default window, web edits
    await mcpRow(s.tok.id, 'item.dedupe_hit')
    await mcpRow(s.tok.id, 'item.push_rejected')
    await mcpRow(s.tok2.id, 'item.create')
    await mcpRow(s.tok.id, 'item.create', sql`now() - interval '7 hours'`)
    expect(await writes(s.tok.secret)).toBe(4)
    expect(await writes(s.tok2.secret)).toBe(1)
    const web = await loginAs(s.app, s.dev.email, DEFAULT_PASSWORD)
    const created = await web.post('/api/v1/projects/acme/spaces/memories/items', {
      title: 'web fact',
      type: 'fact',
    })
    expect(created.status).toBe(201)
    expect(await writes(s.tok.secret)).toBe(4)
  })

  it('does not count the CLI’s own automatic pushes (client name ending in " (auto)", review-log-phase5 A3)', async () => {
    const auto = await s.cli.request('POST', '/p/acme/api/push', {
      body: { space: 'docs', source_path: 'docs/auto.md', content: '# Auto' },
      origin: null,
      headers: { authorization: `Bearer ${s.tok.secret}`, 'user-agent': 'spoor-cli/0.1.0 (auto)' },
    })
    expect(auto.status).toBe(200)
    const [row] = await db().select().from(auditLog).where(eq(auditLog.action, 'item.push'))
    expect(row?.clientName).toBe('spoor-cli/0.1.0 (auto)')
    expect(await writes(s.tok.secret)).toBe(0)
    // an agent-initiated push (PostToolUse after an Edit) still counts
    await s.call('POST', '/push', { space: 'docs', source_path: 'docs/b.md', content: '# B' })
    expect(await writes(s.tok.secret)).toBe(1)
  })

  it('honours since (inclusive window), and is readable by any role and by service tokens', async () => {
    await mcpRow(s.tok.id, 'item.create', sql`now() - interval '2 days'`)
    expect(await writes(s.tok.secret)).toBe(0)
    expect(await writes(s.tok.secret, new Date(Date.now() - 3 * 86_400_000).toISOString())).toBe(1)
    expect(await writes(s.tok.secret, new Date(Date.now() + 60_000).toISOString())).toBe(0)
    expect(await writes(s.roTok.secret)).toBe(0)
    await mcpRow(s.svc.id, 'item.update')
    expect(await writes(s.svc.secret)).toBe(1)
  })

  it('validates since and refuses foreign, revoked and missing tokens', async () => {
    expect((await s.call('GET', '/activity?since=yesterday')).status).toBe(400)
    expect((await s.call('GET', '/activity?since=2026-10-19T00:00:00Z&x=1')).status).toBe(400)
    const foreign = await s.call('GET', '/activity', undefined, s.otherTok.secret)
    expect(foreign.status).toBe(403)
    expect((await json<Body>(foreign)).error).toBe('token_project_mismatch')
    const none = await s.call('GET', '/activity', undefined, null)
    expect(none.status).toBe(401)
    expect(none.headers.get('www-authenticate')).toBe('Bearer realm="spoor"')
    await db().update(tokens).set({ revokedAt: sql`now()` }).where(eq(tokens.id, s.tok2.id))
    expect((await s.call('GET', '/activity', undefined, s.tok2.secret)).status).toBe(401)
    // a member removed from the project: the token stops working at once
    const gone = await createUser(db())
    await addMember(db(), s.acme.id, gone.id, 'editor')
    const goneTok = await createToken(db(), { projectId: s.acme.id, userId: gone.id })
    expect((await s.call('GET', '/activity', undefined, goneTok.secret)).status).toBe(200)
    await db().execute(sql`DELETE FROM memberships WHERE user_id = ${gone.id}`)
    expect((await s.call('GET', '/activity', undefined, goneTok.secret)).status).toBe(401)
  })
})

const ADR = (n: number, title: string, extra = '') =>
  `---\nadr: ${n}\nstatus: accepted\n${extra}---\n# ADR-${String(n).padStart(4, '0')}: ${title}\n\n## Context\n\n${title}.\n`

describe('POST /p/:slug/api/adr/push and docs/push', () => {
  it('create, write-back data, fast-forward, unchanged', async () => {
    const r = await s.call('POST', '/adr/push', {
      source_path: 'docs/adr/0007-use-postgres.md',
      content: ADR(7, 'Use Postgres'),
    })
    expect(r.status).toBe(200)
    const b = await json<Body>(r)
    expect(b).toMatchObject({
      status: 'created',
      handle: 'ADR-0007',
      space: 'decisions',
      revision: 1,
      adr_number: 7,
      renumbered: null,
      source_path: 'docs/adr/0007-use-postgres.md',
    })
    expect(b.spoor_id).toMatch(/^[0-9a-f-]{36}$/)
    const again = await s.call('POST', '/adr/push', {
      source_path: 'docs/adr/0007-use-postgres.md',
      content: ADR(7, 'Use Postgres'),
    })
    expect((await json<Body>(again)).status).toBe('unchanged')
    const upd = await s.call('POST', '/adr/push', {
      source_path: 'docs/adr/0007-use-postgres.md',
      content: ADR(7, 'Use Postgres 17'),
      base_revision: 1,
    })
    expect(await json<Body>(upd)).toMatchObject({ status: 'updated', revision: 2, spoor_id: b.spoor_id })

    const d = await s.call('POST', '/docs/push', {
      source_path: 'ARCHITECTURE.md',
      content: '# Architecture\n',
    })
    const doc = await json<Body>(d)
    expect(doc).toMatchObject({ status: 'created', space: 'docs', adr_number: null })
    expect(doc.handle).toMatch(/^d\d+$/)
  })

  it('a Spoor edit makes the push a 409 (push_conflict_at set); --force writes and is audited', async () => {
    const created = await json<Body>(
      await s.call('POST', '/adr/push', { source_path: 'docs/adr/0003-x.md', content: ADR(3, 'X') }),
    )
    const web = await loginAs(s.app, s.dev.email, DEFAULT_PASSWORD)
    const edit = await web.patch('/api/v1/projects/acme/items/ADR-0003', {
      revision: 1,
      body: 'edited in Spoor',
    })
    expect(edit.status).toBe(200)
    const r = await s.call('POST', '/adr/push', {
      source_path: 'docs/adr/0003-x.md',
      content: ADR(3, 'X2'),
      base_revision: 1,
    })
    expect(r.status).toBe(409)
    const c = await json<Body>(r)
    expect(c.error).toBe('pushed_over_spoor_edit')
    expect(c.details).toEqual({ current_revision: 2, edited_by: s.dev.email, via: 'web' })
    const [row] = await db()
      .select()
      .from(items)
      .where(eq(items.id, created.spoor_id as string))
    expect(row?.pushConflictAt).not.toBeNull()
    expect(row?.revision).toBe(2)
    const forced = await s.call('POST', '/adr/push', {
      source_path: 'docs/adr/0003-x.md',
      content: ADR(3, 'X2'),
      base_revision: 1,
      force: true,
    })
    expect(await json<Body>(forced)).toMatchObject({ status: 'updated', revision: 3 })
    const [after] = await db()
      .select()
      .from(items)
      .where(eq(items.id, created.spoor_id as string))
    expect(after?.pushConflictAt).toBeNull()
    const pushes = await db().select().from(auditLog).where(eq(auditLog.action, 'item.push'))
    expect(pushes.some((a) => (a.data as Record<string, unknown>).forced === true && a.via === 'cli')).toBe(
      true,
    )
    expect((await db().select().from(auditLog).where(eq(auditLog.action, 'item.push_rejected'))).length).toBe(
      1,
    )
  })

  it('renumbers a true collision and refuses to apply a ref to the moved number (ambiguous_ref)', async () => {
    await s.call('POST', '/adr/push', { source_path: 'docs/adr/0001-first.md', content: ADR(1, 'First') })
    const clash = await json<Body>(
      await s.call('POST', '/adr/push', { source_path: 'docs/adr/0001-clash.md', content: ADR(1, 'Clash') }),
    )
    expect(clash).toMatchObject({
      status: 'created',
      renumbered: { from: 1, to: 2 },
      adr_number: 2,
      handle: 'ADR-0002',
    })
    const ref = await json<Body>(
      await s.call('POST', '/adr/push', {
        source_path: 'docs/adr/0003-later.md',
        content: ADR(3, 'Later', 'supersedes: ADR-0001\n'),
      }),
    )
    expect(ref.status).toBe('created')
    expect(ref.warnings).toContainEqual({
      code: 'ambiguous_ref',
      ref: 'ADR-0001',
      candidates: ['ADR-0001', 'ADR-0002'],
    })
    // nothing was superseded
    const sup = await db().select().from(items).where(eq(items.status, 'superseded'))
    expect(sup).toHaveLength(0)
  })

  it('refuses traversal and absolute source paths; nothing is written', async () => {
    for (const p of [
      '../outside.md',
      'docs/../../outside.md',
      '..\\outside.md',
      'docs\\..\\..\\outside.md',
      '/etc/passwd',
      '\\\\server\\share\\x.md',
      'C:\\Users\\ann\\x.md',
      'c:/x.md',
      '~/x.md',
      'docs/a\u0000.md',
      'docs/',
      '.',
    ]) {
      for (const route of ['/adr/push', '/docs/push']) {
        const r = await s.call('POST', route, { source_path: p, content: '# X' })
        expect(r.status, `${route} ${JSON.stringify(p)}`).toBe(400)
        expect((await json<Body>(r)).error).toBe('invalid_input')
      }
      const imp = await json<{ results: Body[] }>(
        await s.call('POST', '/adr/import', { files: [{ source_path: p, content: '# X' }] }),
      )
      expect(imp.results[0]?.error, JSON.stringify(p)).toBe('invalid_input')
    }
    expect(await db().select().from(items)).toHaveLength(0)
    // a dotted name that stays inside the repo is fine
    const ok = await s.call('POST', '/docs/push', { source_path: './docs/..notes.md', content: '# Notes' })
    expect(await json<Body>(ok)).toMatchObject({ status: 'created', source_path: 'docs/..notes.md' })
  })

  it('bearer rules: viewer → forbidden_role, foreign token → mismatch, strict bodies, wrong space', async () => {
    const ro = await s.call('POST', '/docs/push', { source_path: 'a.md', content: '# A' }, s.roTok.secret)
    expect(ro.status).toBe(403)
    expect((await json<Body>(ro)).error).toBe('forbidden_role')
    const foreign = await s.call(
      'POST',
      '/adr/push',
      { source_path: 'a.md', content: '# A' },
      s.otherTok.secret,
    )
    expect((await json<Body>(foreign)).error).toBe('token_project_mismatch')
    expect(
      (await s.call('POST', '/adr/push', { space: 'docs', source_path: 'a.md', content: '# A' })).status,
    ).toBe(400)
    expect((await s.call('POST', '/adr/push', { source_path: 'a.md' })).status).toBe(400)
    await s.call('POST', '/adr/push', { source_path: 'docs/adr/0001-a.md', content: ADR(1, 'A') })
    const wrong = await s.call('POST', '/docs/push', { source_path: 'docs/adr/0001-a.md', content: '# A' })
    expect(wrong.status).toBe(400)
    expect((await json<Body>(wrong)).error).toBe('wrong_space')
    expect(await db().select().from(items)).toHaveLength(1)
  })

  it('a service token with the editor role may push; its writes carry via=cli and the user agent', async () => {
    const r = await s.call(
      'POST',
      '/docs/push',
      { source_path: 'GLOSSARY.md', content: '# Glossary' },
      s.svc.secret,
    )
    expect(r.status).toBe(200)
    const [a] = await db().select().from(auditLog).where(eq(auditLog.action, 'item.push'))
    expect(a).toMatchObject({
      via: 'cli',
      clientName: 'spoor-cli/0.1.0',
      tokenId: s.svc.id,
      actorLabel: 'service:ci',
    })
  })
})

describe('POST /p/:slug/api/adr/import', () => {
  it('a bad file does not fail the batch; numbers above reserve_above; results in request order', async () => {
    await s.call('POST', '/adr/push', { source_path: 'docs/adr/0002-held.md', content: ADR(2, 'Held') })
    const r = await s.call('POST', '/adr/import', {
      files: [
        { source_path: 'docs/adr/0002-mine.md', content: ADR(2, 'Mine') },
        { source_path: '../evil.md', content: '# Evil' },
        { source_path: 'docs/adr/0001-one.md', content: ADR(1, 'One') },
      ],
      reserve_above: 5,
    })
    expect(r.status).toBe(200)
    const { results } = await json<{ results: Body[] }>(r)
    expect(results.map((x) => x.source_path)).toEqual([
      'docs/adr/0002-mine.md',
      '../evil.md',
      'docs/adr/0001-one.md',
    ])
    expect(results[0]).toMatchObject({ status: 'created', renumbered: { from: 2, to: 6 } })
    expect(results[1]?.error).toBe('invalid_input')
    expect(results[2]).toMatchObject({ status: 'created', adr_number: 1, renumbered: null })
  })

  it('caps the batch and refuses viewers', async () => {
    const files = Array.from({ length: 101 }, (_, i) => ({
      source_path: `docs/adr/${i}-x.md`,
      content: '# X',
    }))
    expect((await s.call('POST', '/adr/import', { files })).status).toBe(400)
    const ro = await s.call('POST', '/adr/import', { files: files.slice(0, 1) }, s.roTok.secret)
    expect((await json<Body>(ro)).error).toBe('forbidden_role')
  })
})

describe('GET /p/:slug/api/decisions/undrafted', () => {
  it('lists the owner’s undrafted decision memories until an ADR is drafted from one', async () => {
    const mem = await createItem(db(), {
      projectId: s.acme.id,
      type: 'decision',
      title: 'Use RRF',
      createdBy: s.dev.id,
    })
    await createItem(db(), { projectId: s.acme.id, type: 'fact', title: 'a fact', createdBy: s.dev.id })
    await createItem(db(), {
      projectId: s.acme.id,
      type: 'decision',
      title: 'theirs',
      createdBy: s.viewer.id,
    })
    await createItem(db(), {
      projectId: s.other.id,
      type: 'decision',
      title: 'other project',
      createdBy: s.dev.id,
    })
    const list = async (q = '', secret = s.tok.secret) => {
      const r = await s.call('GET', `/decisions/undrafted${q}`, undefined, secret)
      expect(r.status).toBe(200)
      return (await json<{ items: { handle: string; title: string }[] }>(r)).items
    }
    expect((await list()).map((i) => i.title)).toEqual(['Use RRF'])
    expect((await list('?mine=false')).map((i) => i.title).sort()).toEqual(['Use RRF', 'theirs'])
    expect(await list(`?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).toEqual(
      [],
    )
    expect((await list('', s.roTok.secret)).map((i) => i.title)).toEqual(['theirs'])
    const handle = `m${mem.number}`
    const adr = await s.call('POST', '/adr/push', {
      source_path: 'docs/adr/0001-use-rrf.md',
      content: ADR(1, 'Use RRF', `drafted_from: [${handle}]\n`),
    })
    expect(adr.status).toBe(200)
    expect(await list()).toEqual([])
    // a second ADR drafted from the same memory is refused
    const dup = await s.call('POST', '/adr/push', {
      source_path: 'docs/adr/0002-use-rrf.md',
      content: ADR(2, 'Use RRF again', `drafted_from: [${handle}]\n`),
    })
    expect(dup.status).toBe(409)
    expect((await json<Body>(dup)).error).toBe('already_drafted')
  })

  it('validates its query and refuses foreign tokens', async () => {
    expect((await s.call('GET', '/decisions/undrafted?since=nope')).status).toBe(400)
    expect((await s.call('GET', '/decisions/undrafted?mine=maybe')).status).toBe(400)
    const foreign = await s.call('GET', '/decisions/undrafted', undefined, s.otherTok.secret)
    expect((await json<Body>(foreign)).error).toBe('token_project_mismatch')
  })
})
