// PgJobStore leases against Postgres (cleanup-and-jobs.md section 4) and the purge-ephemeral job.
import { eq, sql } from 'drizzle-orm'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import { createProject, createUser } from '../../../test/factories.js'
import { testConfig } from '../../../test/http.js'
import { deviceCodes, invites, jobLocks, jobRuns, sessions } from '../../db/schema.js'
import { randomSecret, sha256 } from '../../lib/crypto.js'
import { createScheduler } from './index.js'
import { PgJobStore } from './store.js'

const db = () => testDb()
const MIN = 60_000

async function lock(name: string) {
  const res = await db().execute<{
    free: boolean
    locked_by: string | null
    last_status: string | null
    last_error: string | null
    has_run: boolean
    lease_s: number | null
  }>(sql`SELECT locked_until = '-infinity' AS free, locked_by, last_status, last_error,
      last_run_at IS NOT NULL AS has_run,
      CASE WHEN locked_until = '-infinity' THEN NULL
           ELSE round(extract(epoch from locked_until - now()))::int END AS lease_s
    FROM job_locks WHERE name = ${name}`)
  return res.rows[0]
}

describe('PgJobStore', () => {
  it('seeds lock rows idempotently', async () => {
    const store = new PgJobStore(db())
    await store.seed(['cleanup', 'reembed'])
    await store.seed(['cleanup', 'reembed', 'purge-ephemeral'])
    const rows = await db().select({ name: jobLocks.name }).from(jobLocks).orderBy(jobLocks.name)
    expect(rows.map((r) => r.name)).toEqual(['cleanup', 'purge-ephemeral', 'reembed'])
    expect(await lock('cleanup')).toMatchObject({ free: true, locked_by: null, has_run: false })
  })

  it('exactly one of many concurrent instances gets the lease', async () => {
    const store = new PgJobStore(db())
    await store.seed(['cleanup'])
    const got = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.tryLease({
          name: 'cleanup',
          instance: `host:${i}`,
          leaseMs: 10 * MIN,
          everyMs: 60 * MIN,
          force: false,
        }),
      ),
    )
    expect(got.filter(Boolean)).toHaveLength(1)
    const holder = `host:${got.indexOf(true)}`
    expect(await lock('cleanup')).toMatchObject({ free: false, locked_by: holder, lease_s: 600 })
  })

  it('checks due-ness and lock-freeness in one statement; force skips only the due check', async () => {
    const store = new PgJobStore(db())
    await store.seed(['cleanup'])
    const req = { name: 'cleanup', instance: 'a:1', leaseMs: 10 * MIN, everyMs: 60 * MIN, force: false }
    expect(await store.tryLease(req)).toBe(true)
    expect(await store.tryLease({ ...req, force: true })).toBe(false) // locked
    await store.release('cleanup', 'a:1', 'ok', null)
    expect(await store.tryLease(req)).toBe(false) // free, but ran less than an hour ago
    expect(await store.tryLease({ ...req, force: true })).toBe(true) // a nudge / run now
    await store.release('cleanup', 'a:1', 'ok', null)
    await db().execute(
      sql`UPDATE job_locks SET last_run_at = now() - interval '61 minutes' WHERE name = 'cleanup'`,
    )
    expect(await store.tryLease(req)).toBe(true)
  })

  it('the lease of a crashed holder simply runs out', async () => {
    const store = new PgJobStore(db())
    await store.seed(['reembed'])
    const req = { name: 'reembed', instance: 'dead:1', leaseMs: 5 * MIN, everyMs: MIN, force: false }
    expect(await store.tryLease(req)).toBe(true)
    expect(await store.tryLease({ ...req, instance: 'b:1', force: true })).toBe(false)
    await db().execute(
      sql`UPDATE job_locks SET locked_until = now() - interval '1 second' WHERE name = 'reembed'`,
    )
    expect(await store.tryLease({ ...req, instance: 'b:1', force: true })).toBe(true)
    // the old holder can neither renew nor release the new holder's lease
    expect(await store.renew('reembed', 'dead:1', 5 * MIN)).toBe(false)
    await store.release('reembed', 'dead:1', 'error', 'late')
    expect(await lock('reembed')).toMatchObject({ free: false, locked_by: 'b:1', last_status: null })
    expect(await store.renew('reembed', 'b:1', 5 * MIN)).toBe(true)
  })

  it('records runs and stores only a one-line, bounded error message', async () => {
    const store = new PgJobStore(db())
    const id = await store.insertRun('cleanup', new Date(), null)
    let [row] = await db().select().from(jobRuns).where(eq(jobRuns.id, id))
    expect(row).toMatchObject({ name: 'cleanup', status: 'running', finishedAt: null })
    await store.finishRun(id, 'error', { staled: 1 }, `line one\nline two ${'x'.repeat(1000)}`)
    ;[row] = await db().select().from(jobRuns).where(eq(jobRuns.id, id))
    expect(row?.status).toBe('error')
    expect(row?.stats).toEqual({ staled: 1 })
    expect(row?.error?.startsWith('line one line two')).toBe(true)
    expect(row?.error?.length).toBe(500)
    expect(row?.finishedAt).not.toBeNull()
  })
})

