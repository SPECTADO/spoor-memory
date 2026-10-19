// The cleanup job against Postgres (cleanup-and-jobs.md sections 1, 2, 4, 5): the SQL predicates on the
// shared scenario table, audit rows by `system`, idempotency, per-project settings, and a full scheduled run.
import { eq, sql } from 'drizzle-orm'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import { createItem, createProject, createSharedProject } from '../../../test/factories.js'
import { testConfig } from '../../../test/http.js'
import { auditLog, items, jobLocks, jobRuns, projects } from '../../db/schema.js'
import { cleanupProject } from './cleanup.js'
import { createScheduler } from './index.js'
import { SCENARIOS, type ScenarioItem } from './lifecycle.scenarios.js'
import { noopSearchJobs } from './search-jobs.js'

const db = () => testDb()

const ago = (days: number) => sql`now() - make_interval(secs => ${days * 86_400}::float8)`
const ahead = (days: number) => sql`now() + make_interval(secs => ${days * 86_400}::float8)`

/** Create the scenario's item, then move its timestamps into the past in one statement. */
async function seedItem(projectId: string, i: ScenarioItem) {
  const space = i.space ?? 'memories'
  const item = await createItem(db(), {
    projectId,
    space,
    type: space === 'memories' ? (i.type ?? 'fact') : undefined,
    status: i.status ?? (space === 'decisions' ? 'accepted' : 'active'),
    pinned: i.pinned ?? false,
  })
  const lifecycle = i.lifecycle ?? 'active'
  await db().execute(sql`UPDATE items SET
      last_verified_at = ${ago(i.verifiedDaysAgo)},
      updated_at = ${ago(i.updatedDaysAgo)},
      last_used_at = ${i.usedDaysAgo === undefined || i.usedDaysAgo === null ? null : ago(i.usedDaysAgo)},
      expires_at = ${item.type === 'observation' ? ahead(i.expiresInDays ?? 7) : null},
      lifecycle = ${lifecycle},
      stale_since = ${lifecycle === 'stale' ? ago(i.staleDaysAgo ?? 0) : null},
      archived_at = ${lifecycle === 'archived' ? ago(i.archivedDaysAgo ?? 0) : null},
      archive_reason = ${lifecycle === 'archived' ? 'manual' : null}
    WHERE id = ${item.id}`)
  return item
}

async function itemRow(id: string) {
  const [row] = await db().select().from(items).where(eq(items.id, id))
  if (!row) throw new Error('item gone')
  return row
}

const auditOf = (itemId: string) =>
  db().select().from(auditLog).where(eq(auditLog.itemId, itemId)).orderBy(auditLog.id)

describe('SQL predicates on the shared scenario table', () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))('%s', async (_name, s) => {
    const project = await createProject(db(), { settings: s.settings ? { cleanup: s.settings } : {} })
    const item = await seedItem(project.id, s.item)
    const before = await itemRow(item.id)
    const result = await cleanupProject(db(), project)
    const after = await itemRow(item.id)
    const audit = await auditOf(item.id)

    const counts = { expire: result.expired, stale: result.staled, archive: result.archived }
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(s.expect === null ? 0 : 1)
    if (s.expect === null) {
      expect(after).toEqual(before)
      expect(audit).toHaveLength(0)
      return
    }
    expect(counts[s.expect]).toBe(1)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      projectId: project.id,
      actorUserId: null,
      actorLabel: 'system',
      tokenId: null,
      via: 'system',
      itemHandle: `m${item.number}`,
      action: { expire: 'item.expire', stale: 'item.stale', archive: 'item.archive' }[s.expect],
    })
    // only lifecycle columns move; content, verification and use timestamps are untouched
    expect(after.revision).toBe(before.revision)
    expect(after.updatedAt).toEqual(before.updatedAt)
    expect(after.lastVerifiedAt).toEqual(before.lastVerifiedAt)
    expect(after.lastUsedAt).toEqual(before.lastUsedAt)
    if (s.expect === 'stale') {
      expect(after.lifecycle).toBe('stale')
      expect(after.staleSince).not.toBeNull()
      expect(audit[0]?.at).toEqual(after.staleSince) // same transaction, same now()
    } else {
      expect(after).toMatchObject({
        lifecycle: 'archived',
        archiveReason: s.expect === 'expire' ? 'expired' : 'stale',
        staleSince: null,
      })
      expect(audit[0]?.at).toEqual(after.archivedAt)
    }
  })
})

