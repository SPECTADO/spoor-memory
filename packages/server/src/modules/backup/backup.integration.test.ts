// Backup bundles, the catalog, settings, the scheduled job, pruning and the /api/v1/backups routes against
// the real test database (api.md section 13.1, ADR-0038, ADR-0040). Bundles go to a fresh temp directory per
// test; pg_dump / pg_restore come from test/pg-tools.ts (real binaries, else the docker shim, else the tests
// that need them are skipped with the reason).
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BACKUP_FORMAT,
  type BackupKind,
  type BackupListResponse,
  type BackupManifest,
  type BackupProjectsResponse,
  type BackupVerifyResponse,
  backupIdFor,
} from '@spoor/shared'
import { sql } from 'drizzle-orm'
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
import { resolveTestPgTools } from '../../../test/pg-tools.js'
import { auditLog } from '../../db/schema.js'
import type { JobContext } from '../jobs/index.js'
import { HeavyLock } from './lock.js'
import { currentMigration } from './migrations.js'
import { PgTools } from './pgtools.js'
import type { BackupServiceOptions } from './service.js'

const pg = resolveTestPgTools()
if (!pg.available) console.warn(`[backup.integration] pg tool tests skipped: ${pg.reason}`)

const db = () => testDb()
const EMPTY_SHA = createHash('sha256').update('').digest('hex')
const NOW = new Date('2026-11-26T10:00:00Z')

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spoor-backup-it-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function build(opts: { backupDir?: string | null; backup?: BackupServiceOptions } = {}) {
  const backupDir = opts.backupDir === undefined ? dir : opts.backupDir
  const env: Record<string, string> = backupDir ? { SPOOR_BACKUP_DIR: backupDir } : {}
  const tools = pg.available ? pg.tools : new PgTools({ binDir: '/nonexistent-pg-bin' })
  return testApp({ env, backup: { tools, busyDelayMs: 5, ...opts.backup } })
}

async function setup(opts: Parameters<typeof build>[0] = {}) {
  const t = build(opts)
  const admin = await createAdmin(db(), { email: 'admin@example.com' })
  const user = await createUser(db(), { email: 'user@example.com' })
  const client = await loginAs(t.app, admin.email, DEFAULT_PASSWORD)
  return { ...t, admin, user, client, service: t.modules.backup.service }
}

/** A catalog entry without real files (retention and listing only care about backup.json). */
async function fakeBundle(
  root: string,
  at: string,
  kind: BackupKind,
  over: Partial<BackupManifest> = {},
): Promise<string> {
  const id = backupIdFor(new Date(at), kind)
  const d = join(root, 'backups', id)
  await mkdir(d, { recursive: true })
  await writeFile(join(d, 'database.dump'), '')
  const m: BackupManifest = {
    format: BACKUP_FORMAT,
    id,
    kind,
    created_at: new Date(at).toISOString(),
    spoor_version: '0.8.0',
    migration: currentMigration(),
    pg_server_version: '17.0',
    pg_dump_version: 'pg_dump (PostgreSQL) 17.0',
    files: [{ path: 'database.dump', size: 0, sha256: EMPTY_SHA }],
    projects: [],
    pinned: false,
    verified_at: new Date(at).toISOString(),
    ...over,
  }
  await writeFile(join(d, 'backup.json'), JSON.stringify(m))
  return id
}

const ids = async (root: string) => (await readdir(join(root, 'backups'))).sort()