describe('purge-ephemeral', () => {
  async function seedEphemeral() {
    const user = await createUser(db())
    const project = await createProject(db())
    const session = (age: string, idle: string, expires: string) =>
      db().execute(sql`INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at)
        VALUES (${sha256(randomSecret())}, ${user.id}, now() - ${age}::interval, now() - ${idle}::interval,
                now() + ${expires}::interval)`)
    await session('1 day', '1 hour', '29 days') // live
    await session('31 days', '1 hour', '-1 hour') // past the absolute expiry
    await session('20 days', '15 days', '10 days') // idle for more than 14 days
    let code = 0
    const device = (expiresAgo: string) =>
      db().execute(sql`INSERT INTO device_codes (device_code_hash, user_code, project_id, client_name, expires_at)
        VALUES (${sha256(randomSecret())}, ${`BCDFGHJ${'KLMN'[code++]}`}, ${project.id}, 'cli', now() - ${expiresAgo}::interval)`)
    await device('-5 minutes') // still pending
    await device('23 hours') // expired, kept for a day
    await device('25 hours') // purged
    const invite = (cols: { used?: string; revoked?: string; expires: string }) =>
      db().execute(sql`INSERT INTO invites (token_hash, expires_at, used_at, revoked_at)
        VALUES (${sha256(randomSecret())}, now() - ${cols.expires}::interval,
                ${cols.used ? sql`now() - ${cols.used}::interval` : null},
                ${cols.revoked ? sql`now() - ${cols.revoked}::interval` : null})`)
    await invite({ expires: '-3 days' }) // open
    await invite({ expires: '-3 days', used: '29 days' }) // used recently
    await invite({ expires: '-3 days', used: '31 days' }) // used long ago
    await invite({ expires: '-3 days', revoked: '31 days' }) // revoked long ago
    await invite({ expires: '31 days' }) // expired long ago
    await invite({ expires: '29 days' }) // expired recently
    await db().execute(sql`INSERT INTO job_runs (name, started_at, finished_at, status) VALUES
      ('cleanup', now() - interval '31 days', now() - interval '31 days', 'ok'),
      ('cleanup', now() - interval '29 days', now() - interval '29 days', 'ok')`)
  }

  it('deletes only rows past their fixed cutoffs and reports the counts', async () => {
    await seedEphemeral()
    const scheduler = createScheduler(
      { db: db(), logger: pino({ level: 'silent' }), config: testConfig() },
      { instanceId: 'it:purge' },
    )
    await scheduler.seed()
    expect(await scheduler.runNow('purge-ephemeral')).toEqual({ started: true })
    await scheduler.idle()
    expect(await db().select().from(sessions)).toHaveLength(1)
    expect(await db().select().from(deviceCodes)).toHaveLength(2)
    expect(await db().select().from(invites)).toHaveLength(3)
    const runs = await db().select().from(jobRuns).orderBy(jobRuns.startedAt)
    // the 29-day-old cleanup row and this purge run itself remain
    expect(runs.map((r) => r.name)).toEqual(['cleanup', 'purge-ephemeral'])
    expect(runs[1]).toMatchObject({
      status: 'ok',
      stats: { sessions: 2, device_codes: 1, invites: 3, job_runs: 1 },
    })
  })
})
