// Repo mirror: POST /p/:slug/api/push and /adr/import (data-model.md section 7, api.md 7.2 and 7.3,
// deviations I3, I42, I44). decisions/undrafted after a push: src/app.integration.test.ts.
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import { testDatabaseUrl } from '../../../test/db-url.js'
import {
  addMember,
  createItem,
  createProject,
  createSharedProject,
  createToken,
  createUser,
} from '../../../test/factories.js'
import { Client, json, loginAs, testApp } from '../../../test/http.js'
import {
  FakeEmbeddingProvider,
  type MemoryJobsPort,
  StaticEmbeddingRegistry,
  stubPorts,
} from '../../../test/ports.js'
import { createDb } from '../../db/client.js'
import { auditLog, edges, itemRevisions, items, projects } from '../../db/schema.js'
import type { Tx } from '../../lib/db.js'
import { type ChunkSource, type IndexedItem, NoopSearchPort, type PreparedChunks } from '../../ports.js'

const db = () => testDb()

async function seed() {
  const { app } = testApp({ ports: stubPorts() })
  await createSharedProject(db())
  const acme = await createProject(db(), { slug: 'acme' })
  const other = await createProject(db(), { slug: 'other' })
  const dev = await createUser(db())
  const viewer = await createUser(db())
  await addMember(db(), acme.id, dev.id, 'editor')
  await addMember(db(), acme.id, viewer.id, 'viewer')
  const tok = await createToken(db(), { projectId: acme.id, userId: dev.id })
  const roTok = await createToken(db(), { projectId: acme.id, userId: viewer.id })
  const cli = new Client(app)
  const call = (method: 'GET' | 'POST', path: string, body?: unknown, secret = tok.secret) =>
    cli.request(method, `/p/acme/api${path}`, {
      body,
      origin: null,
      headers: { authorization: `Bearer ${secret}`, 'user-agent': 'spoor-cli/0.1.0' },
    })
  return { app, acme, other, dev, viewer, tok, roTok, call }
}

let s: Awaited<ReturnType<typeof seed>>
beforeEach(async () => {
  s = await seed()
})

type Result = {
  status: string
  handle: string
  spoor_id: string
  revision: number
  adr_number: number | null
  renumbered: { from: number; to: number } | null
  warnings: { code: string; [k: string]: unknown }[]
}
const push = async (
  source_path: string,
  content: string,
  extra: Record<string, unknown> = {},
  space = 'decisions',
) => {
  const r = await s.call('POST', '/push', { space, source_path, content, ...extra })
  return {
    status: r.status,
    body: await json<Result & { error?: string; details?: Record<string, unknown> }>(r),
  }
}
const item = async (id: string) =>
  (await db().select().from(items).where(eq(items.id, id)))[0] as typeof items.$inferSelect
const ADR7 = '# ADR-0007: Use Postgres\n\n## Context\n\nWe need a DB.\n'

