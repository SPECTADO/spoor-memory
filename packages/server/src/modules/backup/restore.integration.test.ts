// Full restore (ADR-0039, api.md section 13.2) end to end, on SCRATCH databases of its own: the shared test
// database is truncated by every other test and must never be replaced. Like production, the app runs as a
// NOSUPERUSER role (`spoor_restore_app`) that owns every table, and the extensions belong to the superuser.
//
//   spoor_restore_scratch_test   the "live" database the app runs on
//   spoor_restore_old_test       the same app migrated one migration short (an older-schema dump)
//
// The pg tools come from test/pg-tools.ts (real binaries, else the docker shim, else skipped).
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BACKUP_FORMAT,
  type BackupListResponse,
  type BackupManifest,
  backupIdFor,
  type RestorePhase,
  type RestorePrepareResponse,
  type RestoreStatusJson,
} from '@spoor/shared'
import { eq, sql } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { testDatabaseUrl } from '../../../test/db-url.js'
import {
  createAdmin,
  createItem,
  createProject,
  createToken,
  createUser,
  DEFAULT_PASSWORD,
} from '../../../test/factories.js'
import { Client, json, loginAs, testApp } from '../../../test/http.js'
import { resolveTestPgTools } from '../../../test/pg-tools.js'
import { createDb } from '../../db/client.js'
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../../db/migrate.js'
import { auditLog, instanceSettings, invites, items, sessions, tokens, users } from '../../db/schema.js'
import { DUMP_ARGS } from './bundle.js'
import { bundleDir, DUMP_FILE, ensureLayout, hashFile, writeManifest } from './catalog.js'
import { currentMigration, databaseMigration } from './migrations.js'
import { pgConnectionEnv } from './pgtools.js'
import { RESTORE_STATE_FILE, readStateFile, writeStateFile } from './restore.js'

const pgt = resolveTestPgTools()
if (!pgt.available) console.warn(`[restore.integration] skipped: ${pgt.reason}`)

const ROLE = 'spoor_restore_app'
const ROLE_PW = 'restore-app-password'
const SCRATCH = 'spoor_restore_scratch_test'
const OLD = 'spoor_restore_old_test'
const LONG = 180_000

function urlFor(database: string, user?: { name: string; password: string }): string {
  const u = new URL(testDatabaseUrl())
  u.pathname = `/${database}`
  if (user) {
    u.username = user.name
    u.password = user.password
  }
  return u.toString()
}
const appUrl = (db: string) => urlFor(db, { name: ROLE, password: ROLE_PW })

async function asSuperuser<T>(database: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urlFor(database) })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end().catch(() => {})
  }
}

