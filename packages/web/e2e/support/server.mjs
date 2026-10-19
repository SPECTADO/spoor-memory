// Starts the BUILT server (packages/server/dist) for the Playwright run, serving the built SPA
// (packages/web/dist), exactly like src/index.ts except for the embedding model: the deterministic
// bag-of-words fake of packages/server/test/ports.ts instead of the e5 ONNX model (not downloaded in CI).
//
// Env (set by playwright.config.ts): DATABASE_URL (the e2e database, dropped and created here),
// SPOOR_E2E_ADMIN_DATABASE_URL (a database on the same server to run DROP/CREATE from), SPOOR_PORT,
// SPOOR_PUBLIC_URL, SPOOR_ADMIN_EMAIL, SPOOR_ADMIN_PASSWORD, SPOOR_WEB_DIR and the other SPOOR_* settings.
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverDir = resolve(here, '../../../server')
const fromServer = createRequire(resolve(serverDir, 'package.json'))
const dist = (p) => pathToFileURL(resolve(serverDir, 'dist', p)).href

function fail(message) {
  console.error(`\n[e2e server] ${message}\n`)
  process.exit(1)
}

for (const f of [resolve(serverDir, 'dist/app.js'), resolve(process.env.SPOOR_WEB_DIR ?? '', 'index.html')]) {
  if (!existsSync(f)) fail(`${f} does not exist. Run \`pnpm e2e\` (it builds first) or \`pnpm build\`.`)
}

// ---- a fresh database ---------------------------------------------------------------------------------

const pg = fromServer('pg')
const target = new URL(process.env.DATABASE_URL)
const dbName = decodeURIComponent(target.pathname.slice(1))
if (!dbName.endsWith('_test')) fail(`refusing to drop database "${dbName}": its name must end in _test.`)
const admin = new pg.Client({
  connectionString: process.env.SPOOR_E2E_ADMIN_DATABASE_URL,
  connectionTimeoutMillis: 3000,
})
try {
  await admin.connect()
} catch (err) {
  fail(
    `Test database not reachable (${err.code || err.message || err}). ` +
      'Start it with `pnpm test:db:up` (docker, pgvector, port 55432) or set DATABASE_URL to a pgvector Postgres.',
  )
}
await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
await admin.query(`CREATE DATABASE "${dbName}"`)
await admin.end()

// ---- the fake embedding model -------------------------------------------------------------------------

function hash32(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

class FakeEmbeddingProvider {
  name = 'local'
  model = 'fake/bag-of-words'
  variant = 'fake'
  dims = 384
  tag = `local:${this.model}@fake/${this.dims}`
  maxInputTokens = 512
  async ready() {}
  countTokens(text) {
    return Math.ceil(text.length / 4) + 2
  }
  vector(text) {
    const v = new Float32Array(this.dims)
    for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) v[hash32(w) % this.dims] += 1
    const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1
    return v.map((x) => x / n)
  }
  async embedQuery(text) {
    return this.vector(text)
  }
  async embedPassages(texts) {
    return texts.map((t) => this.vector(t))
  }
}

const provider = new FakeEmbeddingProvider()
const embeddings = {
  defaultProvider: provider,
  byName: (name) => (name === provider.name ? provider : undefined),
  byTag: (tag) => (tag === provider.tag ? provider : undefined),
  list: () => [provider],
}

// ---- the server (src/index.ts with the fake registry) --------------------------------------------------

const { serve } = fromServer('@hono/node-server')
const { createApp, createAppModules } = await import(dist('app.js'))
const { loadConfig } = await import(dist('config.js'))
const { createDb } = await import(dist('db/client.js'))
const { runMigrations } = await import(dist('db/migrate.js'))
const { createLogger } = await import(dist('logger.js'))
const { createRuntime, startup } = await import(dist('runtime.js'))
const { newReadyState } = await import(dist('types.js'))

const config = loadConfig()
const logger = createLogger(config.LOG_LEVEL)
const state = newReadyState()
const { pool, db } = createDb(config.DATABASE_URL, config.SPOOR_DB_POOL_MAX)
const rt = createRuntime({ config, logger, db }, { embeddings, scheduler: { instanceId: 'web-e2e' } })
const modules = createAppModules(rt.deps, { scheduler: rt.scheduler, search: rt.search })
const app = createApp({
  config,
  logger,
  state,
  ports: rt.ports,
  modules,
  pingDb: () => pool.query('SELECT 1').then(() => true),
})
serve({ fetch: app.fetch, port: config.SPOOR_PORT, hostname: config.SPOOR_HOST })
await startup(rt, state, {
  migrate: () => runMigrations({ databaseUrl: config.DATABASE_URL, migrateUrl: config.DATABASE_URL }),
}).catch((err) => fail(`startup failed: ${err?.stack ?? err}`))
console.log(`[e2e server] ready on ${config.SPOOR_PUBLIC_URL}`)
