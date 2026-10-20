// Repo mirror: POST /p/:slug/api/push and /adr/import (data-model.md section 7, api.md 7.2 and 7.3,
// deviations I3, I42, I44). decisions/undrafted after a push: src/app.integration.test.ts.
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import {
  addMember,
  createItem,
  createProject,
  createSharedProject,
  createToken,
  createUser,
} from '../../../test/factories.js'
import { Client, json, loginAs, testApp } from '../../../test/http.js'
import { stubPorts } from '../../../test/ports.js'
import { auditLog, edges, itemRevisions, items, projects } from '../../db/schema.js'
import { type ChunkSource, NoopSearchPort, type PreparedChunks } from '../../ports.js'

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
