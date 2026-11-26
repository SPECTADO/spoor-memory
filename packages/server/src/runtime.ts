/**
 * The composition root: the one place where the real cross-module implementations are bound to the ports of
 * src/ports.ts, plus the startup steps 3 to 8 and the graceful shutdown of deployment.md section 4.
 *
 *   embeddings  = the search module's provider registry (local e5 always, OpenAI / Voyage when keyed, Ollama when its URL is set)
 *   jobs        = the jobs module's scheduler (JobsPort: `enqueue` is a nudge)
 *   search      = the search module's SearchService (SearchPort: prepare / index chunks, dedupe)
 *   updates     = the status module's update check (UpdatePort: the newest release, cached; off with SPOOR_UPDATE_CHECK=off)
 *
 * The scheduler runs the search module's job functions directly: both modules code against `SearchJobs` and
 * `BatchContext` in src/ports.ts. src/index.ts only reads env, opens the pool and the HTTP server, and calls
 * `createRuntime`, `startup` and `shutdown`; tests drive the same functions.
 */
import { sql } from 'drizzle-orm'
import type { Logger } from 'pino'
import type { Config } from './config.js'
import type { Db } from './lib/db.js'
import type { ServerDeps } from './lib/deps.js'
import { bootstrapAdmin } from './modules/auth/index.js'
import { createScheduler, registerJobs, type Scheduler, type SchedulerOptions } from './modules/jobs/index.js'
import { ensureSharedProject } from './modules/projects/index.js'
import { createEmbeddingRegistry, createSearchModule, type SearchModule } from './modules/search/index.js'
import { createUpdateChecker } from './modules/status/index.js'
import { type EmbeddingRegistry, NoopSearchPort, type Ports, type UpdatePort } from './ports.js'
import type { ReadyState } from './types.js'
import { VERSION } from './version.js'

export interface RuntimeBase {
  config: Config
  logger: Logger
  db: Db
}

export interface Runtime {
  deps: ServerDeps
  ports: Ports
  scheduler: Scheduler
  search: SearchModule
}

export interface RuntimeOptions {
  /** Defaults to the providers configured by env (`createEmbeddingRegistry`). Tests pass fakes. */
  embeddings?: EmbeddingRegistry
  /** Scheduler overrides (tests: instance id, fake timers / clock). */
  scheduler?: Partial<Omit<SchedulerOptions, 'db' | 'store' | 'logger' | 'jobs'>>
  /** Defaults to the update check configured by env (`SPOOR_UPDATE_CHECK`, `SPOOR_UPDATE_URL`). */
  updates?: UpdatePort
}

/** Build the ports and the modules that implement them, sharing one SearchService and one scheduler. */
export function createRuntime(base: RuntimeBase, opts: RuntimeOptions = {}): Runtime {
  const embeddings = opts.embeddings ?? createEmbeddingRegistry(base.config)
  const scheduler = createScheduler(base, opts.scheduler)
  // `search` is replaced below: the SearchService reads `deps.ports` lazily, so it may see itself there
  const updates =
    opts.updates ??
    createUpdateChecker({
      enabled: base.config.SPOOR_UPDATE_CHECK === 'on',
      url: base.config.SPOOR_UPDATE_URL,
      currentVersion: VERSION,
      logger: base.logger,
    })
  const ports: Ports = { embeddings, jobs: scheduler, search: new NoopSearchPort(), updates }
  const deps: ServerDeps = { ...base, ports }
  const search = createSearchModule(deps)
  ports.search = search.search
  registerJobs(scheduler, { searchJobs: search.jobs })
  return { deps, ports, scheduler, search }
}

export interface StartupOptions {
  /** Step 4: extensions + migrations (index.ts passes `runMigrations`; tests a no-op, global setup ran them). */
  migrate: () => Promise<void>
}

/**
 * Startup steps 3 to 8 (deployment.md section 4). Flips `state` as each gate passes; `/healthz` turns 200
 * only after the default embedding provider is ready and the scheduler has started. Throws on any failure
 * (index.ts retries, then exits non-zero); `state.embedding` is `failed` when the provider was the cause.
 */
