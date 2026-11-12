// The instance usage page (api.md section 10.4, ADR-0033): request-log aggregates over 14 gap-free UTC days,
// by project / operation / client / surface, content written per day, and the host resource series that the
// `resource-sample` job writes, for instance admins only.
import type { UsageJson } from '@spoor/shared'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { testDb } from '../../../test/db.js'
import {
  addMember,
  createAdmin,
  createItem,
  createProject,
  createToken,
  createUser,
  DEFAULT_PASSWORD,
} from '../../../test/factories.js'
import { json, loginAs, testApp } from '../../../test/http.js'
import { jobLocks, jobRuns, resourceSamples } from '../../db/schema.js'

const db = () => testDb()
const DAY = 86_400_000
const utcDay = (daysAgo: number) =>
  new Date(Math.floor(Date.now() / DAY) * DAY - daysAgo * DAY).toISOString().slice(0, 10)

async function seed(env: Record<string, string> = {}) {
  const { app, modules } = testApp({ env })
  const admin = await createAdmin(db(), { email: 'admin@example.com' })
  const dev = await createUser(db(), { email: 'dev@example.com' })
  const acme = await createProject(db(), { slug: 'acme', name: 'Acme' })
  const beta = await createProject(db(), { slug: 'beta', name: 'Beta' })
  await addMember(db(), acme.id, dev.id, 'admin')
  const t1 = await createToken(db(), { projectId: acme.id, userId: admin.id })
  const t2 = await createToken(db(), { projectId: acme.id, userId: dev.id })
  const ci = await createToken(db(), { projectId: beta.id, name: 'ci' })
  return { app, modules, admin, dev, acme, beta, t1, t2, ci }
}

/** A request-log row at 01:00 UTC `daysAgo` days back. */
async function logRow(r: {
  daysAgo: number
  projectId: string
  kind: 'read' | 'write'
  surface: 'mcp' | 'cli'
  operation: string
  userId: string | null
  label: string
  tokenId: string
  client: string | null
  outcome?: string
  ms?: number
}) {
  await db().execute(sql`INSERT INTO request_log
      (at, project_id, kind, surface, operation, actor_user_id, actor_label, token_id, client_name, outcome, duration_ms)
    VALUES (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - make_interval(days => ${r.daysAgo}::int)
        + interval '1 hour', ${r.projectId}, ${r.kind}, ${r.surface}, ${r.operation}, ${r.userId}, ${r.label},
        ${r.tokenId}, ${r.client}, ${r.outcome ?? 'ok'}, ${r.ms ?? 10})`)
}

async function sample(minutesAgo: number, v: { cpu: number; rss: number; sessions: number; host?: string }) {
  await db().execute(sql`INSERT INTO resource_samples
      (at, host, cpu_percent, load_avg1, rss_bytes, heap_used_bytes, event_loop_delay_ms, db_size_bytes,
       db_connections, pool_total, pool_waiting, mcp_sessions, embeddings_pending)
    VALUES (now() - make_interval(mins => ${minutesAgo}::int), ${v.host ?? 'web-1'}, ${v.cpu}, 0.5, ${v.rss},
      1000, 1.5, 5000, 3, 2, 0, ${v.sessions}, 0)`)
}

