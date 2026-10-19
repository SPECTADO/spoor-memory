import { serve } from '@hono/node-server'
import { createApp, createAppModules } from './app.js'
import { ConfigError, loadConfig } from './config.js'
import { createDb } from './db/client.js'
import { runMigrations, StartupError } from './db/migrate.js'
import { createLogger } from './logger.js'
import { createRuntime, shutdown, startup } from './runtime.js'
import { newReadyState } from './types.js'

let config: ReturnType<typeof loadConfig>
try {
  config = loadConfig()
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err)
  process.exit(1)
}

const logger = createLogger(config.LOG_LEVEL)
const state = newReadyState()
const { pool, db } = createDb(config.DATABASE_URL, config.SPOOR_DB_POOL_MAX)
// real ports: embedding providers, SearchService, scheduler (src/runtime.ts)
const rt = createRuntime({ config, logger, db })
const modules = createAppModules(rt.deps, { scheduler: rt.scheduler, search: rt.search })

const app = createApp({
  config,
  logger,
  state,
  ports: rt.ports,
  modules,
  pingDb: () => pool.query('SELECT 1').then(() => true),
})

// deployment.md section 4 step 2: listen immediately, answer 503 `starting` until ready
const server = serve({ fetch: app.fetch, port: config.SPOOR_PORT, hostname: config.SPOOR_HOST }, (info) =>
  logger.info({ port: info.port }, 'listening'),
)

const migrate = () =>
  runMigrations({
    databaseUrl: config.DATABASE_URL,
    migrateUrl: config.DATABASE_MIGRATE_URL,
    migrationsDir: config.SPOOR_MIGRATIONS_DIR,
    log: (m) => logger.info(m),
  })

async function connectedStartup() {
  for (let i = 1; ; i++) {
    try {
      return await startup(rt, state, { migrate })
    } catch (err) {
      if (err instanceof StartupError || i >= 30) throw err
      logger.warn({ attempt: i, err: (err as Error).message }, 'startup step failed, retrying')
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

connectedStartup().catch((err) => {
  state.db = state.db === 'ok' ? 'ok' : 'failed'
  logger.fatal({ err }, 'startup failed')
  process.exit(1)
})

let stopping = false
function onSignal(signal: string) {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'shutting down')
  // the scheduler waits up to 25 s for running jobs; compose's stop_grace_period is 40 s
  setTimeout(() => process.exit(1), 35_000).unref()
  modules.mcp.close() // stop the MCP session sweep, close every session
  shutdown(rt, {
    closeServer: () => new Promise<void>((resolve) => server.close(() => resolve())),
    endPool: () => pool.end(),
  })
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'shutdown failed')
      process.exit(1)
    })
}
process.on('SIGTERM', () => onSignal('SIGTERM'))
process.on('SIGINT', () => onSignal('SIGINT'))