describe('cleanupProject', () => {
  it('writes readable audit summaries with the project settings', async () => {
    const project = await createProject(db(), { settings: { cleanup: { stale_days: 10 } } })
    const m = await seedItem(project.id, { verifiedDaysAgo: 11, updatedDaysAgo: 11 })
    const o = await seedItem(project.id, {
      verifiedDaysAgo: 1,
      updatedDaysAgo: 1,
      type: 'observation',
      expiresInDays: -0.1,
    })
    await cleanupProject(db(), project)
    const [stale] = await auditOf(m.id)
    const [expired] = await auditOf(o.id)
    expect(stale).toMatchObject({
      action: 'item.stale',
      summary: 'unverified and unused for 10 days',
      data: { stale_days: 10 },
    })
    expect(expired).toMatchObject({
      action: 'item.expire',
      summary: 'observation expired',
      data: { reason: 'expired' },
    })
  })

  it('is idempotent: a second run changes nothing and writes no audit rows', async () => {
    const project = await createProject(db())
    await seedItem(project.id, { verifiedDaysAgo: 31, updatedDaysAgo: 31 })
    await seedItem(project.id, {
      ...{ verifiedDaysAgo: 400, updatedDaysAgo: 400 },
      lifecycle: 'stale',
      staleDaysAgo: 91,
    })
    await seedItem(project.id, {
      verifiedDaysAgo: 8,
      updatedDaysAgo: 8,
      type: 'observation',
      expiresInDays: -1,
    })
    expect(await cleanupProject(db(), project)).toEqual({ expired: 1, staled: 1, archived: 1 })
    const auditCount = (await db().select().from(auditLog)).length
    expect(await cleanupProject(db(), project)).toEqual({ expired: 0, staled: 0, archived: 0 })
    expect((await db().select().from(auditLog)).length).toBe(auditCount)
  })

  it('walks active -> stale -> archived over two runs, never both in one run', async () => {
    const project = await createProject(db())
    const m = await seedItem(project.id, { verifiedDaysAgo: 400, updatedDaysAgo: 400 })
    expect(await cleanupProject(db(), project)).toEqual({ expired: 0, staled: 1, archived: 0 })
    expect((await itemRow(m.id)).lifecycle).toBe('stale')
    // 91 days later (moved into the past instead of waiting)
    await db().execute(sql`UPDATE items SET stale_since = ${ago(91)} WHERE id = ${m.id}`)
    expect(await cleanupProject(db(), project)).toEqual({ expired: 0, staled: 0, archived: 1 })
    expect((await auditOf(m.id)).map((a) => a.action)).toEqual(['item.stale', 'item.archive'])
  })

  it('only touches its own project and uses each project its own settings', async () => {
    const short = await createProject(db(), { settings: { cleanup: { stale_days: 10 } } })
    const normal = await createProject(db())
    const a = await seedItem(short.id, { verifiedDaysAgo: 20, updatedDaysAgo: 20 })
    const b = await seedItem(normal.id, { verifiedDaysAgo: 20, updatedDaysAgo: 20 })
    const c = await seedItem(normal.id, { verifiedDaysAgo: 40, updatedDaysAgo: 40 })
    await cleanupProject(db(), short)
    expect((await itemRow(a.id)).lifecycle).toBe('stale')
    expect((await itemRow(c.id)).lifecycle).toBe('active') // other project, not run yet
    await cleanupProject(db(), normal)
    expect((await itemRow(b.id)).lifecycle).toBe('active')
    expect((await itemRow(c.id)).lifecycle).toBe('stale')
  })

  it('handles in the shared project are plain, relative to _shared (api.md 0.6)', async () => {
    const shared = await createSharedProject(db())
    const m = await seedItem(shared.id, { verifiedDaysAgo: 31, updatedDaysAgo: 31 })
    await cleanupProject(db(), shared)
    expect((await auditOf(m.id))[0]?.itemHandle).toBe(`m${m.number}`)
  })

  it('never stales decisions or docs, whatever their age', async () => {
    const project = await createProject(db(), { settings: { cleanup: { stale_days: 1, archive_days: 1 } } })
    const d = await seedItem(project.id, { space: 'decisions', verifiedDaysAgo: 999, updatedDaysAgo: 999 })
    const doc = await seedItem(project.id, { space: 'docs', verifiedDaysAgo: 999, updatedDaysAgo: 999 })
    await cleanupProject(db(), project)
    expect((await itemRow(d.id)).lifecycle).toBe('active')
    expect((await itemRow(doc.id)).lifecycle).toBe('active')
  })
})

