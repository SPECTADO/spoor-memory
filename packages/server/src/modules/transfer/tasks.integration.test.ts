// Async Markdown zips (ADR-0041, api.md section 13.4) against the real test database: the routes and their
// permissions, the runner, the open-task cap, cancellation, busy retries, the `exports` job and the round trip
// back through the manifest-less import.
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExportTaskJson, ExportTaskListResponse, ExportTaskResponse } from '@spoor/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { strFromU8 } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testDb, testPool } from '../../../test/db.js'
import { testDatabaseUrl } from '../../../test/db-url.js'
import {
  addMember,
  createAdmin,
  createItem,
  createProject,
  createSharedProject,
  createUser,
  DEFAULT_PASSWORD,
} from '../../../test/factories.js'
import { Client, json, loginAs, TEST_ORIGIN, testApp } from '../../../test/http.js'
import { exportTasks, items, memberships, projects } from '../../db/schema.js'
import { allowPurge, withTx } from '../../lib/db.js'
import type { JobContext } from '../jobs/index.js'
import { entryAllowed, parseArchive } from './archive.js'
import { type ExportTaskOptions, tmpExportsDir } from './tasks.js'
import { readZip } from './zip.js'

const db = () => testDb()

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spoor-exports-it-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function build(exports: ExportTaskOptions = {}, env: Record<string, string> = { SPOOR_BACKUP_DIR: dir }) {
  return testApp({ env, exports: { busyDelayMs: 5, heartbeatMs: 20, ...exports } })
}

async function setup(exports: ExportTaskOptions = {}) {
  const t = build(exports)
  const admin = await createAdmin(db(), { email: 'admin@example.com' })
  const pa = await createUser(db(), { email: 'pa@example.com' })
  const pa2 = await createUser(db(), { email: 'pa2@example.com' })
  const editor = await createUser(db(), { email: 'ed@example.com' })
  const outsider = await createUser(db(), { email: 'out@example.com' })
  const project = await createProject(db(), { slug: 'acme', name: 'Acme' })
  await addMember(db(), project.id, pa.id, 'admin')
  await addMember(db(), project.id, pa2.id, 'admin')
  await addMember(db(), project.id, editor.id, 'editor')
  await createItem(db(), { projectId: project.id, title: 'Session store', slug: 'session-store' })
  await createItem(db(), {
    projectId: project.id,
    space: 'decisions',
    title: 'Use Postgres',
    slug: 'use-postgres',
    status: 'accepted',
  })
  await createItem(db(), { projectId: project.id, space: 'docs', title: 'Runbook', slug: 'runbook' })
  const login = (email: string) => loginAs(t.app, email, DEFAULT_PASSWORD)
  return {
    ...t,
    tasks: t.modules.transfer.exportTasks,
    project,
    admin,
    pa,
    outsider,
    clients: {
      admin: await login(admin.email),
      pa: await login(pa.email),
      pa2: await login(pa2.email),
      editor: await login(editor.email),
      outsider: await login(outsider.email),
    },
  }
}

function jobCtx(): JobContext & { marked: number } {
  const ctx = {
    name: 'exports' as const,
    db: db(),
    log: undefined as never,
    signal: new AbortController().signal,
    deadline: Number.POSITIVE_INFINITY,
    projectIds: [],
    marked: 0,
    renewLease: async () => {},
    markWork: async () => {
      ctx.marked++
    },
    recordProjectRun: async () => {},
  }
  return ctx
}

const create = async (client: Client, slug = 'acme') => client.post(`/api/v1/projects/${slug}/exports`, {})
const taskOf = async (res: Response) => (await json<ExportTaskResponse>(res)).task
const rowOf = async (id: string) => (await db().select().from(exportTasks).where(eq(exportTasks.id, id)))[0]