describe('GET /api/v1/status/usage', () => {
  it('is for instance admins only, no-store, and validates range', async () => {
    const s = await seed()
    const dev = await loginAs(s.app, 'dev@example.com', DEFAULT_PASSWORD)
    expect((await dev.get('/api/v1/status/usage')).status).toBe(403)
    const admin = await loginAs(s.app, 'admin@example.com', DEFAULT_PASSWORD)
    const ok = await admin.get('/api/v1/status/usage')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect((await json<UsageJson>(ok)).resources.range).toBe('24h')
    expect((await admin.get('/api/v1/status/usage?range=14d')).status).toBe(200)
    const bad = await admin.get('/api/v1/status/usage?range=7d')
    expect(bad.status).toBe(400)
    expect(await json(bad)).toMatchObject({ error: 'invalid_input' })
    expect((await admin.get('/api/v1/status/usage?days=3')).status).toBe(400)
  })

  it('counts agent requests per UTC day, gap-free, and by project, operation, client and surface', async () => {
    const s = await seed()
    const a = {
      userId: s.admin.id,
      label: 'admin@example.com',
      tokenId: s.t1.id,
      client: 'claude-code/2.1.303',
    }
    const d = { userId: s.dev.id, label: 'dev@example.com', tokenId: s.t2.id, client: 'codex/0.9.1' }
    const acme = s.acme.id
    await logRow({
      ...a,
      daysAgo: 2,
      projectId: acme,
      kind: 'read',
      surface: 'mcp',
      operation: 'spoor_search',
      ms: 10,
    })
    await logRow({
      ...a,
      daysAgo: 2,
      projectId: acme,
      kind: 'read',
      surface: 'mcp',
      operation: 'spoor_search',
      ms: 30,
    })
    await logRow({ ...a, daysAgo: 2, projectId: acme, kind: 'read', surface: 'mcp', operation: 'spoor_get' })
    await logRow({
      ...d,
      daysAgo: 2,
      projectId: acme,
      kind: 'write',
      surface: 'mcp',
      operation: 'spoor_remember',
      outcome: 'invalid_input',
    })
    await logRow({
      ...d,
      daysAgo: 0,
      projectId: acme,
      kind: 'read',
      surface: 'mcp',
      operation: 'spoor_context',
    })
    await logRow({
      daysAgo: 0,
      projectId: s.beta.id,
      kind: 'write',
      surface: 'cli',
      operation: 'POST /push',
      userId: null,
      label: 'service:ci',
      tokenId: s.ci.id,
      client: 'spoor-cli/0.7.0',
    })
    // outside the 14-day window (the purge job would have deleted it)
    await logRow({ ...a, daysAgo: 20, projectId: acme, kind: 'read', surface: 'mcp', operation: 'spoor_get' })
    // content: one item today, one created two days ago, plus a second revision two days ago
    await createItem(db(), { projectId: acme })
    const old = await createItem(db(), { projectId: acme })
    await db().execute(sql`UPDATE items SET created_at = now() - interval '2 days' WHERE id = ${old.id}`)
    await db().execute(sql`INSERT INTO item_revisions
        (item_id, revision, title, body, status, frontmatter, change, actor_label, via, created_at)
      VALUES (${old.id}, 2, 'Old', '', 'active', '{}', 'update', 'test', 'web', now() - interval '2 days')`)

    const admin = await loginAs(s.app, 'admin@example.com', DEFAULT_PASSWORD)
    const u = await json<UsageJson>(await admin.get('/api/v1/status/usage'))

    expect(u.window).toEqual({ days: 14, from: utcDay(13), to: utcDay(0) })
    expect(u.per_day.map((r) => r.day)).toEqual(Array.from({ length: 14 }, (_, i) => utcDay(13 - i)))
    const day = (n: number) => u.per_day.find((r) => r.day === utcDay(n))
    expect(day(2)).toEqual({
      day: utcDay(2),
      reads: 3,
      writes: 1,
      searches: 2,
      people: 2,
      tokens: 2,
      revisions: 1,
      items_created: 1,
    })
    expect(day(0)).toMatchObject({ reads: 1, writes: 1, searches: 0, people: 2, tokens: 2, revisions: 2 })
    expect(day(1)).toMatchObject({ reads: 0, writes: 0, people: 0, revisions: 0, items_created: 0 })
    expect(u.totals).toEqual({
      requests: 6,
      reads: 4,
      writes: 2,
      searches: 2,
      errors: 1,
      people: 3,
      tokens: 3,
      clients: 3,
      projects: 2,
      revisions: 3,
      items_created: 2,
    })
    expect(u.by_project.map((p) => [p.slug, p.name, p.reads, p.writes])).toEqual([
      ['acme', 'Acme', 4, 1],
      ['beta', 'Beta', 0, 1],
    ])
    expect(Date.parse(u.by_project[0]?.last_at ?? '')).toBeGreaterThan(Date.now() - DAY)
    expect(u.by_operation[0]).toEqual({
      operation: 'spoor_search',
      surface: 'mcp',
      kind: 'read',
      requests: 2,
      errors: 0,
      avg_ms: 20,
      p95_ms: 29,
    })
    expect(u.by_operation.find((o) => o.operation === 'spoor_remember')).toMatchObject({ errors: 1 })
    expect(u.by_client).toEqual([
      { client: 'claude-code', requests: 3, people: 1 },
      { client: 'codex', requests: 2, people: 1 },
      { client: 'spoor-cli', requests: 1, people: 1 },
    ])
    expect(u.by_surface).toEqual([
      { surface: 'cli', reads: 0, writes: 1 },
      { surface: 'mcp', reads: 4, writes: 1 },
    ])
  })

  it('returns host samples as fixed buckets for 24 h and 14 d, with current, min and max', async () => {
    const s = await seed()
    await sample(10, { cpu: 20, rss: 300, sessions: 4, host: 'web-2' })
    await sample(180, { cpu: 40, rss: 100, sessions: 1 })
    await sample(3 * 24 * 60, { cpu: 90, rss: 900, sessions: 9 })
    const admin = await loginAs(s.app, 'admin@example.com', DEFAULT_PASSWORD)

    const day = (await json<UsageJson>(await admin.get('/api/v1/status/usage?range=24h'))).resources
    expect(day).toMatchObject({ range: '24h', bucket_s: 900, interval_s: 300, samples: 2, host: 'web-2' })
    expect(day.points).toHaveLength(96)
    expect(day.points.filter((p) => p.cpu_percent !== null).map((p) => p.cpu_percent)).toEqual([40, 20])
    expect(day.metrics.cpu_percent).toEqual({ current: 20, min: 20, max: 40 })
    expect(day.metrics.rss_bytes).toEqual({ current: 300, min: 100, max: 300 })
    expect(day.metrics.mcp_sessions).toEqual({ current: 4, min: 1, max: 4 })
    expect(day.metrics.event_loop_delay_ms).toEqual({ current: 1.5, min: 1.5, max: 1.5 })
    expect(Date.parse(day.points[1]?.at ?? '') - Date.parse(day.points[0]?.at ?? '')).toBe(900_000)

    const fortnight = (await json<UsageJson>(await admin.get('/api/v1/status/usage?range=14d'))).resources
    expect(fortnight).toMatchObject({ range: '14d', bucket_s: 7200, samples: 3 })
    expect(fortnight.points).toHaveLength(168)
    expect(fortnight.points.filter((p) => p.rss_bytes !== null).map((p) => p.rss_bytes)).toEqual([
      900, 100, 300,
    ])
    expect(fortnight.metrics.cpu_percent).toEqual({ current: 20, min: 20, max: 90 })
  })

  it('is empty but complete without traffic or samples', async () => {
    const s = await seed()
    const admin = await loginAs(s.app, 'admin@example.com', DEFAULT_PASSWORD)
    const u = await json<UsageJson>(await admin.get('/api/v1/status/usage'))
    expect(u.per_day).toHaveLength(14)
    expect(u.totals.requests).toBe(0)
    expect(u.by_project).toEqual([])
    expect(u.resources).toMatchObject({ samples: 0, last_sample_at: null, host: null })
    expect(u.resources.points.every((p) => p.cpu_percent === null)).toBe(true)
    expect(u.resources.metrics.rss_bytes).toEqual({ current: null, min: null, max: null })
  })
})