describe('push', () => {
  it('creates from the file: number from the name, title from the H1, slug without the number', async () => {
    const r = await push('docs/adr/0007-use-postgres.md', ADR7)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      status: 'created',
      handle: 'ADR-0007',
      adr_number: 7,
      revision: 1,
      renumbered: null,
    })
    const row = await item(r.body.spoor_id)
    expect(row).toMatchObject({
      slug: 'use-postgres',
      title: 'Use Postgres',
      status: 'accepted',
      sourcePath: 'docs/adr/0007-use-postgres.md',
      provenance: 'human',
      clientName: 'spoor-cli/0.1.0',
      decidedOn: null,
    })
    const [rev] = await db().select().from(itemRevisions).where(eq(itemRevisions.itemId, row.id))
    expect(rev).toMatchObject({ via: 'cli', change: 'create', tokenId: s.tok.id })
    expect((await db().select().from(projects).where(eq(projects.id, s.acme.id)))[0]?.nextAdrNumber).toBe(8)
  })

  it('fast-forwards on base_revision or a CLI-only history; identical content is unchanged', async () => {
    const r1 = await push('docs/adr/0007-use-postgres.md', ADR7)
    const r2 = await push('docs/adr/0007-use-postgres.md', `${ADR7}\nMore.\n`, { base_revision: 1 })
    expect(r2.body).toMatchObject({ status: 'updated', revision: 2 })
    // no base: the latest revision came from the CLI, so it is still a fast-forward
    const r3 = await push('docs/adr/0007-use-postgres.md', `${ADR7}\nEven more.\n`)
    expect(r3.body).toMatchObject({ status: 'updated', revision: 3 })
    const r4 = await push('docs/adr/0007-use-postgres.md', `${ADR7}\nEven more.\n`)
    expect(r4.body).toMatchObject({ status: 'unchanged', revision: 3 })
    const revs = await db().select().from(itemRevisions).where(eq(itemRevisions.itemId, r1.body.spoor_id))
    expect(revs.map((r) => r.change)).toEqual(['create', 'push', 'push'])
  })

  it('a Spoor edit makes the next push a conflict; --force writes; aligning the file clears it', async () => {
    const r1 = await push('docs/adr/0007-use-postgres.md', ADR7)
    const web = await loginAs(s.app, s.dev.email, s.dev.password)
    await web.patch(`/api/v1/projects/acme/items/ADR-0007`, { revision: 1, body: 'edited in Spoor' })
    const refused = await push('docs/adr/0007-use-postgres.md', `${ADR7}\nrepo change\n`, {
      base_revision: 1,
    })
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({
      error: 'pushed_over_spoor_edit',
      details: { current_revision: 2, edited_by: s.dev.email, via: 'web' },
    })
    const conflicted = await item(r1.body.spoor_id)
    expect(conflicted.pushConflictAt).not.toBeNull()
    expect(conflicted.body).toBe('edited in Spoor')
    expect(await db().select().from(auditLog).where(eq(auditLog.action, 'item.push_rejected'))).toHaveLength(
      1,
    )

    // aligning the file with Spoor (identical content) clears the conflict without a revision
    const aligned = await push(
      'docs/adr/0007-use-postgres.md',
      '---\ntitle: Use Postgres\n---\nedited in Spoor',
    )
    expect(aligned.body).toMatchObject({ status: 'unchanged', revision: 2 })
    expect((await item(r1.body.spoor_id)).pushConflictAt).toBeNull()

    await web.patch(`/api/v1/projects/acme/items/ADR-0007`, { revision: 2, body: 'edited again' })
    expect((await push('docs/adr/0007-use-postgres.md', ADR7)).status).toBe(409)
    const forced = await push('docs/adr/0007-use-postgres.md', ADR7, { force: true })
    expect(forced.body).toMatchObject({ status: 'updated', revision: 4 })
    expect((await item(r1.body.spoor_id)).pushConflictAt).toBeNull()
    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'item.push'), eq(auditLog.itemId, r1.body.spoor_id)))
      .orderBy(auditLog.id)
      .offset(1)
    expect(audit?.data).toMatchObject({ forced: true })
  })

  it('operational keys apply only on create; content keys follow the file; server-owned extras stay', async () => {
    const r1 = await push(
      'docs/adr/0003-x.md',
      '---\npinned: true\nlast_verified: 2026-01-01\ntags: [db]\nowner: ann\n---\n# X\n',
    )
    let row = await item(r1.body.spoor_id)
    expect(row).toMatchObject({ pinned: true, tags: ['db'], frontmatter: { owner: 'ann' } })
    expect(row.lastVerifiedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    await db()
      .update(items)
      .set({ frontmatter: { owner: 'ann', renumbered_from: 2 } })
      .where(eq(items.id, row.id))
    await push('docs/adr/0003-x.md', '---\npinned: false\nlast_verified: 2026-05-01\n---\n# X\n')
    row = await item(r1.body.spoor_id)
    expect(row).toMatchObject({ pinned: true, tags: [], frontmatter: { renumbered_from: 2 } })
    expect(row.lastVerifiedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('status: frontmatter, ## Status section, rejected → deprecated (original kept)', async () => {
    const a = await push('docs/adr/0001-a.md', '---\nstatus: proposed\n---\n# A\n')
    expect((await item(a.body.spoor_id)).status).toBe('proposed')
    const b = await push('docs/adr/0002-b.md', '# B\n\n## Status\n\nRejected\n')
    expect(await item(b.body.spoor_id)).toMatchObject({
      status: 'deprecated',
      frontmatter: { original_status: 'rejected' },
    })
    const bad = await push('docs/adr/0003-c.md', '---\nstatus: maybe\n---\n')
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({
      error: 'invalid_input',
      details: { issues: [{ path: 'frontmatter.status' }] },
    })
  })

  it('bold-bullet ADR headers: status and date from `- **Status:**` / `- **Date:**` (review-log-phase5 D3, D5)', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const r = await s.call('POST', '/adr/import', {
      reserve_above: 3,
      files: [
        {
          source_path: 'docs/adr/0001-old.md',
          content: `# 1. Old choice\n\n- **Status:** Superseded by ADR-0003\n- **Date:** ${today}\n`,
        },
        {
          source_path: 'docs/adr/0002-maybe.md',
          content: `# 2. Maybe later\n\n- **Status:** Proposed\n- **Date:** ${today}\n`,
        },
        {
          source_path: 'docs/adr/0003-new.md',
          content: `# 3. New choice\n\n- **Status:** Accepted\n- **Date:** ${today}\n`,
        },
      ],
    })
    expect(r.status).toBe(200)
    const results = (await json<{ results: Result[] }>(r)).results
    const rows = await Promise.all(results.map((x) => item(x.spoor_id)))
    expect(rows.map((x) => x.status)).toEqual(['superseded', 'proposed', 'accepted'])
    expect(rows.map((x) => x.decidedOn)).toEqual([today, today, today])
    // the accepted one is in the digest's decision tier; the superseded and proposed ones are not
    const ctx = await s.call('GET', '/context')
    expect(ctx.status).toBe(200)
    const text = await ctx.text()
    expect(text).toContain('## Decisions (30d)')
    expect(text).toContain('New choice')
    expect(text).not.toContain('Old choice')
    expect(text).not.toContain('Maybe later')
  })

  it('supersedes sets the old ADR superseded; the status is sticky afterwards', async () => {
    const one = await push('docs/adr/0001-mysql.md', '# Use MySQL\n')
    const two = await push('docs/adr/0002-postgres.md', '---\nsupersedes: ADR-0001\n---\n# Use Postgres\n')
    expect(two.body.warnings).toEqual([])
    const old = await item(one.body.spoor_id)
    expect(old.status).toBe('superseded')
    const [rev] = await db()
      .select()
      .from(itemRevisions)
      .where(and(eq(itemRevisions.itemId, old.id), eq(itemRevisions.revision, 2)))
    expect(rev).toMatchObject({ change: 'supersede', via: 'cli' })
    const again = await push('docs/adr/0001-mysql.md', '---\nstatus: accepted\n---\n# Use MySQL\n\nedit\n')
    expect(again.body.warnings).toContainEqual({ code: 'status_kept_superseded' })
    expect((await item(old.id)).status).toBe('superseded')
    const unresolved = await push('docs/adr/0003-z.md', '---\nsupersedes: ADR-0099\n---\n# Z\n')
    expect(unresolved.body.warnings).toContainEqual({ code: 'unresolved_supersedes', ref: 'ADR-0099' })
  })

  it('Superseded by … in the status section adds the edge from the newer ADR', async () => {
    const newer = await push('docs/adr/0002-new.md', '# New\n')
    const old = await push('docs/adr/0001-old.md', '# Old\n\n## Status\n\nSuperseded by ADR-0002\n')
    const e = await db().select().from(edges).where(eq(edges.kind, 'supersedes'))
    expect(e.map((x) => [x.srcId, x.dstId])).toEqual([[newer.body.spoor_id, old.body.spoor_id]])
    expect((await item(old.body.spoor_id)).status).toBe('superseded')
  })

  it('spoor_id: rename follows; a taken path is source_path_taken; a foreign id is ignored', async () => {
    const a = await push('docs/adr/0001-a.md', '# A\n')
    await push('docs/adr/0002-b.md', '# B\n')
    const moved = await push('docs/adr/0001-a-renamed.md', `---\nspoor_id: ${a.body.spoor_id}\n---\n# A\n`)
    expect(moved.body).toMatchObject({
      status: 'unchanged',
      warnings: [{ code: 'source_path_updated', from: 'docs/adr/0001-a.md' }],
    })
    expect((await item(a.body.spoor_id)).sourcePath).toBe('docs/adr/0001-a-renamed.md')
    const clash = await push('docs/adr/0002-b.md', `---\nspoor_id: ${a.body.spoor_id}\n---\n# A changed\n`)
    expect(clash.status).toBe(409)
    expect(clash.body.error).toBe('source_path_taken')

    const foreign = await createItem(db(), { projectId: s.other.id, space: 'decisions' })
    const f = await push('docs/adr/0009-f.md', `---\nspoor_id: ${foreign.id}\n---\n# F\n`)
    expect(f.body).toMatchObject({ status: 'created', warnings: [{ code: 'foreign_spoor_id' }] })
    expect(f.body.spoor_id).not.toBe(foreign.id)
    expect((await item(foreign.id)).title).toBe(foreign.title)
  })

  it('a held number renumbers; drafted_from adds edges and refuses a second ADR for the same memory', async () => {
    const web = await createItem(db(), { projectId: s.acme.id, space: 'decisions' }) // ADR-0001, no source_path
    const r = await push('docs/adr/0001-clash.md', '# Clash\n')
    expect(r.body).toMatchObject({ status: 'created', adr_number: 2, renumbered: { from: 1, to: 2 } })
    expect((await item(r.body.spoor_id)).frontmatter).toMatchObject({ renumbered_from: 1 })
    expect((await item(web.id)).adrNumber).toBe(1)

    const mem = await createItem(db(), { projectId: s.acme.id, type: 'decision', createdBy: s.dev.id })
    const memHandle = `m${mem.number}`
    const first = await push(
      'docs/adr/0005-drafted.md',
      `---\nstatus: proposed\ndrafted_from: [${memHandle}]\n---\n# D\n`,
    )
    expect(first.body.status).toBe('created')
    expect(await db().select().from(edges).where(eq(edges.kind, 'drafted_from'))).toHaveLength(1)
    const second = await push(
      'docs/adr/0006-drafted-again.md',
      `---\ndrafted_from: [${memHandle}]\n---\n# D2\n`,
    )
    expect(second.status).toBe(409)
    expect(second.body).toMatchObject({
      error: 'already_drafted',
      details: { handle: memHandle, adr: 'ADR-0005' },
    })
    expect(
      await db().select().from(items).where(eq(items.sourcePath, 'docs/adr/0006-drafted-again.md')),
    ).toEqual([])
  })

  it('docs: identity by path, slug from the file name, status active', async () => {
    const r = await push('ARCHITECTURE.md', '# Architecture\n\nSee [[glossary]].\n', {}, 'docs')
    expect(r.body).toMatchObject({ status: 'created', handle: 'd1', adr_number: null })
    expect(await item(r.body.spoor_id)).toMatchObject({
      slug: 'architecture',
      title: 'Architecture',
      status: 'active',
    })
    const g = await push('GLOSSARY.md', '# Glossary\n', {}, 'docs')
    const [link] = await db().select().from(edges).where(eq(edges.srcId, r.body.spoor_id))
    expect(link?.dstId).toBe(g.body.spoor_id)
    expect((await push('ARCHITECTURE.md', '# Architecture\n', {}, 'decisions')).body.error).toBe(
      'wrong_space',
    )
  })

  it('bearer rules: viewer tokens cannot push; invalid paths and bodies are 400', async () => {
    const r = await s.call(
      'POST',
      '/push',
      { space: 'decisions', source_path: 'docs/adr/0001-a.md', content: '# A' },
      s.roTok.secret,
    )
    expect(r.status).toBe(403)
    expect((await json(r)).error).toBe('forbidden_role')
    expect((await push('../etc/passwd', '# x')).status).toBe(400)
    expect(
      (await s.call('POST', '/push', { space: 'memories', source_path: 'a.md', content: '' })).status,
    ).toBe(400)
  })
})

describe('adr/import', () => {
  it('keeps numbers, renumbers only true collisions above reserve_above, resolves refs through the batch map', async () => {
    // Spoor already holds ADR-0002 (created in the web UI), so next_adr_number = 3
    await createItem(db(), { projectId: s.acme.id, space: 'decisions' })
    await db().update(items).set({ adrNumber: 2 }).where(eq(items.projectId, s.acme.id))
    await db().update(projects).set({ nextAdrNumber: 3 }).where(eq(projects.id, s.acme.id))
    const files = [
      {
        source_path: 'docs/adr/0003-c.md',
        content: '---\nsupersedes: ADR-0001\nrelations: [{kind: refines, to: ADR-0002}]\n---\n# C\n',
      },
      {
        source_path: 'docs/adr/0001-a.md',
        content: '---\nrelations: [{kind: supports, to: ADR-0003}]\n---\n# A\n',
      },
      { source_path: 'docs/adr/0002-b.md', content: '# B\n' },
      { source_path: 'docs/adr/0004-bad.md', content: '---\nstatus: nope\n---\n' },
    ]
    const r = await s.call('POST', '/adr/import', { files, reserve_above: 4 })
    expect(r.status).toBe(200)
    const { results } = await json<{ results: (Result & { source_path: string; error?: string })[] }>(r)
    // results come back in request order
    expect(results.map((x) => x.source_path)).toEqual(files.map((f) => f.source_path))
    const [c, a, b, bad] = results as unknown as [Result, Result, Result, { error: string }]
    expect(a).toMatchObject({ status: 'created', adr_number: 1, renumbered: null })
    expect(b).toMatchObject({ status: 'created', adr_number: 5, renumbered: { from: 2, to: 5 } })
    expect(c).toMatchObject({ status: 'created', adr_number: 3 })
    expect(bad).toMatchObject({ error: 'invalid_input' })
    // C supersedes ADR-0001 (in the batch, not renumbered): applied
    expect((await item(a.spoor_id)).status).toBe('superseded')
    // C refines ADR-0002: renumbered in this batch → ambiguous, not applied
    expect(c.warnings).toContainEqual({
      code: 'ambiguous_ref',
      ref: 'ADR-0002',
      candidates: ['ADR-0002', 'ADR-0005'],
    })
    // A supports ADR-0003: a later file of the same batch, resolved in the second pass
    const supports = await db().select().from(edges).where(eq(edges.kind, 'supports'))
    expect(supports.map((e) => [e.srcId, e.dstId])).toEqual([[a.spoor_id, c.spoor_id]])

    // re-running matches by source_path: nothing new
    const again = await json<{ results: Result[] }>(
      await s.call('POST', '/adr/import', { files: files.slice(0, 3), reserve_above: 4 }),
    )
    expect(again.results.map((x) => x.status)).toEqual(['unchanged', 'unchanged', 'unchanged'])
    // a later ref to the renumbered number stays ambiguous (renumbered_from)
    const later = await push(
      'docs/adr/0009-later.md',
      '---\nrelations: [{kind: refines, to: ADR-0002}]\n---\n# Later\n',
    )
    expect(later.body.warnings).toContainEqual({
      code: 'ambiguous_ref',
      ref: 'ADR-0002',
      candidates: ['ADR-0002', 'ADR-0005'],
    })
  })
})

/** prepareChunks waits on a gate while armed, so a test can commit another write in that window. */
class GatedSearch extends NoopSearchPort {
  #release: (() => void) | null = null
  #gate: Promise<void> | null = null
  waiting = 0
  #onWait: (() => void)[] = []
  #slots = 0
  /** Gate the next `n` calls only. */
  arm(n = 1) {
    this.#slots = n
    this.#gate = new Promise((r) => {
      this.#release = r
    })
  }
  release() {
    this.#release?.()
    this.#gate = null
  }
  /** Resolves once `n` prepareChunks calls are parked at the gate. */
  parked(n: number): Promise<void> {
    return new Promise((r) => {
      const check = () => (this.waiting >= n ? r() : this.#onWait.push(check))
      check()
    })
  }
  override async prepareChunks(source: ChunkSource): Promise<PreparedChunks> {
    if (this.#gate && this.#slots > 0) {
      this.#slots--
      const gate = this.#gate
      this.waiting++
      for (const f of this.#onWait.splice(0)) f()
      await gate
    }
    return super.prepareChunks(source)
  }
}

describe('push races (phase-2 review D1, D3)', () => {
  async function gatedSeed() {
    const search = new GatedSearch()
    const { app } = testApp({ ports: stubPorts({ search }) })
    const acme = await createProject(db(), { slug: 'race' })
    const dev = await createUser(db())
    await addMember(db(), acme.id, dev.id, 'editor')
    const tok = await createToken(db(), { projectId: acme.id, userId: dev.id })
    const pushFile = async (source_path: string, content: string, extra: Record<string, unknown> = {}) => {
      const r = await new Client(app).request('POST', '/p/race/api/push', {
        body: { space: 'decisions', source_path, content, ...extra },
        origin: null,
        headers: { authorization: `Bearer ${tok.secret}`, 'user-agent': 'spoor-cli/0.1.0' },
      })
      return { status: r.status, body: await json<Result & { error?: string }>(r) }
    }
    return { app, search, acme, dev, pushFile }
  }

  it('a web edit committed during a push’s embedding call is a 409, not overwritten', async () => {
    const g = await gatedSeed()
    const first = await g.pushFile('docs/adr/0001-a.md', '# A\n\nfirst\n')
    expect(first.body.status).toBe('created')
    g.search.arm()
    const pending = g.pushFile('docs/adr/0001-a.md', '# A\n\nsecond from the repo\n')
    await g.search.parked(1)
    const web = await loginAs(g.app, g.dev.email, g.dev.password)
    const edited = await web.patch('/api/v1/projects/race/items/ADR-0001', {
      revision: 1,
      body: 'human edit',
    })
    expect(edited.status).toBe(200)
    g.search.release()
    const second = await pending
    expect(second.status).toBe(409)
    expect(second.body.error).toBe('pushed_over_spoor_edit')
    const row = await item(first.body.spoor_id)
    expect(row.body).toBe('human edit')
    expect(row.revision).toBe(2)
    expect(row.pushConflictAt).not.toBeNull()
    const revs = await db().select().from(itemRevisions).where(eq(itemRevisions.itemId, row.id))
    expect(revs.map((r) => r.via).sort()).toEqual(['cli', 'web'])
  })

  it('a CLI push committed meanwhile is still a fast-forward', async () => {
    const g = await gatedSeed()
    const first = await g.pushFile('docs/adr/0001-a.md', '# A\n\nfirst\n')
    g.search.arm()
    const pending = g.pushFile('docs/adr/0001-a.md', '# A\n\nthird\n')
    await g.search.parked(1)
    const other = await g.pushFile('docs/adr/0001-a.md', '# A\n\nsecond\n')
    expect(other.body.status).toBe('updated')
    g.search.release()
    expect((await pending).body).toMatchObject({ status: 'updated', revision: 3 })
    expect((await item(first.body.spoor_id)).body).toContain('third')
  })

  it('two concurrent drafts of one memory: one ADR, one 409 already_drafted', async () => {
    const g = await gatedSeed()
    const mem = await createItem(db(), { projectId: g.acme.id, type: 'decision', createdBy: g.dev.id })
    g.search.arm(2)
    const a = g.pushFile('docs/adr/0001-a.md', `---\ndrafted_from: [m${mem.number}]\n---\n# A\n`)
    const b = g.pushFile('docs/adr/0002-b.md', `---\ndrafted_from: [m${mem.number}]\n---\n# B\n`)
    await g.search.parked(2)
    g.search.release()
    const results = await Promise.all([a, b])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(results.find((r) => r.status === 409)?.body.error).toBe('already_drafted')
    expect(await db().select().from(edges).where(eq(edges.kind, 'drafted_from'))).toHaveLength(1)
    expect(
      await db()
        .select()
        .from(items)
        .where(and(eq(items.space, 'decisions'), eq(items.projectId, g.acme.id))),
    ).toHaveLength(1)
  })
})

describe('library pages are never pushed (ADR-0014)', () => {
  it('a spoor_id naming a library page is 403 read_only_space and changes nothing', async () => {
    const page = await createItem(db(), { projectId: s.acme.id, space: 'library', title: 'Guide' })
    for (const space of ['docs', 'decisions']) {
      const r = await push('docs/guide.md', `---\nspoor_id: ${page.id}\n---\n# Pushed over\n`, {}, space)
      expect(r.status).toBe(403)
      expect(r.body.error).toBe('read_only_space')
    }
    expect(await item(page.id)).toMatchObject({ title: 'Guide', revision: 1, sourcePath: null })
    // the space of a push is decisions or docs only
    const bad = await push('docs/guide.md', '# Guide\n', {}, 'library')
    expect(bad.status).toBe(400)
  })

  it('a supersedes / drafted_from ref to a library page is not applied', async () => {
    await createItem(db(), { projectId: s.acme.id, space: 'library', slug: 'guide' }) // L1
    const r = await push('docs/adr/0001-a.md', '---\nsupersedes: L1\ndrafted_from: [L1]\n---\n# A\n')
    expect(r.status).toBe(200)
    const rows = await db().select().from(edges).where(eq(edges.srcId, r.body.spoor_id))
    expect(rows.filter((e) => e.kind === 'supersedes' || e.kind === 'drafted_from')).toEqual([])
  })
})

// ---- import resilience: per-file isolation, retries, one connection, deferral, admission ----------------

type App = ReturnType<typeof testApp>['app']
type ImportResult = Result & { source_path: string; error?: string; message?: string }

/** A bearer caller of `app` (any app instance on the test database), with optional extra headers. */
function bearer(app: App, secret: string, slug = 'acme') {
  const cli = new Client(app)
  return (method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) =>
    cli.request(method, `/p/${slug}/api${path}`, {
      body,
      origin: null,
      headers: { authorization: `Bearer ${secret}`, 'user-agent': 'spoor-cli/0.0.0', ...headers },
    })
}

const DEFER = { 'Spoor-Defer-Embedding': '1' }
const DEFER_EDGES = { 'Spoor-Import-Edges': 'defer' }

/** indexItemChunks throws for armed titles, or once with a given error. */
class ThrowingSearch extends NoopSearchPort {
  readonly failTitles = new Set<string>()
  failOnce: (() => unknown) | null = null
  /** Throws once, for the first indexing of an item with this title. */
  failOnceFor: { title: string; err: () => unknown } | null = null
  override async indexItemChunks(
    tx: Tx,
    item: IndexedItem,
    // optional in NoopSearchPort's signature; the real callers always pass it
    prepared?: PreparedChunks,
  ): Promise<{ embeddingPending: boolean }> {
    const once = this.failOnce
    if (once) {
      this.failOnce = null
      throw once()
    }
    const forTitle = this.failOnceFor
    if (forTitle && prepared?.source.title === forTitle.title) {
      this.failOnceFor = null
      throw forTitle.err()
    }
    if (prepared && this.failTitles.has(prepared.source.title)) throw new Error('boom')
    return super.indexItemChunks(tx, item)
  }
}

const importResults = async (r: Response) => {
  expect(r.status).toBe(200)
  return (await json<{ results: ImportResult[] }>(r)).results
}

/** Spoor already holds ADR-0002 (created in the web UI), so next_adr_number = 3. */
async function nativeAdr2() {
  const native = await createItem(db(), { projectId: s.acme.id, space: 'decisions' })
  await db().update(items).set({ adrNumber: 2 }).where(eq(items.id, native.id))
  await db().update(projects).set({ nextAdrNumber: 3 }).where(eq(projects.id, s.acme.id))
  return native
}

describe('adr/import: per-file isolation (S1)', () => {
  it('an unexpected error in pass 1 is that file’s internal result; the others are created', async () => {
    const search = new ThrowingSearch()
    const { app } = testApp({ ports: stubPorts({ search }) })
    const call = bearer(app, s.tok.secret)
    search.failTitles.add('Beta choice')
    const files = [
      { source_path: 'docs/adr/0001-a.md', content: '# Alpha choice\n' },
      { source_path: 'docs/adr/0002-b.md', content: '# Beta choice\n' },
      { source_path: 'docs/adr/0003-c.md', content: '# Gamma choice\n' },
    ]
    const [a, b, c] = await importResults(await call('POST', '/adr/import', { files }))
    expect(b).toEqual({ source_path: 'docs/adr/0002-b.md', error: 'internal', message: 'Internal error.' })
    expect(a).toMatchObject({ status: 'created', adr_number: 1 })
    expect(c).toMatchObject({ status: 'created', adr_number: 3 })
    expect(await item((a as Result).spoor_id)).toBeDefined()
    expect(await item((c as Result).spoor_id)).toBeDefined()
    expect(await db().select().from(items).where(eq(items.sourcePath, 'docs/adr/0002-b.md'))).toEqual([])
  })

  it('an unexpected error in pass 2 is an edges_failed warning; a re-send applies the edge', async () => {
    const search = new ThrowingSearch()
    const { app } = testApp({ ports: stubPorts({ search }) })
    const call = bearer(app, s.tok.secret)
    const [a] = await importResults(
      await call('POST', '/adr/import', {
        files: [{ source_path: 'docs/adr/0001-a.md', content: '# Alpha choice\n' }],
      }),
    )
    // fires from applySupersede's re-index of A
    search.failTitles.add('Alpha choice')
    const fileB = {
      source_path: 'docs/adr/0002-b.md',
      content: '---\nsupersedes: ADR-0001\n---\n# Beta choice\n',
    }
    const [b] = await importResults(await call('POST', '/adr/import', { files: [fileB] }))
    expect(b).toMatchObject({ status: 'created' })
    expect(b?.warnings).toContainEqual({
      code: 'edges_failed',
      source_path: 'docs/adr/0002-b.md',
      error: 'internal',
      message: 'Internal error.',
    })
    expect((await item((a as Result).spoor_id)).status).toBe('accepted')
    expect(await db().select().from(edges).where(eq(edges.kind, 'supersedes'))).toEqual([])

    search.failTitles.clear()
    const [again] = await importResults(await call('POST', '/adr/import', { files: [fileB] }))
    expect(again).toMatchObject({ status: 'unchanged', warnings: [] })
    const e = await db().select().from(edges).where(eq(edges.kind, 'supersedes'))
    expect(e.map((x) => [x.srcId, x.dstId])).toEqual([[(b as Result).spoor_id, (a as Result).spoor_id]])
    expect((await item((a as Result).spoor_id)).status).toBe('superseded')
  })

  it('after 3 unexpected errors the rest of the request is not processed', async () => {
    const search = new ThrowingSearch()
    const { app } = testApp({ ports: stubPorts({ search }) })
    const call = bearer(app, s.tok.secret)
    const files = [1, 2, 3, 4, 5].map((n) => {
      search.failTitles.add(`Choice ${n}`)
      return { source_path: `docs/adr/000${n}-c.md`, content: `# Choice ${n}\n` }
    })
    const results = await importResults(await call('POST', '/adr/import', { files }))
    expect(results.map((r) => [r.source_path, r.error, r.message])).toEqual([
      ['docs/adr/0001-c.md', 'internal', 'Internal error.'],
      ['docs/adr/0002-c.md', 'internal', 'Internal error.'],
      ['docs/adr/0003-c.md', 'internal', 'Internal error.'],
      ['docs/adr/0004-c.md', 'internal', 'not processed'],
      ['docs/adr/0005-c.md', 'internal', 'not processed'],
    ])
    expect(await db().select().from(items).where(eq(items.space, 'decisions'))).toEqual([])
  })

  it('after 3 unexpected errors pass 2 is not processed either: edges_failed, no edge written', async () => {
    const search = new ThrowingSearch()
    const { app } = testApp({ ports: stubPorts({ search }) })
    const call = bearer(app, s.tok.secret)
    const target = await createItem(db(), { projectId: s.acme.id, space: 'memories', title: 'Target fact' })
    const files = [
      {
        source_path: 'docs/adr/0001-a.md',
        content: `---\nrelations:\n  - kind: supports\n    to: ${target.id}\n---\n# Alpha choice\n`,
      },
      ...[2, 3, 4].map((n) => {
        search.failTitles.add(`Choice ${n}`)
        return { source_path: `docs/adr/000${n}-c.md`, content: `# Choice ${n}\n` }
      }),
    ]
    const [a, ...rest] = await importResults(await call('POST', '/adr/import', { files }))
    expect(rest.map((r) => r.error)).toEqual(['internal', 'internal', 'internal'])
    expect(a).toMatchObject({ status: 'created' })
    expect(a?.warnings).toContainEqual({
      code: 'edges_failed',
      source_path: 'docs/adr/0001-a.md',
      error: 'internal',
      message: 'not processed',
    })
    expect(
      await db()
        .select()
        .from(edges)
        .where(eq(edges.srcId, (a as Result).spoor_id)),
    ).toEqual([])
  })

  it('a ref to the number of a file whose pass 1 failed stays unresolved, never the stored ADR with that number', async () => {
    const native = await nativeAdr2() // a non-repo ADR-0002 held by Spoor
    const search = new ThrowingSearch()
    const { app } = testApp({ ports: stubPorts({ search }) })
    const call = bearer(app, s.tok.secret)
    search.failTitles.add('Repo two')
    const files = [
      { source_path: 'docs/adr/0002-two.md', content: '# Repo two\n' },
      { source_path: 'docs/adr/0009-nine.md', content: '---\nsupersedes: ADR-0002\n---\n# Nine\n' },
    ]
    const [two, nine] = await importResults(await call('POST', '/adr/import', { files, reserve_above: 9 }))
    expect(two).toMatchObject({ error: 'internal' })
    expect(nine).toMatchObject({ status: 'created' })
    expect(nine?.warnings).toContainEqual({ code: 'unresolved_supersedes', ref: 'ADR-0002' })
    expect((await item(native.id)).status).not.toBe('superseded')
    expect(await db().select().from(edges).where(eq(edges.kind, 'supersedes'))).toEqual([])
  })
})

describe('push: transient DB errors are retried (S2)', () => {
  it('a deadlock on the first attempt of a create and of an update is retried', async () => {
    const search = new ThrowingSearch()
    const { app } = testApp({ ports: stubPorts({ search }) })
    const call = bearer(app, s.tok.secret)
    const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' })
    search.failOnce = deadlock
    const r1 = await call('POST', '/push', {
      space: 'decisions',
      source_path: 'docs/adr/0001-a.md',
      content: '# A\n',
    })
    expect(r1.status).toBe(200)
    const created = await json<Result>(r1)
    expect(created).toMatchObject({ status: 'created', revision: 1 })
    expect(
      await db()
        .select()
        .from(items)
        .where(and(eq(items.projectId, s.acme.id), eq(items.space, 'decisions'))),
    ).toHaveLength(1)

    search.failOnce = deadlock
    const r2 = await call('POST', '/push', {
      space: 'decisions',
      source_path: 'docs/adr/0001-a.md',
      content: '# A\n\nchanged\n',
    })
    expect(r2.status).toBe(200)
    expect(await json(r2)).toMatchObject({ status: 'updated', revision: 2 })
    const revs = await db().select().from(itemRevisions).where(eq(itemRevisions.itemId, created.spoor_id))
    expect(revs.map((r) => r.change)).toEqual(['create', 'push'])
  })

  it('a deadlock inside the pass-2 (supersede) transaction is retried: the edge is applied, no warning', async () => {
    const search = new ThrowingSearch()
    const { app } = testApp({ ports: stubPorts({ search }) })
    const call = bearer(app, s.tok.secret)
    const pushA = await call('POST', '/push', {
      space: 'decisions',
      source_path: 'docs/adr/0001-a.md',
      content: '# Alpha choice\n',
    })
    const a = await json<Result>(pushA)
    // fires from applySupersede's re-index of A, inside the pass-2 transaction
    search.failOnceFor = {
      title: 'Alpha choice',
      err: () => Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    }
    const r = await call('POST', '/push', {
      space: 'decisions',
      source_path: 'docs/adr/0002-b.md',
      content: '---\nsupersedes: ADR-0001\n---\n# Beta choice\n',
    })
    expect(r.status).toBe(200)
    const b = await json<Result>(r)
    expect(b).toMatchObject({ status: 'created', warnings: [] })
    expect(search.failOnceFor).toBeNull()
    const e = await db().select().from(edges).where(eq(edges.kind, 'supersedes'))
    expect(e.map((x) => [x.srcId, x.dstId])).toEqual([[b.spoor_id, a.spoor_id]])
    expect((await item(a.spoor_id)).status).toBe('superseded')
  })
})

describe('push: no second pooled connection inside a push transaction (S3)', () => {
  const one = createDb(testDatabaseUrl(), 1)
  afterAll(async () => {
    await one.pool.end()
  })

  it('create, update, supersede and an import supersede all work on a pool of one connection', async () => {
    const { app } = testApp({ ports: stubPorts(), db: one.db })
    const call = bearer(app, s.tok.secret)
    const timed = async (path: string, body: unknown) => {
      const t0 = Date.now()
      const r = await call('POST', path, body)
      const ms = Date.now() - t0
      expect(r.status, `${path}: ${await r.clone().text()}`).toBe(200)
      expect(ms).toBeLessThan(4000)
      return json<Record<string, unknown>>(r)
    }
    const push1 = { space: 'decisions', source_path: 'docs/adr/0001-a.md', content: '# A\n' }
    expect(await timed('/push', push1)).toMatchObject({ status: 'created' })
    expect(await timed('/push', { ...push1, content: '# A\n\nmore\n' })).toMatchObject({ status: 'updated' })
    expect(
      await timed('/push', {
        space: 'decisions',
        source_path: 'docs/adr/0002-b.md',
        content: '---\nsupersedes: ADR-0001\n---\n# B\n',
      }),
    ).toMatchObject({ status: 'created', warnings: [] })
    const imp = {
      files: [{ source_path: 'docs/adr/0003-c.md', content: '---\nsupersedes: ADR-0002\n---\n# C\n' }],
    }
    const first = (await timed('/adr/import', imp)) as { results: Result[] }
    expect(first.results[0]).toMatchObject({ status: 'created', warnings: [] })
    // the same supersede again: the target is already superseded
    const again = (await timed('/adr/import', imp)) as { results: Result[] }
    expect(again.results[0]).toMatchObject({ status: 'unchanged', warnings: [] })
    const rows = await db().select().from(items).where(eq(items.space, 'decisions')).orderBy(items.adrNumber)
    expect(rows.map((r) => r.status)).toEqual(['superseded', 'superseded', 'accepted'])
  })
})

describe('deferred embedding: Spoor-Defer-Embedding (S4)', () => {
  async function realSeed() {
    const fake = new FakeEmbeddingProvider()
    const ports = stubPorts({ embeddings: new StaticEmbeddingRegistry(fake) })
    const { app, modules } = testApp({ ports })
    ports.search = modules.search.search
    const proj = await createProject(db(), { slug: 'emb', embeddingModel: fake.tag })
    await addMember(db(), proj.id, s.dev.id, 'editor')
    const tok = await createToken(db(), { projectId: proj.id, userId: s.dev.id })
    const call = bearer(app, tok.secret, 'emb')
    const passages = () => fake.calls.filter((c) => c.kind === 'passages')
    const chunks = async (itemId: string) =>
      (
        await db().execute<{ has: boolean }>(
          sql`SELECT embedding IS NOT NULL AS has FROM chunks WHERE item_id = ${itemId} ORDER BY ordinal`,
        )
      ).rows.map((r) => r.has)
    const pushDoc = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
      const r = await call('POST', '/push', { space: 'decisions', ...body }, headers)
      expect(r.status).toBe(200)
      return json<Result>(r)
    }
    return { fake, ports, modules, proj, call, passages, chunks, pushDoc }
  }

  it('/push with the header: no model call, NULL chunks, embedding_pending, FTS at once, the job fills them', async () => {
    const e = await realSeed()
    const r = await e.pushDoc(
      { source_path: 'docs/adr/0001-a.md', content: '# Use Postgres\n\nWe need a database.\n' },
      DEFER,
    )
    expect(r.status).toBe('created')
    expect(e.passages()).toEqual([])
    const before = await e.chunks(r.spoor_id)
    expect(before.length).toBeGreaterThan(0)
    expect(before.every((h) => h === false)).toBe(true)
    expect(r.warnings).toContainEqual({ code: 'embedding_pending' })
    expect((e.ports.jobs as MemoryJobsPort).enqueued).toContainEqual({
      name: 'embed-pending',
      projectId: e.proj.id,
    })
    const fts = await e.modules.search.search.search({
      projectId: e.proj.id,
      query: 'postgres',
      limit: 5,
      includeShared: false,
      includeInactive: false,
    })
    expect(fts.hits.map((h) => h.id)).toContain(r.spoor_id)
    await e.modules.search.jobs.embedPending()
    expect((await e.chunks(r.spoor_id)).every((h) => h === true)).toBe(true)

    // the header on an unchanged file: no chunks written, no warning
    const same = await e.pushDoc(
      { source_path: 'docs/adr/0001-a.md', content: '# Use Postgres\n\nWe need a database.\n' },
      DEFER,
    )
    expect(same.status).toBe('unchanged')
    expect(same.warnings).not.toContainEqual({ code: 'embedding_pending' })
  })

  it('without the header the model is called inline as before', async () => {
    const e = await realSeed()
    const r = await e.pushDoc({ source_path: 'docs/adr/0001-a.md', content: '# Use Postgres\n' })
    expect(e.passages().length).toBeGreaterThan(0)
    expect((await e.chunks(r.spoor_id)).every((h) => h === true)).toBe(true)
    expect(r.warnings).not.toContainEqual({ code: 'embedding_pending' })
  })

  it('works on /docs/push and /adr/import too', async () => {
    const e = await realSeed()
    const d = await e.call(
      'POST',
      '/docs/push',
      { source_path: 'ARCHITECTURE.md', content: '# Arch\n' },
      DEFER,
    )
    expect(d.status).toBe(200)
    const doc = await json<Result>(d)
    expect(doc.warnings).toContainEqual({ code: 'embedding_pending' })
    const [adr] = await importResults(
      await e.call(
        'POST',
        '/adr/import',
        { files: [{ source_path: 'docs/adr/0001-a.md', content: '# A\n' }] },
        DEFER,
      ),
    )
    expect(adr?.warnings).toContainEqual({ code: 'embedding_pending' })
    expect(e.passages()).toEqual([])
    expect(await e.chunks(doc.spoor_id)).not.toContain(true)
    expect(await e.chunks((adr as Result).spoor_id)).not.toContain(true)
  })

  it('an import of more than 10 files is deferred without the header; 10 files embed inline', async () => {
    const e = await realSeed()
    const files = (n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => ({
        source_path: `docs/adr/${prefix}/${String(i + 1).padStart(4, '0')}-x.md`,
        content: `# ${prefix} choice ${i + 1}\n`,
      }))
    const eleven = await importResults(await e.call('POST', '/adr/import', { files: files(11, 'big') }))
    expect(eleven).toHaveLength(11)
    expect(eleven.every((r) => r.warnings.some((w) => w.code === 'embedding_pending'))).toBe(true)
    expect(e.passages()).toEqual([])
    const ten = await importResults(
      await e.call('POST', '/adr/import', { files: files(10, 'small'), reserve_above: 11 }),
    )
    expect(ten.map((r) => r.status)).toEqual(Array(10).fill('created'))
    expect(ten.some((r) => r.warnings.some((w) => w.code === 'embedding_pending'))).toBe(false)
    expect(e.passages().length).toBeGreaterThan(0)
  })

  it('a supersede with the header re-indexes the superseded item without the model too', async () => {
    const e = await realSeed()
    const a = await e.pushDoc({ source_path: 'docs/adr/0001-a.md', content: '# Use MySQL\n' })
    expect((await e.chunks(a.spoor_id)).every((h) => h === true)).toBe(true)
    e.fake.calls.length = 0
    const b = await e.pushDoc(
      { source_path: 'docs/adr/0002-b.md', content: '---\nsupersedes: ADR-0001\n---\n# Use Postgres\n' },
      DEFER,
    )
    expect(b.warnings).toContainEqual({ code: 'embedding_pending' })
    expect(e.passages()).toEqual([])
    expect((await item(a.spoor_id)).status).toBe('superseded')
    expect(await e.chunks(a.spoor_id)).not.toContain(true)
    expect(await e.chunks(b.spoor_id)).not.toContain(true)
  })
})

