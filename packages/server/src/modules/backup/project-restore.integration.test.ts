// One project from a backup (api.md section 13.3) against the real test database: restore as a copy, overwrite
// with the original ids, the Markdown zip of a project archive, the checks around them, and that a failed
// overwrite leaves the project exactly as it was. The bundles are written here from real exports
// (buildExport + backup.json), so no pg client tools are needed.
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BACKUP_FORMAT,
  type BackupManifest,
  type BackupManifestProject,
  type BackupSkipReason,
  backupIdFor,
  type ExportTaskResponse,
  type ProjectJson,
  type ProjectRestoreResponse,
} from '@spoor/shared'
import { and, asc, eq, sql } from 'drizzle-orm'
import { strFromU8 } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import {
  addMember,
  createAdmin,
  createItem,
  createProject,
  createSharedProject,
  createToken,
  createUser,
  DEFAULT_PASSWORD,
} from '../../../test/factories.js'
import { Client, json, loginAs, testApp } from '../../../test/http.js'
import type { MemoryJobsPort } from '../../../test/ports.js'
import { auditLog, edges, itemRevisions, items, memberships, projects, tokens } from '../../db/schema.js'
import { allowPurge, withTx } from '../../lib/db.js'
import type { NoopSearchPort } from '../../ports.js'
import { VERSION } from '../../version.js'
import { buildExport, entryAllowed, parseArchive, readZip } from '../transfer/index.js'
import { currentMigration } from './migrations.js'
import { safetyArchiveName } from './project-restore.js'

const db = () => testDb()
const BACKUP_AT = '2026-11-20T03:00:00.000Z'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spoor-project-restore-it-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

type ProjectRow = typeof projects.$inferSelect

/** A bundle with a real per-project archive for each of `archived` and a skipped entry for each of `skipped`. */
async function writeBundle(
  archived: ProjectRow[],
  skipped: { project: ProjectRow; reason: BackupSkipReason }[] = [],
): Promise<{ id: string; dir: string }> {
  const id = backupIdFor(new Date(BACKUP_AT), 'auto')
  const d = join(dir, 'backups', id)
  await mkdir(join(d, 'projects'), { recursive: true })
  await writeFile(join(d, 'database.dump'), '')
  const files: BackupManifest['files'] = [{ path: 'database.dump', size: 0, sha256: sha(new Uint8Array()) }]
  const list: BackupManifestProject[] = []
  for (const p of archived) {
    const out = await buildExport(db(), p, { history: true, version: VERSION, now: new Date(BACKUP_AT) })
    const path = `projects/${p.slug}.zip`
    await writeFile(join(d, path), out.zip)
    files.push({ path, size: out.zip.length, sha256: sha(out.zip) })
    list.push({
      id: p.id,
      slug: p.slug,
      name: p.name,
      kind: p.kind,
      items: out.counts.items,
      archive: path,
      history: true,
    })
  }
  for (const s of skipped) {
    const p = s.project
    list.push({
      id: p.id,
      slug: p.slug,
      name: p.name,
      kind: p.kind,
      items: 0,
      archive: null,
      history: false,
      skipped_reason: s.reason,
    })
  }
  const m: BackupManifest = {
    format: BACKUP_FORMAT,
    id,
    kind: 'auto',
    created_at: BACKUP_AT,
    spoor_version: VERSION,
    migration: currentMigration(),
    pg_server_version: '17.0',
    pg_dump_version: 'pg_dump (PostgreSQL) 17.0',
    files,
    projects: list,
    pinned: false,
    verified_at: BACKUP_AT,
  }
  await writeFile(join(d, 'backup.json'), JSON.stringify(m))
  return { id, dir: d }
}