export async function startup(rt: Runtime, state: ReadyState, opts: StartupOptions): Promise<void> {
  const { db, logger } = rt.deps
  await db.execute(sql`SELECT 1`) // step 3
  state.db = 'ok'
  await opts.migrate() // step 4
  state.migrations = 'ok'
  const parts = startupParts(rt)
  await seedBaseRows(parts)
  // step 7: the default provider is the readiness gate; projects on another tag get an embedding_target
  state.embedding = 'loading'
  const provider = rt.ports.embeddings.defaultProvider
  try {
    await provider.ready()
  } catch (err) {
    state.embedding = 'failed'
    throw err
  }
  state.embedding = 'ok'
  logger.info({ provider: provider.tag }, 'default embedding provider ready')
  await syncTargets(parts)
  // step 8
  await rt.scheduler.start()
  state.ready = true
  logger.info('ready')
  // the first update check runs in the background, so /admin/status has an answer soon (no-op when off)
  rt.ports.updates.current()
}

/** What the startup steps 5 to 7 need; src/app.ts builds the same from the modules for a full restore. */
export interface StartupParts {
  db: Db
  logger: Logger
  config: Config
  embeddings: EmbeddingRegistry
  scheduler: Scheduler
  syncEmbeddingTargets: () => Promise<readonly unknown[]>
}

const startupParts = (rt: Runtime): StartupParts => ({
  ...rt.deps,
  embeddings: rt.ports.embeddings,
  scheduler: rt.scheduler,
  syncEmbeddingTargets: () => rt.search.jobs.syncEmbeddingTargets(),
})

/** Steps 5 and 6: the `_shared` row, the job_locks rows, the bootstrap admin. */
async function seedBaseRows(p: StartupParts): Promise<void> {
  // step 5: the `_shared` project row with the default provider's tag, and the job_locks rows
  const shared = await ensureSharedProject(p.db, p.embeddings.defaultProvider)
  if (shared.created) p.logger.info('shared project created')
  await p.scheduler.seed()
  // step 6: StartupError (missing SPOOR_ADMIN_*) is not retried by index.ts
  const boot = await bootstrapAdmin(p.db, p.config)
  if (boot.created) p.logger.info({ email: boot.email }, 'bootstrap instance admin created')
}

/** Step 7's second half: projects on another tag get an embedding_target, and the re-embed job a nudge. */
async function syncTargets(p: StartupParts): Promise<void> {
  const retargeted = await p.syncEmbeddingTargets()
  if (retargeted.length > 0) {
    p.logger.info({ projects: retargeted.length }, 'projects set to re-embed for a new model')
    p.scheduler.enqueue('reembed')
  }
}

/**
 * The startup steps again after a full restore replaced the database (ADR-0039): migrations forward (a dump of
 * an older schema), `_shared`, the job_locks rows, the bootstrap admin, embedding targets. The provider is
 * ready already, `state` stays ready, and the caller starts the scheduler again.
 */
export async function startupStepsAfterRestore(p: StartupParts, migrate: () => Promise<void>): Promise<void> {
  await migrate()
  await seedBaseRows(p)
  await syncTargets(p)
}

export interface ShutdownOptions {
  /** Stop accepting connections and wait for in-flight requests. */
  closeServer?: () => Promise<void>
  /** Background work that must finish before the pool closes (the import's chunk rebuild). */
  drain?: () => Promise<void>
  /** Close the pool. */
  endPool?: () => Promise<void>
}

/**
 * Graceful shutdown (SIGTERM): stop the HTTP server and the scheduler together (the scheduler aborts running
 * jobs and waits up to 25 s), let background chunk rebuilds finish, then close the pool.
 */
export async function shutdown(rt: Runtime, opts: ShutdownOptions = {}): Promise<void> {
  await Promise.all([opts.closeServer?.(), rt.scheduler.stop()])
  await opts.drain?.()
  await opts.endPool?.()
}