/** A fresh database like deploy/initdb/01-app-role.sh makes it, migrated as the app role. */
async function freshDatabase(name: string, migrationsDir?: string) {
  await asSuperuser(new URL(testDatabaseUrl()).pathname.slice(1), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await c.query(`CREATE DATABASE "${name}"`)
  })
  await asSuperuser(name, async (c) => {
    await c.query(`GRANT CONNECT, TEMPORARY ON DATABASE "${name}" TO ${ROLE}`)
    await c.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${ROLE}`)
  })
  await runMigrations({ databaseUrl: appUrl(name), migrateUrl: urlFor(name), migrationsDir })
}

async function dropDatabase(name: string) {
  await asSuperuser(new URL(testDatabaseUrl()).pathname.slice(1), (c) =>
    c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
  )
}

describe.skipIf(!pgt.available)('full restore on a scratch database', () => {
  const tools = pgt.available ? pgt.tools : (undefined as never)
  let superuser = true
  let dir: string
  let oldMigrations: string
  let scratch: ReturnType<typeof createDb>
  let phaseHook: ((phase: RestorePhase) => Promise<void> | void) | null = null

  const db = () => scratch.db
  const appTools = (name: string) => tools.withConnection(pgConnectionEnv(appUrl(name)))

  function build() {
    return testApp({
      env: {
        DATABASE_URL: appUrl(SCRATCH),
        DATABASE_MIGRATE_URL: urlFor(SCRATCH),
        SPOOR_BACKUP_DIR: dir,
      },
      db: db(),
      backup: {
        tools: appTools(SCRATCH),
        busyDelayMs: 10,
        restore: { drainMs: 2000, onPhase: (p) => phaseHook?.(p) },
      },
    })
  }

  beforeAll(async () => {
    const su = await asSuperuser(new URL(testDatabaseUrl()).pathname.slice(1), async (c) => {
      const r = await c.query<{ rolsuper: boolean }>(
        'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
      )
      if (!r.rows[0]?.rolsuper) return false
      await c.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
          CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${ROLE_PW}';
        END IF; END $$`)
      return true
    })
    superuser = su
    if (!su) {
      console.warn('[restore.integration] skipped: the test database user is not a superuser')
      return
    }
    dir = await mkdtemp(join(tmpdir(), 'spoor-restore-it-'))
    // the migrations of the previous release: the same folder without the last journal entry
    oldMigrations = join(dir, 'old-migrations')
    await cp(DEFAULT_MIGRATIONS_DIR, oldMigrations, { recursive: true })
    const journalPath = join(oldMigrations, 'meta', '_journal.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: unknown[] }
    journal.entries = journal.entries.slice(0, -1)
    await writeFile(journalPath, JSON.stringify(journal))
    await freshDatabase(SCRATCH)
    scratch = createDb(appUrl(SCRATCH), 5)
  }, LONG)

  afterAll(async () => {
    await scratch?.pool.end().catch(() => {})
    if (superuser) {
      await dropDatabase(SCRATCH)
      await dropDatabase(OLD)
    }
    if (dir) await rm(dir, { recursive: true, force: true })
  }, LONG)

  async function manualBackup(app: ReturnType<typeof build>, admin: Client): Promise<string> {
    const res = await admin.post('/api/v1/backups')
    expect(res.status).toBe(202)
    const { backup } = await json<{ backup: { id: string } }>(res)
    await app.modules.backup.service.idle()
    const list = await json<BackupListResponse>(await admin.get('/api/v1/backups'))
    expect(list.items.map((i) => i.id)).toContain(backup.id)
    return backup.id
  }

  async function prepare(admin: Client, id: string): Promise<RestorePrepareResponse> {
    const res = await admin.post(`/api/v1/backups/${id}/restore/prepare`)
    expect(res.status, await res.clone().text()).toBe(200)
    return json<RestorePrepareResponse>(res)
  }

  const nonceRows = async (nonce: string) =>
    (
      await db()
        .select({ id: auditLog.id, data: auditLog.data })
        .from(auditLog)
        .where(sql`${auditLog.action} = 'instance.restore' AND ${auditLog.data}->>'nonce' = ${nonce}`)
    ).length

  const relExists = async (name: string) =>
    (await db().execute(sql`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS ok`)).rows[0]?.ok === true

  const extensionFootprint = async () =>
    (
      await db().execute<{ n: number; exts: string }>(
        sql`SELECT (SELECT count(*)::int FROM pg_depend WHERE deptype = 'e') AS n,
                   (SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension) AS exts`,
      )
    ).rows[0]

  it(
    'restores: newer data and objects gone, older data back, sessions wiped, nonce row, settings kept, gate',
    async () => {
      if (!superuser) return
      const app = build()
      const admin = await createAdmin(db(), { email: 'admin@restore.test' })
      const project = await createProject(db(), { slug: 'kept' })
      await createItem(db(), { projectId: project.id, title: 'from before the backup', slug: 'before' })
      const revokedLater = await createToken(db(), {
        projectId: project.id,
        userId: admin.id,
        name: 'revoked later',
      })
      const client = await loginAs(app.app, admin.email, DEFAULT_PASSWORD)

      const id = await manualBackup(app, client)

      // everything below happens after the backup
      await createItem(db(), { projectId: project.id, title: 'written after the backup', slug: 'after' })
      const later = await createUser(db(), { email: 'later@restore.test' })
      const newToken = await createToken(db(), { projectId: project.id, userId: admin.id, name: 'new' })
      await db().update(tokens).set({ revokedAt: sql`now()` }).where(eq(tokens.id, revokedLater.id))
      // objects of a "newer schema" the app role owns, and one depending on an extension type
      await scratch.pool.query(`CREATE TYPE public.zz_mood AS ENUM ('a', 'b');
        CREATE DOMAIN public.zz_pos AS int CHECK (VALUE > 0);
        CREATE TABLE public.zz_newer (id int PRIMARY KEY, m public.zz_mood, p public.zz_pos, v public.vector(3));
        CREATE VIEW public.zz_view AS SELECT id FROM public.zz_newer;
        CREATE FUNCTION public.zz_fn(x public.zz_mood) RETURNS int LANGUAGE sql AS 'SELECT 1';
        CREATE SEQUENCE public.zz_seq;`)
      const settingsRes = await client.request('PUT', '/api/v1/backups/settings', {
        body: {
          enabled: true,
          time_utc: '04:30',
          tiers: [{ every: '24h', keep: 5 }],
          project_archives: true,
        },
      })
      expect(settingsRes.status).toBe(200)
      const other = await loginAs(app.app, later.email, DEFAULT_PASSWORD)
      const extBefore = await extensionFootprint()

      const prep = await prepare(client, id)
      expect(prep.phrase).toMatch(/^RESTORE \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
      expect(prep.summary.migration.to_apply).toBe(0)
      expect(prep.summary.pre_restore_backup).toBe(true)
      expect(prep.warnings.map((w) => w.code)).toEqual(
        expect.arrayContaining(['data_loss', 'logout', 'tokens']),
      )
      expect(prep.backup.id).toBe(id)

      // pause once the gate is on, to look at it from outside
      let release!: () => void
      const paused = new Promise<void>((r) => {
        release = r
      })
      let reachedDraining!: () => void
      const atDraining = new Promise<void>((r) => {
        reachedDraining = r
      })
      phaseHook = async (phase) => {
        if (phase === 'draining') {
          reachedDraining()
          await paused
        }
      }
      try {
        const started = await client.post(`/api/v1/backups/${id}/restore`, {
          token: prep.token,
          password: DEFAULT_PASSWORD,
          phrase: prep.phrase,
        })
        expect(started.status, await started.clone().text()).toBe(202)
        const body = await json<{ restore: RestoreStatusJson }>(started)
        expect(body.restore).toMatchObject({ state: 'running', backup_id: id })

        await atDraining
        const blocked = await client.get('/api/v1/projects')
        expect(blocked.status).toBe(503)
        expect(blocked.headers.get('retry-after')).toBe('5')
        expect(await json(blocked)).toMatchObject({ error: 'maintenance' })
        expect((await app.app.request('/p/kept/api/search')).status).toBe(503)
        expect((await app.app.request('/healthz')).status).toBe(200)
        const anon = await new Client(app.app).get('/api/v1/backups/restore-status')
        expect(anon.status).toBe(200)
        expect(await json<RestoreStatusJson>(anon)).toMatchObject({
          state: 'running',
          phase: 'draining',
          maintenance: true,
          backup_id: null,
          pre_restore_backup_id: null,
          error: null,
        })
      } finally {
        release()
        phaseHook = null
      }
      await app.modules.backup.restore.idle()

      const status = await app.modules.backup.restore.status()
      expect(status, JSON.stringify(status)).toMatchObject({
        state: 'done',
        phase: 'done',
        backup_id: id,
        maintenance: false,
      })
      expect(status.pre_restore_backup_id).toMatch(/-pre-restore$/)

      // data from before is back, data from after is gone
      const titles = (await db().select({ t: items.title }).from(items)).map((r) => r.t).sort()
      expect(titles).toEqual(['from before the backup'])
      expect(await db().select().from(users).where(eq(users.id, later.id))).toEqual([])
      expect(await db().select().from(tokens).where(eq(tokens.id, newToken.id))).toEqual([])
      // a revocation made after the backup survives
      const [rev] = await db()
        .select({ revokedAt: tokens.revokedAt })
        .from(tokens)
        .where(eq(tokens.id, revokedLater.id))
      expect(rev?.revokedAt).not.toBeNull()
      // newer objects dropped; extension members untouched
      for (const rel of ['zz_newer', 'zz_view', 'zz_seq']) expect(await relExists(rel)).toBe(false)
      const leftovers = await db().execute<{ n: number }>(
        sql`SELECT (SELECT count(*) FROM pg_type WHERE typname IN ('zz_mood', 'zz_pos'))::int
                 + (SELECT count(*) FROM pg_proc WHERE proname = 'zz_fn')::int AS n`,
      )
      expect(Number(leftovers.rows[0]?.n)).toBe(0)
      expect(await extensionFootprint()).toEqual(extBefore)
      // sessions wiped: everyone logs in again
      expect(await db().select().from(sessions)).toEqual([])
      expect((await client.get('/api/v1/me')).status).toBe(401)
      expect((await other.get('/api/v1/me')).status).toBe(401)
      expect((await (await loginAs(app.app, admin.email, DEFAULT_PASSWORD)).get('/api/v1/me')).status).toBe(
        200,
      )
      // the commit proof
      const file = await readStateFile(dir)
      expect(file).toMatchObject({ state: 'done', committed: true, backup_id: id })
      expect(await nonceRows(file?.nonce as string)).toBe(1)
      // the live schedule, written after the backup, is kept; the migrations are complete
      const [setting] = await db().select().from(instanceSettings).where(eq(instanceSettings.key, 'backup'))
      expect(setting?.value).toMatchObject({ enabled: true, time_utc: '04:30' })
      expect(await databaseMigration(db())).toEqual(currentMigration())
      // the pre-restore bundle holds the state just before the restore
      const fresh = await loginAs(app.app, admin.email, DEFAULT_PASSWORD)
      const list = await json<BackupListResponse>(await fresh.get('/api/v1/backups'))
      expect(list.items.find((i) => i.id === status.pre_restore_backup_id)?.kind).toBe('pre-restore')
      expect(list.status.running).toBeNull()

      // boot-time resolution of a restore a dead process left `running`
      const nonce = file?.nonce as string
      await writeStateFile(dir, {
        ...(file as NonNullable<typeof file>),
        state: 'running',
        phase: 'startup',
        committed: null,
        finished_at: null,
      })
      expect(await build().modules.backup.restore.resolveAtBoot()).toMatchObject({ state: 'done' })
      await writeStateFile(dir, {
        ...(file as NonNullable<typeof file>),
        nonce: '00000000-0000-4000-8000-000000000000',
        state: 'running',
        phase: 'restoring',
        committed: null,
      })
      expect(await build().modules.backup.restore.status()).toMatchObject({ state: 'interrupted' })
      expect(await readStateFile(dir)).toMatchObject({ state: 'interrupted', committed: false })
      expect(nonce).toBeTruthy()
    },
    LONG,
  )

  it(
    'credentials are not rewound (deleted, disabled, password, invites) and the live settings survive a crash',
    async () => {
      if (!superuser) return
      const app = build()
      const admin = await createAdmin(db(), { email: 'cred-admin@restore.test' })
      const project = await createProject(db(), { slug: 'cred' })
      const gone = await createUser(db(), { email: 'gone@restore.test' })
      const goneToken = await createToken(db(), { projectId: project.id, userId: gone.id, name: 'gone' })
      const disabled = await createUser(db(), { email: 'disabled@restore.test' })
      const disabledToken = await createToken(db(), {
        projectId: project.id,
        userId: disabled.id,
        name: 'dis',
      })
      const reset = await createUser(db(), { email: 'reset@restore.test' })
      const projectGone = await createProject(db(), { slug: 'cred-gone' })
      const serviceToken = await createToken(db(), { projectId: projectGone.id, name: 'leaked' })
      const invite = async () =>
        (
          await db()
            .insert(invites)
            .values({ tokenHash: randomBytes(32), expiresAt: sql`now() + interval '7 days'` })
            .returning({ id: invites.id })
        )[0]?.id as string
      const revokedInvite = await invite()
      const usedInvite = await invite()
      const deletedInvite = await invite()
      const client = await loginAs(app.app, admin.email, DEFAULT_PASSWORD)
      const id = await manualBackup(app, client)

      // after the backup: delete, disable, change a password, revoke / use / delete invites, change settings
      await db().delete(users).where(eq(users.id, gone.id))
      await scratch.pool.query('DELETE FROM projects WHERE id = $1', [projectGone.id])
      await db().update(users).set({ disabledAt: sql`now()` }).where(eq(users.id, disabled.id))
      await db()
        .update(users)
        .set({ passwordHash: 'live-hash-after-the-backup', passwordChangedAt: sql`now()` })
        .where(eq(users.id, reset.id))
      await db().update(invites).set({ revokedAt: sql`now()` }).where(eq(invites.id, revokedInvite))
      await db()
        .update(invites)
        .set({ usedAt: sql`now()`, usedBy: admin.id })
        .where(eq(invites.id, usedInvite))
      await db().delete(invites).where(eq(invites.id, deletedInvite))
      const put = await client.request('PUT', '/api/v1/backups/settings', {
        body: {
          enabled: true,
          time_utc: '05:15',
          tiers: [{ every: '24h', keep: 3 }],
          project_archives: true,
        },
      })
      expect(put.status).toBe(200)

      const prep = await prepare(client, id)
      expect(prep.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['tokens', 'security']))
      // the process "dies" right after the commit, before the startup steps and the settings write-back
      phaseHook = (phase) => {
        if (phase === 'startup') throw new Error('killed after the commit')
      }
      try {
        const started = await client.post(`/api/v1/backups/${id}/restore`, {
          token: prep.token,
          password: DEFAULT_PASSWORD,
          phrase: prep.phrase,
        })
        expect(started.status).toBe(202)
        await app.modules.backup.restore.idle()
      } finally {
        phaseHook = null
      }
      const left = await readStateFile(dir)
      expect(left).toMatchObject({ state: 'running', settings_written_back: false })
      expect(left?.live_backup_settings?.raw).toMatchObject({ time_utc: '05:15' })
      // the restored row is the backup's (no settings then): the next start writes the live value back
      expect(
        (await db().select().from(instanceSettings).where(eq(instanceSettings.key, 'backup')))[0]?.value,
      ).not.toMatchObject({ time_utc: '05:15' })
      expect(await build().modules.backup.restore.resolveAtBoot()).toMatchObject({
        state: 'done',
        error: null,
      })
      const [setting] = await db().select().from(instanceSettings).where(eq(instanceSettings.key, 'backup'))
      expect(setting?.value).toMatchObject({ enabled: true, time_utc: '05:15' })
      expect(await readStateFile(dir)).toMatchObject({ state: 'done', settings_written_back: true })

      const tokenRevoked = async (tid: string) => {
        const rows = await db().select({ r: tokens.revokedAt }).from(tokens).where(eq(tokens.id, tid))
        return rows.length === 1 ? rows[0]?.r : 'missing'
      }
      // the deleted user comes back disabled, with its token revoked
      const [g] = await db().select().from(users).where(eq(users.id, gone.id))
      expect(g?.disabledAt).not.toBeNull()
      expect(await tokenRevoked(goneToken.id)).toBeInstanceOf(Date)
      // the deleted project's service token comes back revoked
      expect(await tokenRevoked(serviceToken.id)).toBeInstanceOf(Date)
      // the user disabled since stays disabled; their token was not revoked live and stays as it was
      const [d] = await db().select().from(users).where(eq(users.id, disabled.id))
      expect(d?.disabledAt).not.toBeNull()
      expect(await tokenRevoked(disabledToken.id)).toBeNull()
      // the newer password is kept
      const [r] = await db().select().from(users).where(eq(users.id, reset.id))
      expect(r?.passwordHash).toBe('live-hash-after-the-backup')
      // no invite is usable again
      const inv = await db().select({ id: invites.id, revokedAt: invites.revokedAt }).from(invites)
      for (const iid of [revokedInvite, usedInvite, deletedInvite]) {
        expect(inv.find((x) => x.id === iid)?.revokedAt, iid).toBeInstanceOf(Date)
      }
    },
    LONG,
  )

  it(
    'a dump cut off mid-restore rolls back: the database and the sessions are as they were',
    async () => {
      if (!superuser) return
      const app = build()
      const admin = await createAdmin(db(), { email: 'cut@restore.test' })
      const project = await createProject(db(), { slug: 'cut' })
      for (let i = 0; i < 30; i++)
        await createItem(db(), { projectId: project.id, title: `bulk ${i}`, body: 'x'.repeat(2000) })
      const client = await loginAs(app.app, admin.email, DEFAULT_PASSWORD)
      const id = await manualBackup(app, client)
      await createItem(db(), { projectId: project.id, title: 'after the cut backup' })
      await scratch.pool.query('CREATE TABLE public.zz_survivor (id int)')
      const countBefore = (await db().select().from(items)).length
      const prep = await prepare(client, id)

      phaseHook = async (phase) => {
        if (phase !== 'restoring') return
        const path = join(bundleDir(dir, id), DUMP_FILE)
        const { size } = await hashFile(path)
        await truncate(path, Math.floor(size * 0.6))
      }
      try {
        const started = await client.post(`/api/v1/backups/${id}/restore`, {
          token: prep.token,
          password: DEFAULT_PASSWORD,
          phrase: prep.phrase,
        })
        expect(started.status).toBe(202)
        await app.modules.backup.restore.idle()
      } finally {
        phaseHook = null
      }
      const status = await app.modules.backup.restore.status()
      expect(status).toMatchObject({ state: 'failed', maintenance: false })
      expect(status.error).toMatch(/rolled back.*(pg_restore|does not match)/s)
      const file = await readStateFile(dir)
      expect(file?.committed).toBe(false)
      expect(await nonceRows(file?.nonce as string)).toBe(0)
      expect((await db().select().from(items)).length).toBe(countBefore)
      expect(await relExists('zz_survivor')).toBe(true)
      // the session survived and the app answers again
      expect((await client.get('/api/v1/me')).status).toBe(200)
      expect((await client.get('/api/v1/projects')).status).toBe(200)
      await scratch.pool.query('DROP TABLE public.zz_survivor')
    },
    LONG,
  )

  it(
    'an object of another role in the way stops the restore (no CASCADE) and nothing changes',
    async () => {
      if (!superuser) return
      const app = build()
      const admin = await createAdmin(db(), { email: 'foreign@restore.test' })
      const client = await loginAs(app.app, admin.email, DEFAULT_PASSWORD)
      const id = await manualBackup(app, client)
      const project = await createProject(db(), { slug: 'foreign-after' })
      await createItem(db(), { projectId: project.id, title: 'after the foreign backup' })
      await asSuperuser(SCRATCH, (c) => c.query('CREATE VIEW public.su_view AS SELECT id FROM public.items'))
      try {
        const countBefore = (await db().select().from(items)).length
        const prep = await prepare(client, id)
        const started = await client.post(`/api/v1/backups/${id}/restore`, {
          token: prep.token,
          password: DEFAULT_PASSWORD,
          phrase: prep.phrase,
        })
        expect(started.status).toBe(202)
        await app.modules.backup.restore.idle()
        const status = await app.modules.backup.restore.status()
        expect(status.state).toBe('failed')
        expect(status.error).toMatch(/rolled back.*depend/s)
        expect((await db().select().from(items)).length).toBe(countBefore)
        expect(await relExists('su_view')).toBe(true)
        expect((await client.get('/api/v1/me')).status).toBe(200)
      } finally {
        await asSuperuser(SCRATCH, (c) => c.query('DROP VIEW IF EXISTS public.su_view'))
      }
    },
    LONG,
  )

  it(
    'a dump of an older schema is restored, then migrated forward',
    async () => {
      if (!superuser) return
      await freshDatabase(OLD, oldMigrations)
      const old = createDb(appUrl(OLD), 2)
      let id: string
      try {
        const oldAdmin = await createAdmin(old.db, { email: 'old-admin@restore.test' })
        await old.pool.query(
          `INSERT INTO projects (kind, slug, name, embedding_model) VALUES ('project', 'oldproj', 'Old project', 'local:x@q8/384')`,
        )
        const migration = await databaseMigration(old.db)
        expect(migration.count).toBe(currentMigration().count - 1)
        // the bundle by hand: the old app had no backup.json writer for this schema
        const at = new Date(Date.UTC(2026, 10, 1, 3, 0, 0))
        id = backupIdFor(at, 'manual')
        await ensureLayout(dir)
        const bdir = bundleDir(dir, id)
        await mkdir(bdir, { recursive: true, mode: 0o700 })
        const dumpPath = join(bdir, DUMP_FILE)
        await appTools(OLD).run('pg_dump', DUMP_ARGS, {
          stdout: createWriteStream(dumpPath, { mode: 0o600 }),
        })
        const h = await hashFile(dumpPath)
        const manifest: BackupManifest = {
          format: BACKUP_FORMAT,
          id,
          kind: 'manual',
          created_at: at.toISOString(),
          spoor_version: '0.0.1-old',
          migration,
          pg_server_version: '17',
          pg_dump_version: 'pg_dump (PostgreSQL) 17',
          files: [{ path: DUMP_FILE, ...h }],
          projects: [],
          pinned: false,
          verified_at: new Date().toISOString(),
        }
        await writeManifest(bdir, manifest)
        expect(oldAdmin.id).toBeTruthy()
      } finally {
        await old.pool.end()
      }

      const app = build()
      const admin = await createAdmin(db(), { email: 'now@restore.test' })
      const client = await loginAs(app.app, admin.email, DEFAULT_PASSWORD)
      const prep = await prepare(client, id)
      expect(prep.summary.migration.to_apply).toBe(1)
      expect(prep.warnings.map((w) => w.code)).toEqual(
        expect.arrayContaining(['older_schema', 'other_version']),
      )
      const started = await client.post(`/api/v1/backups/${id}/restore`, {
        token: prep.token,
        password: DEFAULT_PASSWORD,
        phrase: prep.phrase,
      })
      expect(started.status).toBe(202)
      await app.modules.backup.restore.idle()
      const status = await app.modules.backup.restore.status()
      expect(status, JSON.stringify(status)).toMatchObject({ state: 'done' })
      expect(await databaseMigration(db())).toEqual(currentMigration())
      expect(await relExists('instance_settings')).toBe(true)
      expect(await relExists('export_tasks')).toBe(true)
      const emails = (await db().select({ e: users.email }).from(users)).map((r) => r.e)
      expect(emails).toEqual(['old-admin@restore.test'])
      const projects = await db().execute<{ slug: string; restored_from: unknown }>(
        sql`SELECT slug, restored_from FROM projects ORDER BY slug`,
      )
      // the startup steps made `_shared` again
      expect(projects.rows.map((r) => r.slug).sort()).toEqual(['_shared', 'oldproj'])
      const file = await readStateFile(dir)
      expect(await nonceRows(file?.nonce as string)).toBe(1)
      expect(
        (await (await loginAs(app.app, 'old-admin@restore.test', DEFAULT_PASSWORD)).get('/api/v1/me')).status,
      ).toBe(200)
    },
    LONG,
  )

  it(
    'refuses: wrong password, phrase, session, backup or an expired token; other instances; a newer backup',
    async () => {
      if (!superuser) return
      const app = build()
      const admin = await createAdmin(db(), { email: 'refuse@restore.test' })
      const second = await createAdmin(db(), { email: 'refuse2@restore.test' })
      const user = await createUser(db(), { email: 'plain@restore.test' })
      const client = await loginAs(app.app, admin.email, DEFAULT_PASSWORD)
      const id = await manualBackup(app, client)
      const itemsBefore = (await db().select().from(items)).length
      const confirm = (c: Client, bid: string, body: Record<string, string>) =>
        c.post(`/api/v1/backups/${bid}/restore`, body)
      const expect403 = async (res: Response) => {
        expect(res.status, await res.clone().text()).toBe(403)
        expect(await json(res)).toMatchObject({ error: 'confirmation_failed' })
      }

      // wrong password; the token is used up even with the right one afterwards
      let prep = await prepare(client, id)
      await expect403(
        await confirm(client, id, { token: prep.token, password: 'wrong password!!', phrase: prep.phrase }),
      )
      await expect403(
        await confirm(client, id, { token: prep.token, password: DEFAULT_PASSWORD, phrase: prep.phrase }),
      )
      // wrong phrase
      prep = await prepare(client, id)
      await expect403(
        await confirm(client, id, {
          token: prep.token,
          password: DEFAULT_PASSWORD,
          phrase: prep.phrase.toLowerCase(),
        }),
      )
      // another session (another admin) cannot use the token
      prep = await prepare(client, id)
      const other = await loginAs(app.app, second.email, DEFAULT_PASSWORD)
      await expect403(
        await confirm(other, id, { token: prep.token, password: DEFAULT_PASSWORD, phrase: prep.phrase }),
      )
      // a token of another backup
      const id2 = await manualBackup(app, client)
      prep = await prepare(client, id)
      await expect403(
        await confirm(client, id2, { token: prep.token, password: DEFAULT_PASSWORD, phrase: prep.phrase }),
      )
      // expired
      prep = await prepare(client, id)
      const now = Date.now()
      const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 301_000)
      try {
        await expect403(
          await confirm(client, id, { token: prep.token, password: DEFAULT_PASSWORD, phrase: prep.phrase }),
        )
      } finally {
        spy.mockRestore()
      }
      // anon and non-admins
      expect((await new Client(app.app).post(`/api/v1/backups/${id}/restore/prepare`)).status).toBe(401)
      const plain = await loginAs(app.app, user.email, DEFAULT_PASSWORD)
      expect((await plain.post(`/api/v1/backups/${id}/restore/prepare`)).status).toBe(403)
      expect((await plain.get('/api/v1/backups/restore-status')).status).toBe(403)
      expect((await client.post('/api/v1/backups/..%2F..%2Fetc/restore/prepare')).status).toBe(404)
      expect(
        (
          await client.post(`/api/v1/backups/${id}/restore/prepare`, undefined, {
            headers: { authorization: 'Bearer x' },
          })
        ).status,
      ).toBe(400)

      // another Spoor instance connected to the database
      const otherInstance = new pg.Client({
        connectionString: appUrl(SCRATCH),
        application_name: 'spoor:elsewhere:1',
      })
      await otherInstance.connect()
      try {
        const res = await client.post(`/api/v1/backups/${id}/restore/prepare`)
        expect(res.status).toBe(409)
        expect(await json(res)).toMatchObject({ error: 'other_instances', details: { count: 1 } })
      } finally {
        await otherInstance.end()
      }

      // a backup with more migrations than this server knows
      const newer = backupIdFor(new Date(Date.UTC(2026, 10, 2, 3, 0, 0)), 'manual')
      const src = await readFile(join(bundleDir(dir, id), 'backup.json'), 'utf8')
      await cp(bundleDir(dir, id), bundleDir(dir, newer), { recursive: true })
      const m = JSON.parse(src) as BackupManifest
      await writeManifest(bundleDir(dir, newer), {
        ...m,
        id: newer,
        migration: { count: 999, last_tag: null },
      })
      const tooNew = await client.post(`/api/v1/backups/${newer}/restore/prepare`)
      expect(tooNew.status).toBe(409)
      expect(await json(tooNew)).toMatchObject({ error: 'backup_too_new' })

      // a damaged dump
      const broken = backupIdFor(new Date(Date.UTC(2026, 10, 3, 3, 0, 0)), 'manual')
      await cp(bundleDir(dir, id), bundleDir(dir, broken), { recursive: true })
      await writeManifest(bundleDir(dir, broken), { ...m, id: broken })
      await truncate(join(bundleDir(dir, broken), DUMP_FILE), 100)
      const bad = await client.post(`/api/v1/backups/${broken}/restore/prepare`)
      expect(bad.status).toBe(422)
      expect(await json(bad)).toMatchObject({ error: 'invalid_archive' })

      // nothing was restored, nothing is running, the state file is untouched by refusals
      expect((await db().select().from(items)).length).toBe(itemsBefore)
      const st = await json<RestoreStatusJson>(await client.get('/api/v1/backups/restore-status'))
      expect(st.maintenance).toBe(false)
      expect(st.state).not.toBe('running')
      expect(RESTORE_STATE_FILE).toBe('restore-state.json')
    },
    LONG,
  )
})