describe('the resource-sample job', () => {
  it('is registered every 5 minutes and writes one sample per run, without a job_runs row', async () => {
    const s = await seed({ SPOOR_JOBS: 'on' })
    const scheduler = s.modules.jobs.scheduler
    const def = scheduler.definitions().find((j) => j.name === 'resource-sample')
    expect(def).toMatchObject({ everyMs: 300_000, recordOnlyWithWork: true })
    await scheduler.seed()
    expect(await scheduler.runNow('resource-sample')).toEqual({ started: true })
    await scheduler.idle()
    // a second sample has a CPU window and an event-loop histogram from the first
    expect(await s.modules.status.sampler.sample()).toEqual({ samples: 1 })
    const rows = await db().select().from(resourceSamples).orderBy(resourceSamples.id)
    expect(rows).toHaveLength(2)
    const last = rows[1]
    expect(last?.host.length).toBeGreaterThan(0)
    expect(last?.rssBytes).toBeGreaterThan(0)
    expect(last?.dbSizeBytes).toBeGreaterThan(0)
    expect(last?.dbConnections).toBeGreaterThan(0)
    expect(last?.mcpSessions).toBe(0)
    expect(last?.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(last?.eventLoopDelayMs === null || (last?.eventLoopDelayMs ?? -1) >= 0).toBe(true)
    expect(await db().select().from(jobRuns)).toEqual([])
    const [lock] = await db().select().from(jobLocks).where(sql`name = 'resource-sample'`)
    expect(lock?.lastStatus).toBe('ok')
  })
})