async function setup(opts: { afterSafetyArchive?: () => Promise<void> } = {}) {
  const t = testApp({
    env: { SPOOR_BACKUP_DIR: dir },
    exports: { heartbeatMs: 20, busyDelayMs: 5 },
    backup: { projectRestore: { afterSafetyArchive: () => opts.afterSafetyArchive?.() } },
  })
  const admin = await createAdmin(db(), { email: 'admin@example.com' })
  const user = await createUser(db(), { email: 'user@example.com' })
  const member = await createUser(db(), { email: 'member@example.com' })
  const shared = await createSharedProject(db())
  const acme = await createProject(db(), { slug: 'acme', name: 'Acme' })
  await addMember(db(), acme.id, member.id, 'editor')
  const m1 = await createItem(db(), { projectId: acme.id, title: 'Session store', slug: 'session-store' })
  const m2 = await createItem(db(), { projectId: acme.id, title: 'Cache TTL', slug: 'cache-ttl' })
  const d1 = await createItem(db(), {
    projectId: acme.id,
    space: 'decisions',
    title: 'Use Postgres',
    slug: 'use-postgres',
    status: 'accepted',
  })
  await db()
    .insert(edges)
    .values({ projectId: acme.id, srcId: m2.id, kind: 'supports', dstRef: m1.id, dstId: m1.id })
  await db().insert(auditLog).values({
    projectId: acme.id,
    actorLabel: 'test',
    via: 'web',
    action: 'item.create',
    itemId: m1.id,
    summary: 'created m1',
  })
  const client = await loginAs(t.app, admin.email, DEFAULT_PASSWORD)
  const fresh = async (id: string) =>
    (await db().select().from(projects).where(eq(projects.id, id)))[0] as ProjectRow
  return {
    ...t,
    admin,
    user,
    member,
    shared,
    acme: await fresh(acme.id),
    fresh,
    m1,
    m2,
    d1,
    client,
    jobs: t.ports.jobs as MemoryJobsPort,
    search: t.ports.search as NoopSearchPort,
  }
}

const restoreUrl = (id: string, projectId: string) => `/api/v1/backups/${id}/projects/${projectId}/restore`
const exportUrl = (id: string, projectId: string) => `/api/v1/backups/${id}/projects/${projectId}/exports`

async function projectItems(projectId: string) {
  return db().select().from(items).where(eq(items.projectId, projectId)).orderBy(asc(items.number))
}