describe('adr/import: Spoor-Import-Edges: defer (H2)', () => {
  it('pass 1 only: edges_deferred for files with edge work; a re-send without the header applies them', async () => {
    const mem = await createItem(db(), { projectId: s.acme.id, type: 'decision', createdBy: s.dev.id })
    const fileA = {
      source_path: 'docs/adr/0001-a.md',
      content: '---\nrelations: [{kind: supports, to: ADR-0002}]\n---\n# Alpha\n',
    }
    const fileB = {
      source_path: 'docs/adr/0002-b.md',
      content: `---\ndrafted_from: [m${mem.number}]\n---\n# Beta\n`,
    }
    const cli = bearer(s.app, s.tok.secret)
    const [a, b] = await importResults(
      await cli('POST', '/adr/import', { files: [fileA, fileB] }, DEFER_EDGES),
    )
    expect(a?.warnings).toContainEqual({ code: 'edges_deferred' })
    expect(b?.status).toBe('created')
    expect(b?.warnings).not.toContainEqual({ code: 'edges_deferred' })
    expect(await db().select().from(edges).where(eq(edges.kind, 'drafted_from'))).toHaveLength(1)
    expect(await db().select().from(edges).where(eq(edges.kind, 'supports'))).toEqual([])

    const [again] = await importResults(await cli('POST', '/adr/import', { files: [fileA] }))
    expect(again).toMatchObject({ status: 'unchanged' })
    expect(again?.warnings).not.toContainEqual({ code: 'edges_deferred' })
    const supports = await db().select().from(edges).where(eq(edges.kind, 'supports'))
    expect(supports.map((e) => [e.srcId, e.dstId])).toEqual([
      [(a as Result).spoor_id, (b as Result).spoor_id],
    ])
  })
})

