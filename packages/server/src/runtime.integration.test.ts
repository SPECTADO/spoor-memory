/**
 * Startup steps 3 to 8 and graceful shutdown (deployment.md section 4) through src/runtime.ts, against the
 * real test database: the readiness gates /healthz reports, the `_shared` row and the job_locks seed, the
 * scheduler starting with the server and stopping on shutdown, and the embedding-target sync.
 */
import { sql } from 'drizzle-orm'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { testDb } from '../test/db.js'
import { createProject } from '../test/factories.js'
import { testConfig } from '../test/http.js'
import { FakeEmbeddingProvider, StaticEmbeddingRegistry } from '../test/ports.js'
import { createApp, createAppModules } from './app.js'
import { FakeClock, SCHEDULER_DEFAULTS } from './modules/jobs/index.js'
import { createRuntime, shutdown, startup } from './runtime.js'
import { newReadyState } from './types.js'

const db = () => testDb()
const ADMIN_ENV = { SPOOR_ADMIN_EMAIL: 'root@example.com', SPOOR_ADMIN_PASSWORD: 'a long enough password' }

function build(provider = new FakeEmbeddingProvider(), others: FakeEmbeddingProvider[] = []) {
  const config = testConfig(ADMIN_ENV)
  const logger = pino({ level: 'silent' })
  const clock = new FakeClock()
  const rt = createRuntime(
    { config, logger, db: db() },
    {
      embeddings: new StaticEmbeddingRegistry(provider, others),
      scheduler: { instanceId: 'it:runtime', clock, timers: clock, random: () => 0 },
    },
  )
  const state = newReadyState()
  const modules = createAppModules(rt.deps, { scheduler: rt.scheduler, search: rt.search })
  const app = createApp({
    config,
    logger,
    state,
    ports: rt.ports,
    modules,
    pingDb: async () => true,
  })
  return { rt, state, app, clock, provider }
}

const healthz = async (app: ReturnType<typeof build>['app']) => {
  const res = await app.request('/healthz')
  return {
    status: res.status,
    body: (await res.json()) as { status: string; checks: Record<string, string> },
  }
}

describe('startup', () => {
  it('passes every gate in order, seeds _shared, job_locks and the admin, starts the scheduler, then is ready', async () => {
    const { rt, state, app, clock, provider } = build()
    const before = await healthz(app)
    expect(before.status).toBe(503)
    expect(before.body.checks).toEqual({ db: 'loading', migrations: 'loading', embedding: 'loading' })

    let migrated = false
    await startup(rt, state, {
      migrate: async () => {
        migrated = true
      },
    })
    expect(migrated).toBe(true)
    expect(state).toEqual({ db: 'ok', migrations: 'ok', embedding: 'ok', ready: true })
    const after = await healthz(app)
    expect(after).toEqual({
      status: 200,
      body: expect.objectContaining({
        status: 'ok',
        checks: { db: 'ok', migrations: 'ok', embedding: 'ok' },
      }),
    })

    const shared = await db().execute<{ embedding_model: string }>(
      sql`SELECT embedding_model FROM projects WHERE kind = 'shared'`,
    )
    expect(shared.rows).toEqual([{ embedding_model: provider.tag }])
    const locks = await db().execute<{ name: string }>(sql`SELECT name FROM job_locks ORDER BY name`)
    expect(locks.rows.map((r) => r.name)).toEqual(['cleanup', 'embed-pending', 'purge-ephemeral', 'reembed'])
    const admins = await db().execute<{ email: string }>(sql`SELECT email FROM users WHERE is_admin`)
    expect(admins.rows).toEqual([{ email: 'root@example.com' }])

    // the scheduler is running: its first tick is due 30 s after start
    expect(clock.pending()).toContain(SCHEDULER_DEFAULTS.firstTickMs)
    await shutdown(rt)
  })

  it('stays not-ready with embedding=failed when the default provider cannot load', async () => {
    const provider = new FakeEmbeddingProvider()
    provider.ready = async () => {
      throw new Error('model files missing')
    }
    const { rt, state, app, clock } = build(provider)
    await expect(startup(rt, state, { migrate: async () => {} })).rejects.toThrow('model files missing')
    expect(state).toEqual({ db: 'ok', migrations: 'ok', embedding: 'failed', ready: false })
    const h = await healthz(app)
    expect(h.status).toBe(503)
    expect(h.body.checks.embedding).toBe('failed')
    // the scheduler never started: no tick is scheduled
    expect(clock.pending()).toEqual([])
    await shutdown(rt)
  })

  it('sets embedding_target on projects whose provider tag differs from their active model', async () => {
    const { rt, state } = build()
    const old = await createProject(db(), { slug: 'old', embeddingModel: 'local:Xenova/old-model@q8/384' })
    await startup(rt, state, { migrate: async () => {} })
    const row = await db().execute<{ embedding_target: string | null }>(
      sql`SELECT embedding_target FROM projects WHERE id = ${old.id}`,
    )
    expect(row.rows[0]?.embedding_target).toBe(rt.ports.embeddings.defaultProvider.tag)
    await shutdown(rt)
  })
})

describe('startup on a non-local default provider', () => {
  it('creates _shared on that provider and does not retarget it to the built-in local default', async () => {
    // the deterministic fake under the name `openai` (a remote provider would need the network)
    const fake = new FakeEmbeddingProvider({ model: 'fake/openai', dims: 16 })
    const openai = Object.assign(fake, { name: 'openai' }) as unknown as FakeEmbeddingProvider
    // `local` is enabled too, so a project that resolved to the built-in default would be retargeted to it
    const { rt, state } = build(openai, [new FakeEmbeddingProvider()])
    await startup(rt, state, { migrate: async () => {} })
    const shared = await db().execute<{ embedding_model: string; embedding_target: string | null }>(
      sql`SELECT embedding_model, embedding_target FROM projects WHERE kind = 'shared'`,
    )
    expect(shared.rows).toEqual([{ embedding_model: openai.tag, embedding_target: null }])
    await shutdown(rt)
  })
})

describe('shutdown', () => {
  it('stops the scheduler with the server, drains background work, then closes the pool', async () => {
    const { rt, state, clock } = build()
    await startup(rt, state, { migrate: async () => {} })
    const order: string[] = []
    await shutdown(rt, {
      closeServer: async () => void order.push('server'),
      drain: async () => void order.push('drain'),
      endPool: async () => void order.push('pool'),
    })
    expect(order).toEqual(['server', 'drain', 'pool'])
    // no tick left, and the scheduler refuses new runs
    expect(clock.pending()).toEqual([])
    expect(await rt.scheduler.runNow('cleanup')).toEqual({ started: false, reason: 'stopped' })
  })
})
