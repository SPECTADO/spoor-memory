import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveStatic } from '@hono/node-server/serve-static'
import { type Context, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { Logger } from 'pino'
import type { Config } from './config.js'
import { runMigrations } from './db/migrate.js'
import { isDbUnavailable } from './lib/db.js'
import type { ServerDeps } from './lib/deps.js'
import { ApiError, apiErrorResponse, errorResponse, loggableError } from './lib/errors.js'
import { createAuditModule } from './modules/audit/index.js'
import { createAuthModule, securityHeaders } from './modules/auth/index.js'
import { type BackupServiceOptions, createBackupModule } from './modules/backup/index.js'
import { createDeviceModule, type DeviceServiceOptions } from './modules/device/index.js'
import { createInstallModule } from './modules/install/index.js'
import { createItemsModule } from './modules/items/index.js'
import {
  backupJob,
  createJobsModule,
  exportsJob,
  resourceSampleJob,
  type Scheduler,
} from './modules/jobs/index.js'
import { createMcpModule } from './modules/mcp/index.js'
import { createMirrorModule } from './modules/mirror/index.js'
import { createProjectsModule } from './modules/projects/index.js'
import { createRequestsModule } from './modules/requests/index.js'
import { createSearchModule, type SearchModule } from './modules/search/index.js'
import { createStatusModule } from './modules/status/index.js'
import { createTokensModule } from './modules/tokens/index.js'
import { createTransferModule, type ExportTaskOptions } from './modules/transfer/index.js'
import type { Ports } from './ports.js'
import { startupStepsAfterRestore } from './runtime.js'
import type { AppEnv, ReadyState } from './types.js'
import { VERSION } from './version.js'

export interface AppDeps {
  config: Config
  logger: Logger
  state: ReadyState
  /** Cross-module ports (src/ports.ts). src/runtime.ts binds the real ones; tests pass test/ports.ts stubs. */
  ports: Ports
  /** `SELECT 1` against the runtime pool; used by /healthz once startup finished. */
  pingDb?: () => Promise<boolean>
  /** The modules, built once with `createAppModules` (src/runtime.ts shares its scheduler and SearchService). */
  modules: AppModules
}

/** Seconds a client should wait after a request failed because no database connection could be had. */
export const DB_UNAVAILABLE_RETRY_AFTER_S = 5

/**
 * The app's error handler. A request that failed because no database connection could be had did nothing,
 * so it is answered 503 `busy` with `Retry-After` (which the CLI retries) instead of 500 `internal`.
 */
export function handleAppError(err: unknown, c: Context<AppEnv>): Response {
  if (err instanceof ApiError) return apiErrorResponse(c, err)
  if (err instanceof HTTPException) return err.getResponse()
  if (isDbUnavailable(err)) {
    c.get('log')?.warn({ err: loggableError(err) }, 'database unavailable')
    c.header('Retry-After', String(DB_UNAVAILABLE_RETRY_AFTER_S))
    return apiErrorResponse(
      c,
      new ApiError('busy', {
        message: 'The database is not reachable right now; try again shortly.',
        hint: `Retry after ${DB_UNAVAILABLE_RETRY_AFTER_S} seconds.`,
      }),
    )
  }
  c.get('log')?.error({ err: loggableError(err) }, 'unhandled error')
  return errorResponse(c, 'internal', { message: 'Internal error.' })
}

/**
 * Every module of the server, built once per app (packages/server/README.md, module convention). Production
 * (src/index.ts) passes the runtime's scheduler and search module so routes and ports share one instance;
 * without them (tests) the jobs and search modules build their own on `deps.ports`, which are always given.
 */
export function createAppModules(
  deps: ServerDeps,
  shared: {
    scheduler?: Scheduler
    search?: SearchModule
    /** Test overrides: device row cap / miss limiter, the version the install templates print. */
    device?: DeviceServiceOptions
    installVersion?: string
    /** Backup module overrides (tests: the pg tools of test/pg-tools.ts, a clock, short retries). */
    backup?: BackupServiceOptions
    /** Export task overrides (tests: an exports dir, short heartbeats and retries, no auto-run). */
    exports?: ExportTaskOptions
  } = {},
) {
  const items = createItemsModule(deps)
  const search = shared.search ?? createSearchModule(deps)
  const requests = createRequestsModule(deps)
  const jobs = createJobsModule(deps, { scheduler: shared.scheduler, requests: requests.service })
  const mcp = createMcpModule(deps, {
    items: items.items,
    search: search.search,
    context: search.context,
    requests: requests.log,
  })
  const transfer = createTransferModule(deps, { exports: shared.exports })
  // the backup module reads per-project archives through the transfer module (api.md section 13.3)
  const backup = createBackupModule(deps, shared.backup, { transfer })
  const status = createStatusModule(deps, {
    mcpSessions: () => mcp.sessions.size,
    jobsEnabled: () => jobs.scheduler.enabled,
    backups: () => backup.service.statusSummary(),
  })
  // the sampler needs the MCP session count, so the job is registered here, before startup seeds the locks
  jobs.scheduler.register(resourceSampleJob(() => status.sampler.sample()))
  // 0.8 jobs: scheduled backups and pruning (ADR-0040); `exports` tidies the async export
  // tasks of the transfer module (ADR-0041)
  jobs.scheduler.register(backupJob(backup.jobHandler))
  jobs.scheduler.register(exportsJob(transfer.exportsJobHandler))
  // full restore (ADR-0039): what it stops while it replaces the database, and the startup steps it runs again
  // (the same migration call as src/index.ts; the readiness state stays ready, /healthz stays green)
  const { config, logger } = deps
  let schedulerWasActive = false
  backup.restore.setHost({
    stopBackground: async () => {
      schedulerWasActive = jobs.scheduler.active
      await Promise.all([schedulerWasActive ? jobs.scheduler.stop() : null, transfer.exportTasks.stop()])
    },
    closeSessions: () => mcp.sessions.closeAll(),
    startupSteps: () =>
      startupStepsAfterRestore(
        {
          ...deps,
          embeddings: deps.ports.embeddings,
          scheduler: jobs.scheduler,
          syncEmbeddingTargets: () => search.jobs.syncEmbeddingTargets(),
        },
        () =>
          runMigrations({
            databaseUrl: config.DATABASE_URL,
            migrateUrl: config.DATABASE_MIGRATE_URL,
            migrationsDir: config.SPOOR_MIGRATIONS_DIR,
            log: (msg) => logger.info(msg),
          }),
      ),
    startBackground: async () => {
      if (schedulerWasActive) await jobs.scheduler.resume()
      transfer.exportTasks.resume()
    },
  })
  return {
    auth: createAuthModule(deps),
    projects: createProjectsModule(deps),
    tokens: createTokensModule(deps),
    audit: createAuditModule(deps),
    items,
    search,
    requests,
    jobs,
    transfer,
    device: createDeviceModule(deps, shared.device),
    install: createInstallModule(deps, { version: shared.installVersion }),
    mirror: createMirrorModule(deps, items),
    mcp,
    status,
    backup,
  }
}

export type AppModules = ReturnType<typeof createAppModules>

export const HEALTH_PING_TIMEOUT_MS = 2000
const HEALTH_CACHE_MS = 5000

/** `packages/web/dist`, resolved from both src/ and dist/. */
const DEFAULT_WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist')

export function createApp({ config, logger, state, ports, pingDb, modules: m }: AppDeps) {
  const app = new Hono<AppEnv>()
  const webDir = resolve(config.SPOOR_WEB_DIR ?? DEFAULT_WEB_DIR)
  const hasWeb = existsSync(resolve(webDir, 'index.html'))
  if (!hasWeb) logger.warn({ webDir }, 'SPA build not found; serving the API only')

  // CSP, nosniff, Referrer-Policy on every response (auth-and-security.md section 4)
  app.use('*', securityHeaders)

  // request id + access log (no bodies, no headers)
  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID()
    c.set('requestId', requestId)
    c.set('log', logger.child({ request_id: requestId }))
    c.header('X-Request-Id', requestId)
    const start = performance.now()
    await next()
    c.get('log').info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - start),
      },
      'request',
    )
  })

  // /healthz: 503 until DB + migrations (+ embedding) are ready, then re-checks only the DB (cached 5 s).
  // One ping in flight at a time, bounded by HEALTH_PING_TIMEOUT_MS: a blackholed DB or an exhausted pool
  // reports `unhealthy` instead of every probe hanging on its own connection.
  let lastPing = { at: 0, ok: true }
  let inFlight: Promise<boolean> | null = null
  const ping = (): Promise<boolean> => {
    if (!pingDb) return Promise.resolve(true)
    inFlight ??= Promise.race([
      pingDb().catch(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(false), HEALTH_PING_TIMEOUT_MS).unref?.()),
    ]).finally(() => {
      inFlight = null
    })
    return inFlight
  }
  app.get('/healthz', async (c) => {
    c.header('Cache-Control', 'no-store')
    const checks = { db: state.db, migrations: state.migrations, embedding: state.embedding }
    if (!state.ready) return c.json({ status: 'starting', version: VERSION, checks }, 503)
    if (pingDb && Date.now() - lastPing.at > HEALTH_CACHE_MS) lastPing = { at: Date.now(), ok: await ping() }
    if (!lastPing.ok)
      return c.json({ status: 'unhealthy', version: VERSION, checks: { ...checks, db: 'failed' } }, 503)
    return c.json({ status: 'ok', version: VERSION, checks })
  })

  // a full restore's maintenance gate: every route below (all but /healthz) answers 503 `maintenance`, except
  // GET /api/v1/backups/restore-status; requests in flight are counted for the restore's drain (ADR-0039)
  app.use('*', m.backup.maintenance)

  // every other route answers 503 `starting` until ready (JSON on API routes, text elsewhere)
  app.use('*', async (c, next) => {
    if (state.ready) return next()
    c.header('Retry-After', '5')
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/p/')) return errorResponse(c, 'starting')
    return c.text('starting', 503)
  })

  app.get('/api/v1/instance', (c) =>
    c.json({
      version: VERSION,
      public_url: config.publicOrigin,
      // the providers this instance enables (the registry is built from env, search-and-digest.md section 2)
      providers: ports.embeddings.list().map((p) => ({
        name: p.name,
        tag: p.tag,
        dims: p.dims,
        remote: p.name !== 'local',
      })),
      default_provider: config.SPOOR_EMBEDDING_DEFAULT,
    }),
  )

  // ---- /api/v1: cookie surface. Guards first, then each module's routes (packages/server/README.md) ----
  const api = new Hono<AppEnv>()
  api.use('*', ...m.auth.cookieApiGuards)
  api.route('/', m.auth.routes)
  api.route('/', m.projects.routes)
  api.route('/', m.tokens.routes)
  api.route('/', m.audit.routes)
  api.route('/', m.requests.routes)
  api.route('/', m.items.routes)
  api.route('/', m.search.routes)
  api.route('/', m.jobs.routes)
  api.route('/', m.transfer.routes)
  api.route('/', m.device.routes)
  api.route('/', m.status.routes)
  api.route('/', m.backup.routes)
  // every api.md section 12 route is built (deviations.md G16); anything else falls through to the JSON 404
  app.route('/api/v1', api)

  // ---- /p/:slug/api: bearer surface for the CLI and hooks (cookies ignored) ----
  const bearerApi = new Hono<AppEnv>()
  bearerApi.use('*', ...m.auth.bearerApiGuards, m.requests.bearerMiddleware)
  bearerApi.route('/', m.tokens.bearerRoutes)
  bearerApi.route('/', m.items.bearerRoutes)
  bearerApi.route('/', m.search.bearerRoutes)
  bearerApi.route('/', m.jobs.bearerRoutes)
  bearerApi.route('/', m.mirror.bearerRoutes) // activity, adr/push, docs/push; other paths are 404
  app.route('/p/:slug/api', bearerApi)
  // public device flow (RFC 8628 code + poll), the MCP endpoint (own bearer auth, 1 MB cap, errors) and the
  // public install doc / install.json
  app.route('/p/:slug/device', m.device.publicRoutes)
  app.route('/p/:slug/mcp', m.mcp.routes)
  app.route('/p/:slug', m.install.routes)

  // unknown API / server-owned paths are JSON 404s, never swallowed by the SPA fallback
  const serverOwned = (p: string) =>
    p.startsWith('/api/') || p === '/api' || p.startsWith('/p/') || p === '/healthz'
  app.all('*', async (c, next) => {
    if (serverOwned(c.req.path)) return errorResponse(c, 'not_found')
    return next()
  })

  if (hasWeb) {
    const noCache = { 'Cache-Control': 'no-cache' }
    const immutable = { 'Cache-Control': 'public, max-age=31536000, immutable' }
    app.use(
      '/assets/*',
      serveStatic({
        root: webDir,
        onFound: (_p, c) => void c.header('Cache-Control', immutable['Cache-Control']),
      }),
    )
    app.get(
      '*',
      serveStatic({
        root: webDir,
        onFound: (_p, c) => void c.header('Cache-Control', noCache['Cache-Control']),
      }),
    )
    // history fallback: any other GET is an SPA route
    app.get(
      '*',
      serveStatic({
        root: webDir,
        path: 'index.html',
        onFound: (_p, c) => void c.header('Cache-Control', noCache['Cache-Control']),
      }),
    )
  }

  app.notFound((c) =>
    c.req.path.startsWith('/api/') ? errorResponse(c, 'not_found') : c.text('not found', 404),
  )

  app.onError(handleAppError)

  return app
}