describe('adr/import across requests: numbering and references', () => {
  it('a ref to a number renumbered by a later request is ambiguous once all files are on the server', async () => {
    await nativeAdr2()
    const cli = bearer(s.app, s.tok.secret)
    const fileA = {
      source_path: 'docs/adr/0001-a.md',
      content: '---\nrelations: [{kind: supports, to: ADR-0002}]\n---\n# A\n',
    }
    const [a] = await importResults(
      await cli('POST', '/adr/import', { files: [fileA], reserve_above: 2 }, DEFER_EDGES),
    )
    expect(a).toMatchObject({ status: 'created', adr_number: 1, warnings: [{ code: 'edges_deferred' }] })
    const [b] = await importResults(
      await cli(
        'POST',
        '/adr/import',
        { files: [{ source_path: 'docs/adr/0002-b.md', content: '# B\n' }], reserve_above: 2 },
        DEFER_EDGES,
      ),
    )
    expect(b).toMatchObject({ status: 'created', adr_number: 3, renumbered: { from: 2, to: 3 } })
    const [again] = await importResults(
      await cli('POST', '/adr/import', { files: [fileA], reserve_above: 2 }),
    )
    expect(again?.warnings).toContainEqual({
      code: 'ambiguous_ref',
      ref: 'ADR-0002',
      candidates: ['ADR-0002', 'ADR-0003'],
    })
    expect(await db().select().from(edges).where(eq(edges.kind, 'supports'))).toEqual([])
  })

  it('collisions in different requests get different numbers above reserve_above', async () => {
    await createItem(db(), { projectId: s.acme.id, space: 'decisions' }) // ADR-0001
    await createItem(db(), { projectId: s.acme.id, space: 'decisions' }) // ADR-0002
    const cli = bearer(s.app, s.tok.secret)
    const one = async (source_path: string) =>
      (
        await importResults(
          await cli('POST', '/adr/import', { files: [{ source_path, content: '# X\n' }], reserve_above: 5 }),
        )
      )[0]
    expect(await one('docs/adr/0001-x.md')).toMatchObject({ adr_number: 6, renumbered: { from: 1, to: 6 } })
    expect(await one('docs/adr/0002-y.md')).toMatchObject({ adr_number: 7, renumbered: { from: 2, to: 7 } })
  })

  it('a ref to an ADR imported by an earlier request that kept its number resolves', async () => {
    const cli = bearer(s.app, s.tok.secret)
    const [a] = await importResults(
      await cli('POST', '/adr/import', { files: [{ source_path: 'docs/adr/0001-a.md', content: '# A\n' }] }),
    )
    const [b] = await importResults(
      await cli('POST', '/adr/import', {
        files: [
          {
            source_path: 'docs/adr/0002-b.md',
            content: '---\nrelations: [{kind: supports, to: ADR-0001}]\n---\n# B\n',
          },
        ],
      }),
    )
    expect(b).toMatchObject({ status: 'created', adr_number: 2, warnings: [] })
    const supports = await db().select().from(edges).where(eq(edges.kind, 'supports'))
    expect(supports.map((e) => [e.srcId, e.dstId])).toEqual([
      [(b as Result).spoor_id, (a as Result).spoor_id],
    ])
  })
})