async function revisionCount(projectId: string): Promise<number> {
  const res = await db().execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM item_revisions r JOIN items i ON i.id = r.item_id WHERE i.project_id = ${projectId}`,
  )
  return res.rows[0]?.n ?? 0
}

describe('project restore from a backup: access and checks', () => {
  it('is instance-admin only, cookie only, and validates the ids', async () => {
    const s = await setup()
    const b = await writeBundle([s.acme])
    const anon = new Client(s.app)
    expect((await anon.post(restoreUrl(b.id, s.acme.id), {})).status).toBe(401)
    const user = await loginAs(s.app, s.user.email, DEFAULT_PASSWORD)
    expect((await user.post(restoreUrl(b.id, s.acme.id), {})).status).toBe(403)
    expect((await user.post(exportUrl(b.id, s.acme.id), {})).status).toBe(403)
    const bearer = await s.client.post(
      restoreUrl(b.id, s.acme.id),
      {},
      { headers: { authorization: 'Bearer x' } },
    )
    expect(bearer.status).toBe(400)
    // a non-id, an encoded traversal and an unknown project are 404 before anything is read
    expect((await s.client.post(restoreUrl('..%2F..%2Fetc', s.acme.id), {})).status).toBe(404)
    expect((await s.client.post(restoreUrl(b.id, 'not-a-uuid'), {})).status).toBe(404)
    expect((await s.client.post(restoreUrl(b.id, crypto.randomUUID()), {})).status).toBe(404)
    expect((await s.client.post(exportUrl(b.id, crypto.randomUUID()), {})).status).toBe(404)
    expect((await s.client.post(restoreUrl(b.id.replace('auto', 'manual'), s.acme.id), {})).status).toBe(404)
    // bad body
    const bad = await s.client.post(restoreUrl(b.id, s.acme.id), { mode: 'overwrite', slug: 'x' })
    expect(bad.status).toBe(400)
  })

  it('a project skipped at backup time is 404 with the reason, for restore and export', async () => {
    const s = await setup()
    const b = await writeBundle([], [{ project: s.acme, reason: 'too_large' }])
    for (const url of [restoreUrl(b.id, s.acme.id), exportUrl(b.id, s.acme.id)]) {
      const res = await s.client.post(url, {})
      expect(res.status).toBe(404)
      const body = await json<{ error: string; message: string; details: { skipped_reason: string } }>(res)
      expect(body.details.skipped_reason).toBe('too_large')
      expect(body.message).toMatch(/use full restore/)
    }
  })

  it('an archive that does not match its sha256 is 422 and writes nothing', async () => {
    const s = await setup()
    const b = await writeBundle([s.acme])
    const path = join(b.dir, 'projects', 'acme.zip')
    const bytes = await readFile(path)
    bytes[bytes.length - 30] = (bytes[bytes.length - 30] as number) ^ 0xff
    await writeFile(path, bytes)
    const before = (await db().select().from(projects)).length
    const res = await s.client.post(restoreUrl(b.id, s.acme.id), {})
    expect(res.status).toBe(422)
    expect((await json<{ error: string }>(res)).error).toBe('invalid_archive')
    expect((await db().select().from(projects)).length).toBe(before)
    // missing file: 422 as well
    await rm(path)
    expect((await s.client.post(restoreUrl(b.id, s.acme.id), {})).status).toBe(422)
  })

  it('another heavy backup operation is 503 busy', async () => {
    const s = await setup()
    const b = await writeBundle([s.acme])
    const held = await s.modules.backup.service.lock.acquire({
      operation: 'backup',
      backup_id: b.id,
      kind: 'auto',
      started_at: new Date().toISOString(),
    })
    try {
      const res = await s.client.post(restoreUrl(b.id, s.acme.id), {})
      expect(res.status).toBe(503)
      expect((await json<{ error: string }>(res)).error).toBe('busy')
    } finally {
      await held.release()
    }
    expect((await s.client.post(restoreUrl(b.id, s.acme.id), {})).status).toBe(200)
  })
})

describe('restore as a copy (mode new)', () => {
  it('creates a new project with new ids, the defaults, restored_from and the admin as only member', async () => {
    const s = await setup()
    const b = await writeBundle([s.acme])
    const res = await s.client.post(restoreUrl(b.id, s.acme.id), {})
    expect(res.status).toBe(200)
    const out = await json<ProjectRestoreResponse>(res)
    expect(out).toMatchObject({
      mode: 'new',
      project: { slug: 'acme-r20261120', name: 'Acme (restored 2026-11-20)' },
      counts: { items: 3, edges: 1 },
      safety_archive: null,
      restored_from: { backup_id: b.id, source_slug: 'acme' },
    })
    const copyId = out.project.id
    expect(copyId).not.toBe(s.acme.id)
    // new ids: nothing collides with the live project, which is untouched
    const copied = await projectItems(copyId)
    const live = await projectItems(s.acme.id)
    expect(copied.map((i) => i.slug)).toEqual(live.map((i) => i.slug))
    expect(copied.map((i) => i.number)).toEqual(live.map((i) => i.number))
    for (const c of copied) expect(live.map((l) => l.id)).not.toContain(c.id)
    const e = await db().select().from(edges).where(eq(edges.projectId, copyId))
    expect(e).toHaveLength(1)
    expect(copied.map((i) => i.id)).toContain(e[0]?.dstId)
    expect(await revisionCount(copyId)).toBe(3)
    // members: only the restoring admin; restored_from in the project API
    const mem = await db().select().from(memberships).where(eq(memberships.projectId, copyId))
    expect(mem.map((m) => [m.userId, m.role])).toEqual([[s.admin.id, 'admin']])
    const pj = await json<ProjectJson>(await s.client.get('/api/v1/projects/acme-r20261120'))
    expect(pj.restored_from).toMatchObject({ backup_id: b.id, source_slug: 'acme' })
    const livePj = await json<ProjectJson>(await s.client.get('/api/v1/projects/acme'))
    expect(livePj.restored_from).toBeNull()
    // embeddings: chunk rows in the transaction, embed-pending nudged after the commit
    expect(s.search.indexed.map((i) => i.id).sort()).toEqual(copied.map((i) => i.id).sort())
    expect(s.jobs.enqueued).toContainEqual({ name: 'embed-pending', projectId: copyId })
    // audit
    const audit = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.projectId, copyId), eq(auditLog.action, 'project.restore')))
    expect(audit).toHaveLength(1)
    expect(audit[0]?.data).toMatchObject({ mode: 'new', backup_id: b.id, source_slug: 'acme' })
    expect(audit[0]?.actorUserId).toBe(s.admin.id)

    // again: the default slug moves on; a taken slug given explicitly is 409
    const again = await json<ProjectRestoreResponse>(await s.client.post(restoreUrl(b.id, s.acme.id), {}))
    expect(again.project.slug).toBe('acme-r20261120-2')
    const taken = await s.client.post(restoreUrl(b.id, s.acme.id), { slug: 'acme' })
    expect(taken.status).toBe(409)
    expect((await json<{ error: string }>(taken)).error).toBe('slug_taken')
    const named = await json<ProjectRestoreResponse>(
      await s.client.post(restoreUrl(b.id, s.acme.id), { slug: 'look-here', name: 'Look here' }),
    )
    expect(named.project).toMatchObject({ slug: 'look-here', name: 'Look here' })
  })

  it('works when the live project is gone, and turns _shared into an ordinary project', async () => {
    const s = await setup()
    const guide = await createItem(db(), {
      projectId: s.shared.id,
      title: 'Style guide',
      slug: 'style-guide',
      space: 'docs',
    })
    const glossary = await createItem(db(), { projectId: s.shared.id, title: 'Glossary', slug: 'glossary' })
    // inside _shared, `[[shared:style-guide]]` from the glossary
    await db().insert(edges).values({
      projectId: s.shared.id,
      srcId: glossary.id,
      kind: 'wikilink',
      dstRef: 'shared:style-guide',
      dstId: guide.id,
    })
    const b = await writeBundle([s.acme, await s.fresh(s.shared.id)])
    expect((await s.client.delete('/api/v1/projects/acme?confirm=acme')).status).toBe(204)
    const res = await json<ProjectRestoreResponse>(await s.client.post(restoreUrl(b.id, s.acme.id), {}))
    expect(res.project.slug).toBe('acme-r20261120')
    expect(await projectItems(res.project.id)).toHaveLength(3)

    const sh = await s.client.post(restoreUrl(b.id, s.shared.id), {})
    expect(sh.status).toBe(200)
    const copy = await json<ProjectRestoreResponse>(sh)
    expect(copy.project.slug).toBe('shared-r20261120')
    const row = await s.fresh(copy.project.id)
    expect(row.kind).toBe('project')
    expect((await projectItems(copy.project.id)).map((i) => i.title).sort()).toEqual([
      'Glossary',
      'Style guide',
    ])
    // its [[shared:...]] link still means the live shared space: said in a note
    expect(copy.notes).toContainEqual(
      expect.stringMatching(/^1 link\(s\) written \[\[shared:\.\.\.\]\] in this copy/),
    )
  })
})

describe('overwrite (mode overwrite)', () => {
  async function changedAfterBackup() {
    const s = await setup()
    const b = await writeBundle([s.acme])
    // after the backup: m1 edited, a new item, a new member and a new token
    await db().update(items).set({ title: 'Edited later' }).where(eq(items.id, s.m1.id))
    const m4 = await createItem(db(), { projectId: s.acme.id, title: 'Written later', slug: 'later' })
    const later = await createUser(db(), { email: 'later@example.com' })
    await addMember(db(), s.acme.id, later.id, 'viewer')
    const token = await createToken(db(), { projectId: s.acme.id })
    await db().update(projects).set({ description: 'kept' }).where(eq(projects.id, s.acme.id))
    return { ...s, b, m4, later, token }
  }

  const overwrite = (password = DEFAULT_PASSWORD, confirm = 'acme') => ({
    mode: 'overwrite',
    password,
    confirm,
  })

  it('needs the admin password and the typed slug (403 confirmation_failed)', async () => {
    const s = await changedAfterBackup()
    for (const body of [
      overwrite('wrong-password'),
      overwrite(DEFAULT_PASSWORD, 'ACME'),
      overwrite(DEFAULT_PASSWORD, ''),
    ]) {
      const res = await s.client.post(restoreUrl(s.b.id, s.acme.id), body)
      expect(res.status).toBe(403)
      expect((await json<{ error: string }>(res)).error).toBe('confirmation_failed')
    }
    expect((await s.client.post(restoreUrl(s.b.id, s.acme.id), { mode: 'overwrite' })).status).toBe(400)
    expect(await projectItems(s.acme.id)).toHaveLength(4)
  })

  it('replaces the items with the original ids and keeps the project row, members, tokens and audit', async () => {
    const s = await changedAfterBackup()
    const auditBefore = await db().select().from(auditLog).where(eq(auditLog.projectId, s.acme.id))
    const res = await s.client.post(restoreUrl(s.b.id, s.acme.id), overwrite())
    expect(res.status).toBe(200)
    const out = await json<ProjectRestoreResponse>(res)
    expect(out).toMatchObject({
      mode: 'overwrite',
      project: { id: s.acme.id, slug: 'acme', name: 'Acme' },
      counts: { items: 3, edges: 1, audit: 0 },
      restored_from: null,
    })
    const after = await projectItems(s.acme.id)
    expect(after.map((i) => i.id).sort()).toEqual([s.m1.id, s.m2.id, s.d1.id].sort())
    expect(after.find((i) => i.id === s.m1.id)?.title).toBe('Session store')
    expect(after.map((i) => i.id)).not.toContain(s.m4.id)
    expect(await revisionCount(s.acme.id)).toBe(3)
    const e = await db().select().from(edges).where(eq(edges.projectId, s.acme.id))
    expect(e.map((x) => [x.srcId, x.dstId])).toEqual([[s.m2.id, s.m1.id]])
    // the project row and what hangs on it stay
    const row = await s.fresh(s.acme.id)
    expect(row.description).toBe('kept')
    expect(row.restoredFrom).toBeNull()
    // numbers a project once used are never reused (m4 had number 4)
    expect(row.nextItemNumber).toBeGreaterThanOrEqual(5)
    const mem = await db().select().from(memberships).where(eq(memberships.projectId, s.acme.id))
    expect(mem.map((m) => m.userId).sort()).toEqual([s.member.id, s.later.id].sort())
    expect(await db().select().from(tokens).where(eq(tokens.id, s.token.id))).toHaveLength(1)
    // audit: the old rows stay, the archive's are not copied in again, one project.restore is added
    const auditAfter = await db().select().from(auditLog).where(eq(auditLog.projectId, s.acme.id))
    expect(auditAfter.map((a) => a.id)).toEqual(expect.arrayContaining(auditBefore.map((a) => a.id)))
    const added = auditAfter.filter((a) => !auditBefore.some((x) => x.id === a.id))
    expect(added.map((a) => a.action)).toEqual(['project.restore'])
    expect(added[0]?.data).toMatchObject({
      mode: 'overwrite',
      backup_id: s.b.id,
      safety_archive: out.safety_archive,
    })
    // embeddings re-queued
    expect(s.search.indexed.map((i) => i.id).sort()).toEqual(after.map((i) => i.id).sort())
    expect(s.jobs.enqueued).toContainEqual({ name: 'embed-pending', projectId: s.acme.id })

    // the safety archive holds the project as it was (incl. m4), 0600, in <dir>/exports
    expect(out.safety_archive).toMatch(/^safety-acme-\d{8}T\d{9}Z\.zip$/)
    const safetyPath = join(dir, 'exports', out.safety_archive as string)
    expect((await stat(safetyPath)).mode & 0o777).toBe(0o600)
    const safety = parseArchive(readZip(await readFile(safetyPath), entryAllowed))
    expect(safety.kind).toBe('lossless')
    if (safety.kind === 'lossless') {
      expect(safety.items.map((i) => i.m.id)).toContain(s.m4.id)
    }
  })

  it('the append-only guard is only lifted inside the restore transaction', async () => {
    const s = await changedAfterBackup()
    expect((await s.client.post(restoreUrl(s.b.id, s.acme.id), overwrite())).status).toBe(200)
    await expect(db().delete(itemRevisions).where(eq(itemRevisions.itemId, s.m1.id))).rejects.toThrow()
    await expect(db().delete(auditLog).where(eq(auditLog.projectId, s.acme.id))).rejects.toThrow()
  })

  it('an id collision rolls everything back: the project is intact and the safety archive is removed', async () => {
    const s = await changedAfterBackup()
    // m2 left acme after the backup, and its id now belongs to an item of another project
    const other = await createProject(db(), { slug: 'other' })
    await withTx(db(), async (tx) => {
      await allowPurge(tx)
      await tx.delete(items).where(eq(items.id, s.m2.id))
    })
    const [cur] = await db().select().from(items).where(eq(items.id, s.m1.id))
    await db()
      .insert(items)
      .values({
        ...(cur as typeof items.$inferSelect),
        id: s.m2.id,
        projectId: other.id,
        number: 1,
        slug: 'taken',
      })
    const before = await projectItems(s.acme.id)
    const revBefore = await revisionCount(s.acme.id)
    const auditBefore = (await db().select().from(auditLog).where(eq(auditLog.projectId, s.acme.id))).length

    const res = await s.client.post(restoreUrl(s.b.id, s.acme.id), overwrite())
    expect(res.status).toBe(409)
    expect((await json<{ error: string }>(res)).error).toBe('id_collision')
    expect(await projectItems(s.acme.id)).toEqual(before)
    expect(await revisionCount(s.acme.id)).toBe(revBefore)
    expect((await db().select().from(auditLog).where(eq(auditLog.projectId, s.acme.id))).length).toBe(
      auditBefore,
    )
    expect(await readdir(join(dir, 'exports')).catch(() => [])).toEqual([])
    expect(s.jobs.enqueued).toEqual([])
    // the transfer flag and the heavy lock are free again
    expect(s.modules.backup.service.lock.current).toBeNull()
    expect((await s.client.post(restoreUrl(s.b.id, s.acme.id), {})).status).toBe(200)
  })

  it('a write between the safety archive and the transaction stops the overwrite (503 busy, nothing lost)', async () => {
    let write: (() => Promise<void>) | null = null
    const s = await setup({ afterSafetyArchive: async () => write?.() })
    const b = await writeBundle([s.acme])
    write = async () => {
      // an agent edits an item after the safety archive was read
      await db().update(items).set({ title: 'Edited in the gap', revision: 2 }).where(eq(items.id, s.m1.id))
    }
    const res = await s.client.post(restoreUrl(b.id, s.acme.id), overwrite())
    expect(res.status, await res.clone().text()).toBe(503)
    expect((await json<{ error: string }>(res)).error).toBe('busy')
    const [m1] = await db().select().from(items).where(eq(items.id, s.m1.id))
    expect(m1?.title).toBe('Edited in the gap')
    expect(await readdir(join(dir, 'exports')).catch(() => [])).toEqual([])
    expect(s.modules.backup.service.lock.current).toBeNull()
    // without a write in between it goes through
    write = null
    expect((await s.client.post(restoreUrl(b.id, s.acme.id), overwrite())).status).toBe(200)
  })

  it('refuses _shared (403) and a project that no longer exists (404)', async () => {
    const s = await setup()
    const b = await writeBundle([s.acme, await s.fresh(s.shared.id)])
    const sh = await s.client.post(restoreUrl(b.id, s.shared.id), overwrite(DEFAULT_PASSWORD, '_shared'))
    expect(sh.status).toBe(403)
    expect((await json<{ error: string }>(sh)).error).toBe('forbidden')
    expect((await s.client.delete('/api/v1/projects/acme?confirm=acme')).status).toBe(204)
    expect((await s.client.post(restoreUrl(b.id, s.acme.id), overwrite())).status).toBe(404)
  })
})

describe('Markdown zip of a project in a backup', () => {
  it('queues a backup-source task that the runner turns into a downloadable zip', async () => {
    const s = await setup()
    const b = await writeBundle([s.acme])
    const res = await s.client.post(exportUrl(b.id, s.acme.id), {})
    expect(res.status).toBe(202)
    const { task } = await json<ExportTaskResponse>(res)
    expect(task).toMatchObject({
      source: 'backup',
      backup_id: b.id,
      project: null,
      source_project: { id: s.acme.id, slug: 'acme' },
    })
    await s.modules.transfer.exportTasks.idle()
    const done = await json<ExportTaskResponse>(await s.client.get(`/api/v1/exports/${task.id}`))
    expect(done.task.status).toBe('ready')
    const dl = await s.client.get(`/api/v1/exports/${task.id}/download`)
    expect(dl.status).toBe(200)
    const zip = readZip(new Uint8Array(await dl.arrayBuffer()), () => true)
    expect([...zip.keys()]).toContain('README.md')
    expect([...zip.keys()]).toContain('memories/session-store.md')
    expect(strFromU8(zip.get('README.md') as Uint8Array)).toContain(b.id)
  })

  it('a corrupted archive makes the task fail with a readable message', async () => {
    const s = await setup()
    const b = await writeBundle([s.acme])
    await writeFile(join(b.dir, 'projects', 'acme.zip'), 'not a zip')
    const { task } = await json<ExportTaskResponse>(await s.client.post(exportUrl(b.id, s.acme.id), {}))
    await s.modules.transfer.exportTasks.idle()
    const done = await json<ExportTaskResponse>(await s.client.get(`/api/v1/exports/${task.id}`))
    expect(done.task.status).toBe('failed')
    expect(done.task.error).toMatch(/checksum/)
  })
})

describe('safetyArchiveName', () => {
  it('is a plain file name the exports job recognises', () => {
    expect(safetyArchiveName('acme', new Date('2026-11-26T10:15:30.123Z'))).toBe(
      'safety-acme-20261126T101530123Z.zip',
    )
  })
})