describe('the scheduled cleanup job', () => {
  it('runs every project (shared included), records the run, per-project rows and the sweep', async () => {
    const shared = await createSharedProject(db())
    const p1 = await createProject(db())
    const p2 = await createProject(db())
    await seedItem(shared.id, { verifiedDaysAgo: 31, updatedDaysAgo: 31 })
    await seedItem(p1.id, { verifiedDaysAgo: 8, updatedDaysAgo: 8, type: 'observation', expiresInDays: -1 })
    await seedItem(p2.id, { verifiedDaysAgo: 1, updatedDaysAgo: 1 }) // nothing to do
    let sweeps = 0
    const scheduler = createScheduler(
      { db: db(), logger: pino({ level: 'silent' }), config: testConfig() },
      {
        instanceId: 'it:cleanup',
        searchJobs: {
          ...noopSearchJobs,
          chunkSweep: async () => {
            sweeps++
            return { rechunked: 0 }
          },
        },
      },
    )
    await scheduler.seed()
    expect(await scheduler.runNow('cleanup')).toEqual({ started: true })
    await scheduler.idle()

    expect(sweeps).toBe(1)
    const runs = await db().select().from(jobRuns).where(eq(jobRuns.name, 'cleanup')).orderBy(jobRuns.id)
    const global = runs.find((r) => r.projectId === null)
    expect(global).toMatchObject({
      status: 'ok',
      error: null,
      stats: { projects: 3, expired: 1, staled: 1, archived: 0, rechunked: 0, failed_projects: 0 },
    })
    expect(global?.finishedAt).not.toBeNull()
    const perProject = runs.filter((r) => r.projectId !== null)
    expect(perProject.map((r) => r.projectId).sort()).toEqual([shared.id, p1.id].sort())
    expect(perProject.every((r) => r.status === 'ok')).toBe(true)
    const [lock] = await db()
      .select({ lastStatus: jobLocks.lastStatus, lockedBy: jobLocks.lockedBy })
      .from(jobLocks)
      .where(eq(jobLocks.name, 'cleanup'))
    expect(lock).toEqual({ lastStatus: 'ok', lockedBy: 'it:cleanup' })
    const released = await db().execute(sql`SELECT locked_until = '-infinity' AS free FROM job_locks
      WHERE name = 'cleanup'`)
    expect(released.rows[0]).toEqual({ free: true })
  })

  it('a failing project is rolled back and skipped; the others are cleaned; the run ends in error', async () => {
    const p1 = await createProject(db())
    const p2 = await createProject(db())
    const a = await seedItem(p1.id, { verifiedDaysAgo: 31, updatedDaysAgo: 31 })
    const b = await seedItem(p2.id, { verifiedDaysAgo: 31, updatedDaysAgo: 31 })
    // make p1's audit insert fail (a test-only trigger, dropped again below)
    await db().execute(
      sql.raw(`CREATE FUNCTION jobs_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.project_id = '${p1.id}' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$`),
    )
    await db().execute(
      sql.raw(
        'CREATE TRIGGER jobs_test_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION jobs_test_fail()',
      ),
    )
    try {
      const scheduler = createScheduler(
        { db: db(), logger: pino({ level: 'silent' }), config: testConfig() },
        { instanceId: 'it:cleanup2' },
      )
      await scheduler.seed()
      await scheduler.runNow('cleanup')
      await scheduler.idle()
    } finally {
      await db().execute(sql.raw('DROP TRIGGER IF EXISTS jobs_test_fail ON audit_log'))
      await db().execute(sql.raw('DROP FUNCTION IF EXISTS jobs_test_fail()'))
    }
    expect((await itemRow(a.id)).lifecycle).toBe('active') // rolled back with its audit row
    expect((await itemRow(b.id)).lifecycle).toBe('stale')
    const runs = await db().select().from(jobRuns).where(eq(jobRuns.name, 'cleanup'))
    expect(runs.find((r) => r.projectId === null)).toMatchObject({
      status: 'error',
      error: 'cleanup failed for 1 project(s)',
      stats: { projects: 1, staled: 1, failed_projects: 1 },
    })
    expect(runs.find((r) => r.projectId === p1.id)).toMatchObject({ status: 'error' })
    expect(runs.find((r) => r.projectId === p2.id)).toMatchObject({ status: 'ok', stats: { staled: 1 } })
    const [lock] = await db().select().from(jobLocks).where(eq(jobLocks.name, 'cleanup'))
    expect(lock).toMatchObject({ lastStatus: 'error', lastError: 'cleanup failed for 1 project(s)' })
  })

  it('stored settings that no longer validate fall back to the defaults', async () => {
    const p = await createProject(db())
    const a = await seedItem(p.id, { verifiedDaysAgo: 31, updatedDaysAgo: 31 })
    await db().execute(
      sql`UPDATE projects SET settings = '{"cleanup":{"stale_days":"x"}}'::jsonb WHERE id = ${p.id}`,
    )
    const [row] = await db().select().from(projects).where(eq(projects.id, p.id))
    if (!row) throw new Error('project gone')
    expect(await cleanupProject(db(), row)).toEqual({ expired: 0, staled: 1, archived: 0 })
    expect((await itemRow(a.id)).lifecycle).toBe('stale')
  })
})