describe('lost renumber answer (S8)', () => {
  it('a re-send without spoor_id gets renumbered again instead of number_mismatch', async () => {
    await nativeAdr2()
    const file = { source_path: 'docs/adr/0002-b.md', content: '# Beta\n' }
    const [created] = await importResults(
      await s.call('POST', '/adr/import', { files: [file], reserve_above: 2 }),
    )
    expect(created).toMatchObject({ status: 'created', adr_number: 3, renumbered: { from: 2, to: 3 } })

    const [again] = await importResults(
      await s.call('POST', '/adr/import', { files: [file], reserve_above: 2 }),
    )
    expect(again).toMatchObject({ status: 'unchanged', adr_number: 3, renumbered: { from: 2, to: 3 } })
    expect(again?.warnings.map((w) => w.code)).not.toContain('number_mismatch')

    const viaPush = await push(file.source_path, file.content)
    expect(viaPush.body).toMatchObject({ status: 'unchanged', renumbered: { from: 2, to: 3 } })
    expect(viaPush.body.warnings.map((w) => w.code)).not.toContain('number_mismatch')

    // an updated re-send gets it too
    const changed = await push(file.source_path, '# Beta\n\nmore\n')
    expect(changed.body).toMatchObject({ status: 'updated', renumbered: { from: 2, to: 3 } })

    // with the spoor_id written back the client already knows: no renumbered
    const withId = await push(
      file.source_path,
      `---\nspoor_id: ${(created as Result).spoor_id}\n---\n# Beta\n\nmore\n`,
    )
    expect(withId.body).toMatchObject({ status: 'unchanged', renumbered: null })
  })

  it('a number that differs without renumbered_from stays number_mismatch', async () => {
    const r = await push('docs/adr/0005-e.md', '# E\n')
    expect(r.body).toMatchObject({ status: 'created', adr_number: 5 })
    const other = await push('docs/adr/0005-e.md', '---\nadr: 6\n---\n# E\n')
    expect(other.body.renumbered).toBeNull()
    expect(other.body.warnings).toContainEqual({ code: 'number_mismatch', file: 6, item: 5 })
  })
})