async function waitFor(cond: () => Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function upload(
  app: ReturnType<typeof testApp>['app'],
  client: Client,
  path: string,
  file: Uint8Array,
) {
  const form = new FormData()
  form.set('file', new File([file as Uint8Array<ArrayBuffer>], 'archive.zip', { type: 'application/zip' }))
  form.set('slug', 'acme-copy')
  form.set('remap_ids', 'true')
  const headers: Record<string, string> = { origin: TEST_ORIGIN, cookie: client.cookieHeader() ?? '' }
  return app.request(`${TEST_ORIGIN}${path}`, { method: 'POST', headers, body: form })
}

describe('export tasks: the live flow', () => {
  it('queued -> ready, downloadable, and the zip re-imports as a manifest-less archive', async () => {
    const s = await setup()
    const res = await create(s.clients.pa)
    expect(res.status).toBe(202)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const queued = await taskOf(res)
    expect(queued).toMatchObject({
      format: 'markdown',
      source: 'live',
      project: { id: s.project.id, slug: 'acme', name: 'Acme' },
      backup_id: null,
      source_project: null,
      requested_by: { id: s.pa.id, label: 'pa@example.com' },
      download_url: null,
    })
    expect(queued.file_name).toMatch(/^spoor-acme-markdown-\d{8}\.zip$/)

    await s.tasks.idle()
    const ready = await taskOf(await s.clients.pa.get(`/api/v1/exports/${queued.id}`))
    expect(ready.status).toBe('ready')
    expect(ready.download_url).toBe(`/api/v1/exports/${queued.id}/download`)
    expect(ready.finished_at).not.toBeNull()
    const expires =
      new Date(ready.expires_at as string).getTime() - new Date(ready.finished_at as string).getTime()
    expect(Math.round(expires / 3_600_000)).toBe(24)

    // the file is in <SPOOR_BACKUP_DIR>/exports, 0600, no partial left
    expect(await readdir(join(dir, 'exports'))).toEqual([`${queued.id}.zip`])
    expect((await stat(join(dir, 'exports', `${queued.id}.zip`))).mode & 0o777).toBe(0o600)

    const dl = await s.clients.pa.get(ready.download_url as string)
    expect(dl.status).toBe(200)
    expect(dl.headers.get('content-type')).toBe('application/zip')
    expect(dl.headers.get('content-disposition')).toBe(`attachment; filename="${ready.file_name}"`)
    const zip = new Uint8Array(await dl.arrayBuffer())
    expect(zip.length).toBe(ready.size_bytes)
    expect(createHash('sha256').update(zip).digest('hex')).toBe(ready.sha256)

    const entries = readZip(zip, entryAllowed)
    expect([...entries.keys()].sort()).toEqual([
      'README.md',
      'decisions/0001-use-postgres.md',
      'docs/runbook.md',
      'memories/session-store.md',
    ])
    const readme = strFromU8(entries.get('README.md') as Uint8Array)
    expect(readme).toContain('- Source: the live project')
    expect(readme).toContain('| ADR-0001 | Use Postgres | accepted |')
    expect(parseArchive(entries).kind).toBe('files')

    // round trip: an instance admin imports the zip as a new project
    const imp = await upload(s.app, s.clients.admin, '/api/v1/projects/import', zip)
    expect(imp.status).toBe(200)
    const [copy] = await db().select().from(projects).where(eq(projects.slug, 'acme-copy'))
    const copied = await db()
      .select({ title: items.title, space: items.space })
      .from(items)
      .where(eq(items.projectId, (copy as { id: string }).id))
    expect(copied.map((i) => `${i.space}:${i.title}`).sort()).toEqual([
      'decisions:Use Postgres',
      'docs:Runbook',
      'memories:Session store',
    ])
  })

  it('lists the caller own tasks (an instance admin sees everyone), newest first', async () => {
    const s = await setup({ autoRun: false })
    const a = await taskOf(await create(s.clients.pa))
    const b = await taskOf(await create(s.clients.pa2))
    const c = await taskOf(await create(s.clients.admin))
    const own = await json<ExportTaskListResponse>(await s.clients.pa.get('/api/v1/projects/acme/exports'))
    expect(own.items.map((t) => t.id)).toEqual([a.id])
    const all = await json<ExportTaskListResponse>(await s.clients.admin.get('/api/v1/projects/acme/exports'))
    expect(all.items.map((t) => t.id)).toEqual([c.id, b.id, a.id])
    // older than 7 days: not listed
    await db()
      .update(exportTasks)
      .set({ createdAt: sql`now() - interval '8 days'` })
      .where(eq(exportTasks.id, a.id))
    const later = await json<ExportTaskListResponse>(await s.clients.pa.get('/api/v1/projects/acme/exports'))
    expect(later.items).toEqual([])
  })
})

describe('export tasks: permissions', () => {
  it('project.transfer for the project routes; the requester or an IA for one task', async () => {
    const s = await setup({ autoRun: false })
    const anon = new Client(s.app)
    expect((await create(anon)).status).toBe(401)
    expect((await create(s.clients.outsider)).status).toBe(404)
    expect((await create(s.clients.editor)).status).toBe(403)
    expect((await s.clients.editor.get('/api/v1/projects/acme/exports')).status).toBe(403)
    expect((await s.clients.outsider.get('/api/v1/projects/acme/exports')).status).toBe(404)

    const t = await taskOf(await create(s.clients.pa))
    for (const path of [`/api/v1/exports/${t.id}`, `/api/v1/exports/${t.id}/download`]) {
      expect((await anon.get(path)).status).toBe(401)
      // another admin of the same project is not the requester
      expect((await s.clients.pa2.get(path)).status).toBe(404)
      expect((await s.clients.outsider.get(path)).status).toBe(404)
    }
    expect((await s.clients.pa2.delete(`/api/v1/exports/${t.id}`)).status).toBe(404)
    expect((await s.clients.admin.get(`/api/v1/exports/${t.id}`)).status).toBe(200)
    // not ready yet: no download, for anyone
    expect((await s.clients.pa.get(`/api/v1/exports/${t.id}/download`)).status).toBe(404)
    expect((await s.clients.admin.get(`/api/v1/exports/${t.id}/download`)).status).toBe(404)
    // ids that are not uuids are 404
    expect((await s.clients.pa.get('/api/v1/exports/..%2F..%2Fetc')).status).toBe(404)
    expect((await s.clients.pa.get('/api/v1/exports/not-a-uuid/download')).status).toBe(404)

    // never a bearer token: the cookie API refuses an Authorization header
    const bearer = await s.clients.pa.get(`/api/v1/exports/${t.id}`, {
      headers: { authorization: 'Bearer spr_x' },
    })
    expect(bearer.status).toBe(400)

    // the format is checked
    const bad = await s.clients.pa.post('/api/v1/projects/acme/exports', { format: 'pdf' })
    expect(bad.status).toBe(400)
  })

  it('access is checked again: the runner and the download refuse a requester who lost it', async () => {
    const s = await setup({ autoRun: false })
    const demote = () =>
      db()
        .update(memberships)
        .set({ role: 'viewer' })
        .where(and(eq(memberships.projectId, s.project.id), eq(memberships.userId, s.pa.id)))
    // queued, then the requester is demoted: the runner reads nothing for them
    const queued = await taskOf(await create(s.clients.pa))
    await demote()
    s.tasks.kick()
    await s.tasks.idle()
    expect(await rowOf(queued.id)).toMatchObject({ status: 'failed' })
    expect((await rowOf(queued.id))?.error).toMatch(/no longer have access/)
    // ready while they were a project admin, then demoted: get and download are 404 for them, not for an IA
    await db()
      .update(memberships)
      .set({ role: 'admin' })
      .where(and(eq(memberships.projectId, s.project.id), eq(memberships.userId, s.pa.id)))
    const ready = await taskOf(await create(s.clients.pa))
    s.tasks.kick()
    await s.tasks.idle()
    expect((await s.clients.pa.get(`/api/v1/exports/${ready.id}/download`)).status).toBe(200)
    await demote()
    expect((await s.clients.pa.get(`/api/v1/exports/${ready.id}`)).status).toBe(404)
    expect((await s.clients.pa.get(`/api/v1/exports/${ready.id}/download`)).status).toBe(404)
    expect((await s.clients.admin.get(`/api/v1/exports/${ready.id}/download`)).status).toBe(200)
  })

  it('the shared space: instance admins only', async () => {
    const s = await setup({ autoRun: false })
    await createSharedProject(db())
    const editor = await createUser(db(), { email: 'shared-ed@example.com', sharedEditor: true })
    const ed = await loginAs(s.app, editor.email, DEFAULT_PASSWORD)
    expect((await create(ed, '_shared')).status).toBe(403)
    const res = await create(s.clients.admin, '_shared')
    expect(res.status).toBe(202)
    expect((await taskOf(res)).file_name).toMatch(/^spoor-_shared-markdown-\d{8}\.zip$/)
  })
})

describe('export tasks: limits, cancellation and failures', () => {
  it('at most 3 open tasks per user (503 too_many_pending), counted per user', async () => {
    const s = await setup({ autoRun: false })
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await taskOf(await create(s.clients.pa))).id)
    const fourth = await create(s.clients.pa)
    expect(fourth.status).toBe(503)
    expect((await json(fourth)).error).toBe('too_many_pending')
    expect((await create(s.clients.pa2)).status).toBe(202)
    // a finished one frees a slot; so does a deleted one
    await db()
      .update(exportTasks)
      .set({ status: 'failed' })
      .where(eq(exportTasks.id, ids[0] as string))
    expect((await create(s.clients.pa)).status).toBe(202)
    expect((await create(s.clients.pa)).status).toBe(503)
    expect((await s.clients.pa.delete(`/api/v1/exports/${ids[1]}`)).status).toBe(204)
    expect((await create(s.clients.pa)).status).toBe(202)
  })

  it('tasks a dead server left running do not count against the cap (the job may be off)', async () => {
    const s = await setup({ autoRun: false })
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await taskOf(await create(s.clients.pa))).id)
    await db()
      .update(exportTasks)
      .set({ status: 'running', heartbeatAt: sql`now() - interval '1 hour'` })
      .where(inArray(exportTasks.id, ids))
    expect((await create(s.clients.pa)).status).toBe(202)
    for (const id of ids) expect((await rowOf(id))?.status).toBe('failed')
  })

  it('parallel creates cannot pass the cap together', async () => {
    const s = await setup({ autoRun: false })
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => create(s.clients.pa)))
    expect(results.map((r) => r.status).sort()).toEqual([202, 202, 202, 503, 503])
  })

  it('DELETE removes the row and the ready file', async () => {
    const s = await setup()
    const t = await taskOf(await create(s.clients.pa))
    await s.tasks.idle()
    expect(await readdir(join(dir, 'exports'))).toEqual([`${t.id}.zip`])
    expect((await s.clients.pa.delete(`/api/v1/exports/${t.id}`)).status).toBe(204)
    expect(await rowOf(t.id)).toBeUndefined()
    expect(await readdir(join(dir, 'exports'))).toEqual([])
    expect((await s.clients.pa.get(`/api/v1/exports/${t.id}`)).status).toBe(404)
  })

  it('DELETE of a running task cancels it: no file, no row', async () => {
    const s = await setup()
    let started = false
    s.tasks.setSourceLoader('live', async (_task, signal) => {
      started = true
      await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
      throw new Error('unreachable')
    })
    const t = await taskOf(await create(s.clients.pa))
    await waitFor(async () => started)
    expect((await rowOf(t.id))?.status).toBe('running')
    expect((await s.clients.pa.delete(`/api/v1/exports/${t.id}`)).status).toBe(204)
    await s.tasks.idle()
    expect(await rowOf(t.id)).toBeUndefined()
    expect(await readdir(dir)).not.toContain('exports')
  })

  it('a task deleted on another replica is cancelled at the next heartbeat', async () => {
    const s = await setup()
    let started = false
    s.tasks.setSourceLoader('live', async (_task, signal) => {
      started = true
      await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
      throw new Error('unreachable')
    })
    const t = await taskOf(await create(s.clients.pa))
    await waitFor(async () => started)
    await db().delete(exportTasks).where(eq(exportTasks.id, t.id))
    await s.tasks.idle()
    expect(await rowOf(t.id)).toBeUndefined()
  })

  it('stop() puts a running task back in the queue', async () => {
    const s = await setup()
    let started = false
    s.tasks.setSourceLoader('live', async (_task, signal) => {
      started = true
      await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
      throw new Error('unreachable')
    })
    const t = await taskOf(await create(s.clients.pa))
    await waitFor(async () => started)
    await s.tasks.stop()
    expect(await rowOf(t.id)).toMatchObject({ status: 'queued', heartbeatAt: null })
  })

  it('retries while another import or export holds the transfer lock, then succeeds', async () => {
    const s = await setup({ busyRetries: 200, busyDelayMs: 10 })
    const client = await testPool().connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock(hashtext('spoor.transfer'))")
      const t = await taskOf(await create(s.clients.pa))
      await new Promise((r) => setTimeout(r, 100))
      expect((await rowOf(t.id))?.status).toBe('running')
      await client.query('COMMIT')
      await s.tasks.idle()
      expect((await rowOf(t.id))?.status).toBe('ready')
    } finally {
      client.release()
    }
  })

  it('fails with a message when the instance stays busy', async () => {
    const s = await setup({ busyRetries: 2, busyDelayMs: 5 })
    const client = await testPool().connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT pg_advisory_xact_lock(hashtext('spoor.transfer'))")
      const t = await taskOf(await create(s.clients.pa))
      await s.tasks.idle()
      const row = await rowOf(t.id)
      expect(row?.status).toBe('failed')
      expect(row?.error).toMatch(/busy/)
      expect(row?.finishedAt).not.toBeNull()
    } finally {
      await client.query('COMMIT')
      client.release()
    }
    // the transfer flag was released: the synchronous export works at once
    expect((await s.clients.pa.get('/api/v1/projects/acme/export')).status).toBe(200)
  })

  it('a deleted project fails the task; the row keeps no project', async () => {
    const s = await setup({ autoRun: false })
    const t = await taskOf(await create(s.clients.pa))
    await withTx(db(), async (tx) => {
      await allowPurge(tx)
      await tx.delete(projects).where(eq(projects.id, s.project.id))
    })
    s.tasks.kick()
    await s.tasks.idle()
    const got = await taskOf(await s.clients.admin.get(`/api/v1/exports/${t.id}`))
    expect(got).toMatchObject({ status: 'failed', project: null, error: 'The project was deleted.' })
    // the requester (no longer a member of anything) still sees the own task
    expect((await s.clients.pa.get(`/api/v1/exports/${t.id}`)).status).toBe(200)
  })

  it('an unexpected error is a generic failure', async () => {
    const s = await setup()
    s.tasks.setSourceLoader('live', async () => {
      throw new Error('secret internals')
    })
    const t = await taskOf(await create(s.clients.pa))
    await s.tasks.idle()
    const row = await rowOf(t.id)
    expect(row?.status).toBe('failed')
    expect(row?.error).not.toContain('secret')
  })
})