function jobCtx(): JobContext & { marked: number } {
  const ctx = {
    name: 'backup' as const,
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

async function auditActions(): Promise<string[]> {
  const rows = await db().select({ action: auditLog.action }).from(auditLog).orderBy(auditLog.id)
  return rows.map((r) => r.action).filter((a) => a.startsWith('backup.'))
}

describe('permissions and routing', () => {
  it('only instance admins on the cookie surface; bearer tokens and other users are refused', async () => {
    const { app, client, user } = await setup()
    expect((await client.get('/api/v1/backups')).status).toBe(200)
    const anon = new Client(app)
    expect((await anon.get('/api/v1/backups')).status).toBe(401)
    const other = await loginAs(app, user.email, DEFAULT_PASSWORD)
    for (const [method, path] of [
      ['GET', '/api/v1/backups'],
      ['PUT', '/api/v1/backups/settings'],
      ['POST', '/api/v1/backups'],
      ['PATCH', '/api/v1/backups/20261126T030000Z-auto'],
      ['DELETE', '/api/v1/backups/20261126T030000Z-auto'],
      ['POST', '/api/v1/backups/20261126T030000Z-auto/verify'],
      ['GET', '/api/v1/backups/20261126T030000Z-auto/projects'],
    ] as const) {
      const res = await other.request(method, path, { body: method === 'PUT' ? {} : undefined })
      expect(res.status, `${method} ${path}`).toBe(403)
    }
    // a project admin is not enough
    const p = await createProject(db(), { slug: 'acme' })
    await addMember(db(), p.id, user.id, 'admin')
    expect((await other.get('/api/v1/backups')).status).toBe(403)
    // a bearer token never reaches the cookie API, not even with an admin's session alongside
    const t = await createToken(db(), { projectId: p.id, userId: user.id })
    const res = await client.get('/api/v1/backups', { headers: { authorization: `Bearer ${t.secret}` } })
    expect(res.status).toBe(400)
    expect(
      (await app.request(`/p/acme/api/backups`, { headers: { authorization: `Bearer ${t.secret}` } })).status,
    ).toBe(404)
  })

  it('ids are validated on every route: traversal and non-ids are 404, invalid bundles are invisible', async () => {
    const { client, service } = await setup()
    await mkdir(join(dir, 'backups', '20261120T030000Z-auto'), { recursive: true }) // no backup.json
    await writeFile(join(dir, 'secret.txt'), 'x')
    // (`..` and `%2e%2e` are resolved by the URL parser before routing; encoded slashes reach the router)
    for (const id of [
      '..%2F..%2Fsecret.txt',
      '%2e%2e%2Fsecret.txt',
      '20261120T030000Z-auto%2F..',
      '20261120T030000Z-other',
      '20261120T030000Z-auto',
      'backup.json',
    ]) {
      expect((await client.patch(`/api/v1/backups/${id}`, { pinned: true })).status, id).toBe(404)
      expect((await client.delete(`/api/v1/backups/${id}`)).status, id).toBe(404)
      expect((await client.get(`/api/v1/backups/${id}/projects`)).status, id).toBe(404)
    }
    // the directory without a backup.json is neither listed nor deleted
    const list = await json<BackupListResponse>(await client.get('/api/v1/backups'))
    expect(list.items).toEqual([])
    expect(await ids(dir)).toEqual(['20261120T030000Z-auto'])
    expect(await readFile(join(dir, 'secret.txt'), 'utf8')).toBe('x')
    // ... and pruning leaves it alone
    await service.prune(dir, {
      enabled: true,
      time_utc: '03:00',
      tiers: [{ every: '24h', keep: 1 }],
      project_archives: true,
    })
    expect(await ids(dir)).toEqual(['20261120T030000Z-auto'])
  })
})

describe('unavailable', () => {
  it('without SPOOR_BACKUP_DIR: the list and settings work, everything else is 409 backups_unavailable', async () => {
    const { client } = await setup({ backupDir: null })
    const list = await json<BackupListResponse>(await client.get('/api/v1/backups'))
    expect(list.status).toMatchObject({ available: false, reason: 'no_backup_dir', dir: null, running: null })
    expect(list.status.next_due_at).toBeNull()
    expect(list.settings).toEqual({
      enabled: false,
      time_utc: '03:00',
      tiers: [
        { every: '24h', keep: 3 },
        { every: '7d', keep: 2 },
      ],
      project_archives: true,
    })
    expect(list.items).toEqual([])
    const post = await client.post('/api/v1/backups')
    expect(post.status).toBe(409)
    expect(await json(post)).toMatchObject({
      error: 'backups_unavailable',
      details: { reason: 'no_backup_dir' },
    })
    const put = await client.request('PUT', '/api/v1/backups/settings', { body: { enabled: true } })
    expect(put.status).toBe(200)
    expect(await json(put)).toMatchObject({
      settings: { enabled: true, time_utc: '03:00' },
      next_due_at: null,
    })
    expect(await auditActions()).toEqual(['backup.settings'])
  })

  it('missing pg tools: status says so, the app keeps working, a backup is refused', async () => {
    const { client } = await setup({ backup: { tools: new PgTools({ binDir: '/nonexistent-pg-bin' }) } })
    const list = await json<BackupListResponse>(await client.get('/api/v1/backups'))
    expect(list.status).toMatchObject({
      available: false,
      reason: 'pg_tools_missing',
      dir,
      pg_dump_version: null,
    })
    expect(list.status.reason_message).toMatch(/not found: pg_dump, pg_restore, psql in \/nonexistent-pg-bin/)
    expect(list.status.free_bytes).toBeGreaterThan(0)
    expect((await client.post('/api/v1/backups')).status).toBe(409)
    const verify = await client.post('/api/v1/backups/20261126T030000Z-auto/verify')
    expect(verify.status).toBe(404)
  })

  it('a directory that cannot be written is dir_not_writable', async () => {
    const file = join(dir, 'not-a-dir')
    await writeFile(file, 'x')
    const { client } = await setup({ backupDir: file })
    const list = await json<BackupListResponse>(await client.get('/api/v1/backups'))
    expect(list.status).toMatchObject({ available: false, reason: 'dir_not_writable' })
  })
})

describe('settings', () => {
  it('PUT validates, stores, audits and reports the next slot', async () => {
    const { client } = await setup({ backup: { now: () => NOW } })
    const bad = await client.request('PUT', '/api/v1/backups/settings', {
      body: {
        tiers: [
          { every: '24h', keep: 3 },
          { every: '24h', keep: 2 },
        ],
      },
    })
    expect(bad.status).toBe(400)
    expect(
      (await client.request('PUT', '/api/v1/backups/settings', { body: { time_utc: '24:00' } })).status,
    ).toBe(400)
    expect((await client.request('PUT', '/api/v1/backups/settings', { body: { extra: 1 } })).status).toBe(400)
    const put = await client.request('PUT', '/api/v1/backups/settings', {
      body: { enabled: true, time_utc: '02:30', tiers: [{ every: '48h', keep: 4 }] },
    })
    expect(put.status).toBe(200)
    const body = await json<{ settings: unknown; next_due_at: string | null }>(put)
    expect(body.settings).toEqual({
      enabled: true,
      time_utc: '02:30',
      tiers: [{ every: '48h', keep: 4 }],
      project_archives: true,
    })
    // 11-26 is an odd epoch day: the current 48h slot was 11-25 02:30 and no backup exists yet, so it is due
    if (pg.available) expect(body.next_due_at).toBe('2026-11-25T02:30:00.000Z')
    const row = await db().execute<{ value: unknown }>(
      sql`SELECT value FROM instance_settings WHERE key = 'backup'`,
    )
    expect(row.rows[0]?.value).toEqual(body.settings)
    const audit = await db().select().from(auditLog).where(sql`action = 'backup.settings'`)
    expect(audit[0]).toMatchObject({ projectId: null, via: 'web', data: body.settings })
  })
})

describe.skipIf(!pg.available)('bundles through the pg tools', () => {
  async function seed() {
    const shared = await createSharedProject(db())
    const acme = await createProject(db(), { slug: 'acme', name: 'Acme' })
    await createItem(db(), { projectId: acme.id, title: 'Postgres pooling', body: 'We use pgbouncer.' })
    await createItem(db(), { projectId: acme.id, space: 'docs', title: 'Intro', body: '# Intro\n\nHello.\n' })
    await createItem(db(), { projectId: shared.id, title: 'Shared fact', body: 'Shared.' })
    return { shared, acme }
  }

  it('POST /backups writes a verified bundle: dump + one archive per project + backup.json', async () => {
    const { client, service } = await setup()
    const { acme, shared } = await seed()
    const res = await client.post('/api/v1/backups')
    expect(res.status).toBe(202)
    const started = await json<{ backup: { id: string; kind: string; started_at: string } }>(res)
    expect(started.backup.id).toMatch(/^\d{8}T\d{6}Z-manual$/)
    await service.idle()

    const list = await json<BackupListResponse>(await client.get('/api/v1/backups'))
    expect(list.status).toMatchObject({ available: true, running: null, overdue: false })
    expect(list.status.pg_dump_version).toMatch(/^pg_dump \(PostgreSQL\) 1\d/)
    expect(list.status.last_good_at).toBe(started.backup.started_at)
    expect(list.items).toHaveLength(1)
    const item = list.items[0]
    expect(item).toMatchObject({
      id: started.backup.id,
      kind: 'manual',
      pinned: false,
      projects: 2,
      projects_skipped: 0,
      restorable: true,
      protected: true,
      migration: currentMigration(),
    })
    expect(item?.verified_at).not.toBeNull()

    const bdir = join(dir, 'backups', started.backup.id)
    expect((await readdir(bdir)).sort()).toEqual(['backup.json', 'database.dump', 'projects'])
    expect((await readdir(join(bdir, 'projects'))).sort()).toEqual(['_shared.zip', 'acme.zip'])
    expect((await stat(join(bdir, 'database.dump'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(bdir, 'backup.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(bdir)).mode & 0o777).toBe(0o700)
    expect(await readdir(join(dir, '.tmp'))).toEqual([])

    const manifest = JSON.parse(await readFile(join(bdir, 'backup.json'), 'utf8')) as BackupManifest
    expect(manifest).toMatchObject({ format: 'spoor-backup/1', id: started.backup.id, kind: 'manual' })
    expect(manifest.projects).toEqual(
      expect.arrayContaining([
        {
          id: acme.id,
          slug: 'acme',
          name: 'Acme',
          kind: 'project',
          items: 2,
          archive: 'projects/acme.zip',
          history: true,
        },
        {
          id: shared.id,
          slug: '_shared',
          name: shared.name,
          kind: 'shared',
          items: 1,
          archive: 'projects/_shared.zip',
          history: true,
        },
      ]),
    )
    for (const f of manifest.files) {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(join(bdir, f.path))) hash.update(chunk as Buffer)
      expect(hash.digest('hex'), f.path).toBe(f.sha256)
    }

    // the dump holds the schema and data, but no rows of the excluded tables
    const tools = pg.available ? pg.tools : (undefined as never)
    const script = await tools.run('pg_restore', ['-f', '-'], {
      stdin: createReadStream(join(bdir, 'database.dump')),
      maxStdoutBytes: 64 * 1024 * 1024,
    })
    const text = script.stdout.toString('utf8')
    expect(text).toMatch(/COPY public\.items /)
    expect(text).toMatch(/COPY drizzle\.__drizzle_migrations /)
    expect(text).toMatch(/CREATE TABLE public\.sessions /)
    expect(text).not.toMatch(/COPY public\.sessions /)
    expect(text).not.toMatch(/COPY public\.request_log /)
    expect(text).not.toMatch(/CREATE EXTENSION/)

    expect(await auditActions()).toEqual(['backup.create'])
  })

  it('verify, pin, projects and delete', async () => {
    const { client, service } = await setup()
    const { acme } = await seed()
    const started = await json<{ backup: { id: string } }>(await client.post('/api/v1/backups'))
    await service.idle()
    const id = started.backup.id

    const ok = await json<BackupVerifyResponse>(await client.post(`/api/v1/backups/${id}/verify`))
    expect(ok).toMatchObject({ ok: true, problems: [] })

    const pin = await client.patch(`/api/v1/backups/${id}`, { pinned: true })
    expect(pin.status).toBe(200)
    expect(await json(pin)).toMatchObject({ id, pinned: true })
    expect((await client.patch(`/api/v1/backups/${id}`, { pinned: 'yes' })).status).toBe(400)

    const projectsRes = await json<BackupProjectsResponse>(await client.get(`/api/v1/backups/${id}/projects`))
    const day = id.slice(0, 8)
    // a project already holds the suggested slug: the next free one is offered
    await createProject(db(), { slug: `acme-r${day}` })
    const again = await json<BackupProjectsResponse>(await client.get(`/api/v1/backups/${id}/projects`))
    const acmeJson = projectsRes.projects.find((p) => p.slug === 'acme')
    expect(acmeJson).toMatchObject({
      id: acme.id,
      restorable: true,
      skipped_reason: null,
      live: { slug: 'acme', name: 'Acme' },
      can_overwrite: true,
      suggested_slug: `acme-r${day}`,
    })
    expect(acmeJson?.suggested_name).toMatch(/^Acme \(restored \d{4}-\d{2}-\d{2}\)$/)
    expect(again.projects.find((p) => p.slug === 'acme')?.suggested_slug).toBe(`acme-r${day}-2`)
    const sharedJson = projectsRes.projects.find((p) => p.slug === '_shared')
    expect(sharedJson).toMatchObject({ can_overwrite: false, suggested_slug: `shared-r${day}` })

    // corrupt an archive: verify reports it and clears verified_at
    await writeFile(join(dir, 'backups', id, 'projects', 'acme.zip'), 'garbage')
    const bad = await json<BackupVerifyResponse>(await client.post(`/api/v1/backups/${id}/verify`))
    expect(bad.ok).toBe(false)
    expect(bad.problems).toEqual(['projects/acme.zip: size mismatch'])
    expect(bad.item.verified_at).toBeNull()

    // a corrupted dump of the same size
    const dumpPath = join(dir, 'backups', id, 'database.dump')
    const dump = await readFile(dumpPath)
    const mid = Math.floor(dump.length / 2)
    dump[mid] = (dump[mid] as number) ^ 0xff
    await writeFile(dumpPath, dump)
    const bad2 = await json<BackupVerifyResponse>(await client.post(`/api/v1/backups/${id}/verify`))
    expect(bad2.problems).toContain('database.dump: sha256 mismatch')

    // damage pg_restore cannot decode: the changed file is still named as such, pg_restore's error is extra
    dump.fill(0, mid, Math.min(dump.length, mid + 4096))
    await writeFile(dumpPath, dump)
    const bad3 = await json<BackupVerifyResponse>(await client.post(`/api/v1/backups/${id}/verify`))
    expect(bad3.problems).toContain('database.dump: sha256 mismatch')
    expect(bad3.problems.some((p) => p.startsWith('database.dump: pg_restore cannot read it'))).toBe(true)

    expect((await client.delete(`/api/v1/backups/${id}`)).status).toBe(204)
    expect(await ids(dir)).toEqual([])
    expect((await client.delete(`/api/v1/backups/${id}`)).status).toBe(404)
    expect(await auditActions()).toEqual(['backup.create', 'backup.pin', 'backup.delete'])
  })

  it('one heavy operation at a time, across processes: a second one is 503 busy, the list shows it', async () => {
    const { client, service, config } = await setup()
    await seed()
    // another container holds the lock
    const other = new HeavyLock(config.DATABASE_URL)
    const held = await other.acquire({
      operation: 'verify',
      backup_id: '20261120T030000Z-auto',
      kind: 'auto',
      started_at: '2026-11-26T09:00:00.000Z',
    })
    try {
      const res = await client.post('/api/v1/backups')
      expect(res.status).toBe(503)
      expect(await json(res)).toMatchObject({ error: 'busy' })
      const list = await json<BackupListResponse>(await client.get('/api/v1/backups'))
      expect(list.status.running).toEqual({
        operation: 'verify',
        backup_id: '20261120T030000Z-auto',
        kind: 'auto',
        started_at: '2026-11-26T09:00:00.000Z',
      })
      // the bundle in use cannot be deleted
      await fakeBundle(dir, '2026-11-20T03:00:00Z', 'auto')
      expect((await client.delete('/api/v1/backups/20261120T030000Z-auto')).status).toBe(503)
      // the scheduled job stays quiet while busy
      await client.request('PUT', '/api/v1/backups/settings', { body: { enabled: true } })
      const ctx = jobCtx()
      expect(await service.jobHandler(ctx)).toEqual({})
      expect(ctx.marked).toBe(0)
    } finally {
      await held.release()
    }
    // in-process: a manual backup running refuses a second one
    expect((await client.post('/api/v1/backups')).status).toBe(202)
    expect((await client.post('/api/v1/backups')).status).toBe(503)
    await service.idle()
    expect((await client.post('/api/v1/backups')).status).toBe(202)
    await service.idle()
    const list = await json<BackupListResponse>(await client.get('/api/v1/backups'))
    expect(list.items.filter((i) => i.kind === 'manual')).toHaveLength(2)
  })

  it('project archives off: every project is recorded as skipped (disabled), the dump is still there', async () => {
    const { client, service } = await setup()
    await seed()
    await client.request('PUT', '/api/v1/backups/settings', { body: { project_archives: false } })
    const started = await json<{ backup: { id: string } }>(await client.post('/api/v1/backups'))
    await service.idle()
    const projectsRes = await json<BackupProjectsResponse>(
      await client.get(`/api/v1/backups/${started.backup.id}/projects`),
    )
    expect(projectsRes.projects.map((p) => [p.slug, p.restorable, p.skipped_reason]).sort()).toEqual([
      ['_shared', false, 'disabled'],
      ['acme', false, 'disabled'],
    ])
  })

  it('a project busy with a user export is retried, then recorded as skipped (busy)', async () => {
    const { client, service } = await setup({ backup: { busyRetries: 1, busyDelayMs: 5 } })
    await seed()
    // a user import / export holds the transfer lock for the whole backup
    const pool = (await import('../../../test/db.js')).testPool()
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query("SELECT pg_advisory_xact_lock(hashtext('spoor.transfer'))")
      const started = await json<{ backup: { id: string } }>(await client.post('/api/v1/backups'))
      await service.idle()
      const res = await json<BackupProjectsResponse>(
        await client.get(`/api/v1/backups/${started.backup.id}/projects`),
      )
      expect(res.projects.every((p) => p.skipped_reason === 'busy' && !p.restorable)).toBe(true)
    } finally {
      await c.query('ROLLBACK')
      c.release()
    }
  })

  it('the job: due -> auto backup + prune by the tiers; not due -> nothing; never the newest good one', async () => {
    const { client, service } = await setup({ backup: { now: () => NOW } })
    await seed()
    // older autos, an invalid directory, a manual one and an old pre-restore one
    const autos: string[] = []
    for (let d = 16; d <= 25; d++) autos.push(await fakeBundle(dir, `2026-11-${d}T03:00:05Z`, 'auto'))
    const manual = await fakeBundle(dir, '2026-10-01T12:00:00Z', 'manual')
    const oldPre = await fakeBundle(dir, '2026-10-01T13:00:00Z', 'pre-restore')
    await mkdir(join(dir, 'backups', '20261001T030000Z-auto'))
    // a crashed run's leftovers in .tmp are swept after 24 h
    await mkdir(join(dir, '.tmp', '20261001T040000Z-auto'), { recursive: true })
    await client.request('PUT', '/api/v1/backups/settings', {
      body: { enabled: true, time_utc: '03:00', tiers: [{ every: '24h', keep: 2 }] },
    })

    const ctx = jobCtx()
    const stats = await service.jobHandler(ctx)
    expect(ctx.marked).toBe(1)
    const newId = backupIdFor(NOW, 'auto')
    expect(stats).toMatchObject({ backup: newId, projects: 2, projects_skipped: 0, pruned: 10 })
    // kept: the new one + 11-25 (24h x2), the manual one; the invalid directory is untouched
    expect(await ids(dir)).toEqual([manual, '20261001T030000Z-auto', autos[9], newId].sort())
    expect(await ids(dir)).not.toContain(oldPre)
    expect(await auditActions()).toEqual(['backup.settings', 'backup.create', 'backup.prune'])
    const prune = await db().select().from(auditLog).where(sql`action = 'backup.prune'`)
    expect(prune[0]).toMatchObject({ via: 'system', actorUserId: null })
    expect((prune[0]?.data as { deleted?: string[] } | undefined)?.deleted).toHaveLength(10)

    // the same slot again: not due
    const again = jobCtx()
    expect(await service.jobHandler(again)).toEqual({})
    expect(again.marked).toBe(0)

    // the newest good backup survives a prune even when no rule wants it: only unverified autos besides it
    await rm(join(dir, 'backups'), { recursive: true })
    const good = await fakeBundle(dir, '2026-11-01T10:00:00Z', 'pre-restore') // older than 14 days
    await fakeBundle(dir, '2026-11-24T03:00:05Z', 'auto', { verified_at: null })
    await fakeBundle(dir, '2026-11-25T03:00:05Z', 'auto', { verified_at: null })
    const pruned = await service.prune(dir, {
      enabled: true,
      time_utc: '03:00',
      tiers: [{ every: '24h', keep: 1 }],
      project_archives: true,
    })
    expect(pruned).toEqual([backupIdFor(new Date('2026-11-24T03:00:05Z'), 'auto')])
    expect(await ids(dir)).toContain(good)
  })

  it('a failed scheduled backup never prunes and leaves nothing behind', async () => {
    const { client, service } = await setup({ backup: { now: () => NOW, freeBytes: async () => 1024 } })
    await seed()
    const old = await fakeBundle(dir, '2026-11-01T03:00:05Z', 'auto')
    await client.request('PUT', '/api/v1/backups/settings', {
      body: { enabled: true, tiers: [{ every: '24h', keep: 1 }] },
    })
    await expect(service.jobHandler(jobCtx())).rejects.toThrow(/not enough free space/)
    expect(await ids(dir)).toEqual([old])
    expect(await readdir(join(dir, '.tmp'))).toEqual([])
    // backs off instead of failing every 15 minutes
    const ctx = jobCtx()
    expect(await service.jobHandler(ctx)).toEqual({})
    expect(ctx.marked).toBe(0)
  })

  it('a failing job_runs insert (markWork) still releases the heavy lock', async () => {
    const { client, service } = await setup({ backup: { now: () => NOW } })
    await client.request('PUT', '/api/v1/backups/settings', { body: { enabled: true } })
    const ctx = jobCtx()
    ctx.markWork = async () => {
      throw new Error('job_runs insert failed')
    }
    await expect(service.jobHandler(ctx)).rejects.toThrow(/job_runs insert failed/)
    expect(service.lock.current).toBeNull()
    expect(await service.lock.running(db())).toBeNull()
  })

  it('prune keeps a bundle pinned after the plan was made', async () => {
    const { service } = await setup({ backup: { now: () => NOW } })
    const older = await fakeBundle(dir, '2026-11-20T03:00:05Z', 'auto')
    const newer = await fakeBundle(dir, '2026-11-25T03:00:05Z', 'auto')
    const settings = {
      enabled: true,
      time_utc: '03:00',
      tiers: [{ every: '24h' as const, keep: 1 }],
      project_archives: true,
    }
    // the pin is queued before prune gets to its check-and-remove
    const pruning = service.prune(dir, settings)
    const pin = service.updateManifest(older, (m) => ({ ...m, pinned: true }))
    expect(await pruning).toEqual([])
    expect((await pin).manifest.pinned).toBe(true)
    expect(await ids(dir)).toEqual([older, newer].sort())
  })

  it('the Status page warns when scheduled backups are overdue', async () => {
    const { client } = await setup()
    await client.request('PUT', '/api/v1/backups/settings', { body: { enabled: true } })
    const fresh = await json<{ backups: { overdue: boolean; enabled: boolean } }>(
      await client.get('/api/v1/status'),
    )
    // just saved, no backup yet: not overdue
    expect(fresh.backups).toMatchObject({
      enabled: true,
      available: true,
      overdue: false,
      last_good_at: null,
    })
    await db().execute(
      sql`UPDATE instance_settings SET updated_at = now() - interval '10 days' WHERE key = 'backup'`,
    )
    const threeDaysAgo = new Date(Math.floor((Date.now() - 3 * 86_400_000) / 1000) * 1000)
    await fakeBundle(dir, threeDaysAgo.toISOString(), 'auto')
    const late = await json<{ backups: { overdue: boolean; last_good_at: string } }>(
      await client.get('/api/v1/status'),
    )
    expect(late.backups).toMatchObject({ overdue: true, last_good_at: threeDaysAgo.toISOString() })
    const list = await json<BackupListResponse>(await client.get('/api/v1/backups'))
    expect(list.status.overdue).toBe(true)
  })
})