describe('admission control of the push routes (S5)', () => {
  async function gated(env: Record<string, string>) {
    const search = new GatedSearch()
    const { app } = testApp({ ports: stubPorts({ search }), env })
    await addMember(db(), s.other.id, s.dev.id, 'editor')
    const otherTok = await createToken(db(), { projectId: s.other.id, userId: s.dev.id })
    return {
      search,
      call: bearer(app, s.tok.secret),
      viewer: bearer(app, s.roTok.secret),
      other: bearer(app, otherTok.secret, 'other'),
    }
  }
  const doc = (n: number) => ({
    space: 'decisions',
    source_path: `docs/adr/000${n}-x.md`,
    content: `# X${n}\n`,
  })
  const expectBusy = async (r: Response) => {
    expect(r.status).toBe(503)
    expect(r.headers.get('retry-after')).toBe('5')
    expect(await json(r)).toMatchObject({
      error: 'busy',
      message: 'Too many pushes are running; try again shortly.',
      hint: 'Retry after 5 seconds.',
    })
  }

  it('an excess push is 503 busy with Retry-After at once; roles first, the body after; slots are freed', async () => {
    const g = await gated({ SPOOR_PUSH_CONCURRENCY: '1' })
    g.search.arm(1)
    const parked = g.call('POST', '/push', doc(1))
    await g.search.parked(1)

    await expectBusy(await g.call('POST', '/push', doc(2)))
    await expectBusy(await g.call('POST', '/docs/push', { source_path: 'README.md', content: '# R\n' }))
    await expectBusy(
      await g.call('POST', '/adr/push', { source_path: 'docs/adr/0003-x.md', content: '# X\n' }),
    )
    await expectBusy(
      await g.call('POST', '/adr/import', {
        files: [{ source_path: 'docs/adr/0004-x.md', content: '# X\n' }],
      }),
    )
    // 403 wins over busy; an invalid body is busy (admission before validation)
    expect((await g.viewer('POST', '/push', doc(2))).status).toBe(403)
    await expectBusy(await g.call('POST', '/push', { space: 'memories' }))
    // another project is admitted
    expect((await g.other('POST', '/push', doc(1))).status).toBe(200)

    g.search.release()
    expect((await parked).status).toBe(200)
    expect((await g.call('POST', '/push', doc(2))).status).toBe(200)
    // a 400 frees its slot
    expect((await g.call('POST', '/push', { space: 'memories' })).status).toBe(400)
    expect((await g.call('POST', '/push', doc(3))).status).toBe(200)
  })

  it('the total cap counts every project', async () => {
    // max(SPOOR_PUSH_CONCURRENCY, SPOOR_DB_POOL_MAX - 2) = max(1, 1) = 1
    const g = await gated({ SPOOR_PUSH_CONCURRENCY: '1', SPOOR_DB_POOL_MAX: '3' })
    g.search.arm(1)
    const parked = g.call('POST', '/push', doc(1))
    await g.search.parked(1)
    await expectBusy(await g.other('POST', '/push', doc(1)))
    g.search.release()
    expect((await parked).status).toBe(200)
    expect((await g.other('POST', '/push', doc(1))).status).toBe(200)
  })
})

describe('old CLI compatibility', () => {
  it('an adr/import of 100 files without headers answers 200 with 100 results; 101 files are 400', async () => {
    const files = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        source_path: `docs/adr/${String(i + 1).padStart(4, '0')}-x.md`,
        content: `# Choice ${i + 1}\n`,
      }))
    const results = await importResults(await s.call('POST', '/adr/import', { files: files(100) }))
    expect(results).toHaveLength(100)
    expect(results.every((r) => r.status === 'created')).toBe(true)
    expect((await s.call('POST', '/adr/import', { files: files(101) })).status).toBe(400)
  })
})