describe('export tasks: other sources and the files directory', () => {
  it('a backup source: failed while no loader is registered, ready once one is', async () => {
    const s = await setup()
    const admin = { user: { ...s.admin, isAdmin: true, sharedEditor: false } } as never
    const src = {
      kind: 'backup' as const,
      backupId: '20261120T030000Z-auto',
      sourceProjectId: s.project.id,
      sourceSlug: 'acme',
      fileDate: new Date('2026-11-20T03:00:00Z'),
    }
    const first = (await s.tasks.create(admin, src)).task
    expect(first).toMatchObject({
      source: 'backup',
      project: null,
      backup_id: '20261120T030000Z-auto',
      source_project: { id: s.project.id, slug: 'acme' },
      file_name: 'spoor-acme-markdown-20261120.zip',
    })
    await s.tasks.idle()
    expect((await rowOf(first.id))?.status).toBe('failed')

    // the next slice registers this: here, the live export of the same project stands in for the bundle zip
    s.tasks.setSourceLoader('backup', async () => {
      const r = await s.modules.transfer.transfer.exportForTask(s.project)
      return {
        parsed: parseArchive(readZip(r.zip, entryAllowed)),
        source: { kind: 'backup', backupId: src.backupId, backupCreatedAt: '2026-11-20T03:00:00Z' },
      }
    })
    const second = (await s.tasks.create(admin, src)).task
    await s.tasks.idle()
    const done = await taskOf(await s.clients.admin.get(`/api/v1/exports/${second.id}`))
    expect(done.status).toBe('ready')
    const zip = new Uint8Array(await (await s.clients.admin.get(done.download_url as string)).arrayBuffer())
    const readme = strFromU8(readZip(zip, entryAllowed).get('README.md') as Uint8Array)
    expect(readme).toContain('- Source: backup `20261120T030000Z-auto` (taken 2026-11-20T03:00:00Z)')
    // backup tasks are not in the live project's list
    const list = await json<ExportTaskListResponse>(
      await s.clients.admin.get('/api/v1/projects/acme/exports'),
    )
    expect(list.items).toEqual([])
  })

  it('files go to <SPOOR_BACKUP_DIR>/exports, else to a per-database os.tmpdir()/spoor-exports-<hash>', () => {
    expect(build().modules.transfer.exportTasks.dir).toBe(join(dir, 'exports'))
    const fallback = build({}, {}).modules.transfer.exportTasks.dir
    expect(fallback).toBe(tmpExportsDir(testDatabaseUrl()))
    expect(fallback).toMatch(/spoor-exports-[0-9a-f]{12}$/)
    // per database, never the credentials
    expect(tmpExportsDir('postgres://a:b@db:5432/one')).not.toBe(tmpExportsDir('postgres://a:b@db:5432/two'))
    expect(tmpExportsDir('postgres://a:b@db:5432/one')).toBe(tmpExportsDir('postgres://x:y@db:5432/one'))
  })

  it("the tmpdir fallback must be this user's alone; a linked dir or a linked file is refused", async () => {
    const shared = build({}, {}).modules.transfer.exportTasks
    await shared.ensureDir()
    try {
      await chmod(shared.dir, 0o777)
      await expect(shared.ensureDir()).rejects.toThrow(/not this user's alone/)
    } finally {
      await chmod(shared.dir, 0o700)
    }
    // an exports dir that is a symlink
    await mkdir(join(dir, 'elsewhere'))
    await symlink(join(dir, 'elsewhere'), join(dir, 'linked'))
    const linked = build({ exportsDir: join(dir, 'linked') }).modules.transfer.exportTasks
    await expect(linked.ensureDir()).rejects.toThrow(/not a directory/)
    // a ready task whose file was swapped for a symlink is not served
    const s = await setup()
    const t = await taskOf(await create(s.clients.pa))
    await s.tasks.idle()
    const final = join(dir, 'exports', `${t.id}.zip`)
    await writeFile(join(dir, 'secret.txt'), 'secret')
    await rm(final)
    await symlink(join(dir, 'secret.txt'), final)
    expect((await s.clients.pa.get(`/api/v1/exports/${t.id}/download`)).status).toBe(404)
  })
})

describe('the exports job', () => {
  it('fails stale running tasks, expires old files, prunes rows, sweeps orphans and safety archives', async () => {
    const s = await setup({ autoRun: false })
    const exportsDir = join(dir, 'exports')
    await mkdir(exportsDir, { recursive: true })
    const mk = async (status: ExportTaskJson['status'], over: Record<string, unknown> = {}) => {
      const [row] = await db()
        .insert(exportTasks)
        .values({
          format: 'markdown',
          requestedBy: s.pa.id,
          projectId: s.project.id,
          status,
          ...over,
        } as typeof exportTasks.$inferInsert)
        .returning()
      return row as typeof exportTasks.$inferSelect
    }
    const old = new Date(Date.now() - 20 * 86_400_000)
    const touch = async (name: string, at?: Date) => {
      const p = join(exportsDir, name)
      await writeFile(p, 'x')
      if (at) await utimes(p, at, at)
    }

    const stale = await mk('running', { heartbeatAt: sql`now() - interval '10 minutes'` })
    await touch(`${stale.id}.zip.partial`)
    const fresh = await mk('running', { heartbeatAt: sql`now()` })
    const expired = await mk('ready', { expiresAt: sql`now() - interval '1 minute'` })
    await touch(`${expired.id}.zip`)
    const ready = await mk('ready', { expiresAt: sql`now() + interval '1 hour'` })
    await touch(`${ready.id}.zip`, old)
    const ancient = await mk('failed', { createdAt: sql`now() - interval '31 days'` })
    const recentFailed = await mk('failed')
    const orphanOld = crypto.randomUUID()
    const orphanYoung = crypto.randomUUID()
    await touch(`${orphanOld}.zip`, old)
    await touch(`${orphanYoung}.zip.partial`)
    await touch('safety-acme-20261101T000000Z.zip', old)
    await touch('safety-acme-20261125T000000Z.zip')
    await touch('notes.txt', old)

    const ctx = jobCtx()
    const stats = await s.tasks.jobHandler(ctx)
    expect(stats).toEqual({ stale: 1, expired: 1, pruned: 1, orphan_files: 1, safety_archives: 1, queued: 0 })
    expect(ctx.marked).toBe(1)

    expect(await rowOf(stale.id)).toMatchObject({ status: 'failed' })
    expect((await rowOf(stale.id))?.error).toMatch(/stopped unexpectedly/)
    expect((await rowOf(fresh.id))?.status).toBe('running')
    expect((await rowOf(expired.id))?.status).toBe('expired')
    expect((await rowOf(ready.id))?.status).toBe('ready')
    expect(await rowOf(ancient.id)).toBeUndefined()
    expect(await rowOf(recentFailed.id)).toBeDefined()
    expect((await readdir(exportsDir)).sort()).toEqual(
      [
        `${ready.id}.zip`,
        `${orphanYoung}.zip.partial`,
        'safety-acme-20261125T000000Z.zip',
        'notes.txt',
      ].sort(),
    )

    // nothing to do: no job_runs row
    const quiet = jobCtx()
    await db().delete(exportTasks).where(eq(exportTasks.status, 'running'))
    expect(await s.tasks.jobHandler(quiet)).toMatchObject({ stale: 0, expired: 0, queued: 0 })
    expect(quiet.marked).toBe(0)
  })

  it('picks up queued tasks left behind by a restart', async () => {
    const before = await setup({ autoRun: false })
    const t = await taskOf(await create(before.clients.pa))
    // a fresh app (the restarted server) runs the job
    const after = build()
    const ctx = jobCtx()
    expect(await after.modules.transfer.exportTasks.jobHandler(ctx)).toMatchObject({ queued: 1 })
    await after.modules.transfer.exportTasks.idle()
    expect((await rowOf(t.id))?.status).toBe('ready')
  })

  it('works without an exports directory yet', async () => {
    const s = await setup({ autoRun: false })
    expect(await s.tasks.jobHandler(jobCtx())).toMatchObject({ orphan_files: 0, safety_archives: 0 })
  })
})
