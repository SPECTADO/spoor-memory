/**
 * Realistic-data benchmark for the agent token cost (BRIEF constraint: useful context in one call of ~1500
 * tokens on a large repo). Seeds one project (~300 memories, 40% anchored over a synthetic 2,000-file tree,
 * 40 ADRs of which 25 accepted in the last 30 days, 20 docs, 30 pinned) plus the `_shared` project (50
 * items), indexes everything with the REAL local e5 model, then measures: spoor_context digests (token count
 * by the e5 tokenizer and by the estimator, wall time), spoor_search, tools/list size, indexing throughput
 * and dedupe latency. Results go to stdout as JSON (docs/design/search-and-digest.md "Measured" section).
 *
 *   node scripts/test-db.mjs up          # pgvector test DB on 55432
 *   SPOOR_MODEL_DIR=/opt/spoor/models pnpm --filter @spoor/server bench:realistic
 *
 * The run uses its own database `spoor_bench_test` on the test server, created at the start and dropped at the end. Requires the model
 * baked by scripts/fetch-model.mjs; there is no fake-model fallback, because the numbers are meaningless
 * without the real one.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { estimateTokens, SETTINGS_DEFAULTS } from '@spoor/shared'
import { sql } from 'drizzle-orm'
import pg from 'pg'
import { pino } from 'pino'
import { createDb } from '../src/db/client.js'
import { runMigrations } from '../src/db/migrate.js'
import { withTx } from '../src/lib/db.js'
import type { ServerDeps } from '../src/lib/deps.js'
import type { McpServices } from '../src/modules/mcp/handlers.js'
import { buildMcpServer } from '../src/modules/mcp/server.js'
import { formatSearchResults } from '../src/modules/search/format.js'
import { createSearchModule, firstDuplicate, LocalE5Provider } from '../src/modules/search/index.js'
import { NoopSearchPort } from '../src/ports.js'
import { assertTestDatabase, testDatabaseUrl } from '../test/db-url.js'
import { createItem, createProject, createSharedProject, type ItemOpts } from '../test/factories.js'
import { testConfig } from '../test/http.js'
import { MemoryJobsPort, StaticEmbeddingRegistry } from '../test/ports.js'

const modelDir = process.env.SPOOR_MODEL_DIR
if (!modelDir || !existsSync(join(modelDir, 'Xenova/multilingual-e5-small/config.json'))) {
  throw new Error('SPOOR_MODEL_DIR must hold Xenova/multilingual-e5-small (scripts/fetch-model.mjs)')
}
const baseUrl = testDatabaseUrl()
assertTestDatabase(baseUrl)
// A private database (dropped at the end): the shared `spoor_test` is truncated by every vitest run, which
// would wipe the seed mid-benchmark when another session runs tests.
const BENCH_DB = 'spoor_bench_test'
const adminUrl = new URL(baseUrl)
adminUrl.pathname = '/postgres'
const benchUrl = new URL(baseUrl)
benchUrl.pathname = `/${BENCH_DB}`
const url = benchUrl.toString()
async function adminSql(stmt: string) {
  const c = new pg.Client({ connectionString: adminUrl.toString() })
  await c.connect()
  try {
    await c.query(stmt)
  } finally {
    await c.end()
  }
}
await adminSql(`DROP DATABASE IF EXISTS ${BENCH_DB} WITH (FORCE)`)
await adminSql(`CREATE DATABASE ${BENCH_DB}`)

// ---- deterministic data -----------------------------------------------------------------------------------

let seed = 20261019
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 2 ** 32
}
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T

const TOP = ['src', 'packages', 'apps', 'services', 'infra', 'docs', 'scripts', 'tests'] as const
const AREAS = [
  'auth',
  'billing',
  'search',
  'orders',
  'tickets',
  'venues',
  'payments',
  'notifications',
  'checkout',
  'reports',
  'users',
  'admin',
  'api',
  'db',
  'queue',
  'cache',
  'mail',
  'export',
  'import',
  'seatmap',
] as const
const SUB = [
  'core',
  'handlers',
  'models',
  'utils',
  'jobs',
  'routes',
  'middleware',
  'types',
  'adapters',
  'views',
] as const
const EXT = ['ts', 'ts', 'ts', 'tsx', 'sql', 'json', 'md', 'yaml'] as const

function buildTree(n: number): { files: string[]; dirs: string[] } {
  const files = new Set<string>()
  const dirs = new Set<string>()
  while (files.size < n) {
    const d = `${pick(TOP)}/${pick(AREAS)}/${pick(SUB)}${rnd() < 0.3 ? `/${pick(SUB)}` : ''}`
    dirs.add(d)
    files.add(`${d}/${pick(AREAS)}-${Math.floor(rnd() * 400)}.${pick(EXT)}`)
  }
  return { files: [...files], dirs: [...dirs] }
}
const tree = buildTree(2000)

const SUBJ_EN = [
  'Session tokens',
  'Order export',
  'The seat map renderer',
  'Payment webhooks',
  'The mail queue',
  'Venue import',
  'Ticket PDF generation',
  'Rate limiting',
  'The reporting job',
  'Cache invalidation',
  'Checkout totals',
  'Refund handling',
  'The admin API',
  'Notification preferences',
  'Search indexing',
  'Database migrations',
  'Idempotency keys',
  'The barcode scanner endpoint',
  'Voucher codes',
  'Presale access',
]
const SUBJ_CZ = [
  'Platnost relace',
  'Export objednávek',
  'Vykreslení mapy sedadel',
  'Platební webhooky',
  'Fronta e-mailů',
  'Import míst konání',
  'Generování PDF vstupenek',
  'Omezení počtu požadavků',
  'Noční report',
  'Invalidace cache',
  'Výpočet ceny v košíku',
  'Vrácení peněz',
  'Administrační API',
  'Nastavení notifikací',
  'Indexace pro vyhledávání',
  'Migrace databáze',
  'Klíče idempotence',
  'Endpoint pro čtečku čárových kódů',
  'Slevové kódy',
  'Předprodej',
]
const PRED_EN = [
  'must run inside a single transaction, otherwise partial rows leak into reports',
  'is retried three times with exponential backoff before an alert fires',
  'is disabled on staging because the provider sandbox rejects the signature',
  'reads the tenant from the JWT claim, never from the request body',
  'has a hard limit of 500 rows per call; larger batches are split by the caller',
  'is covered only by integration tests, the unit tests mock the wrong layer',
  'was rewritten in March and the old helper in utils/legacy must not be reused',
  'needs the feature flag checkout_v2 enabled, or it silently falls back to v1',
  'stores amounts in minor units (haléře), converting at the edge only',
  'is flaky on a cold database: the first call after deploy can take 8 seconds',
]
const PRED_CZ = [
  'musí běžet v jedné transakci, jinak se do reportů dostanou neúplné řádky',
  'se třikrát opakuje s exponenciálním čekáním, teprve potom se spustí alert',
  'je na stagingu vypnuté, protože sandbox poskytovatele odmítá podpis',
  'bere tenanta z JWT claimu, nikdy z těla požadavku',
  'má tvrdý limit 500 řádků na volání; větší dávky rozděluje volající',
  'pokrývají jen integrační testy, unit testy mockují špatnou vrstvu',
  'bylo přepsáno v březnu a starý helper z utils/legacy se nesmí používat',
  'vyžaduje zapnutý feature flag checkout_v2, jinak se tiše vrátí na v1',
  'ukládá částky v haléřích a převádí je až na hranici systému',
  'je nestabilní na studené databázi: první volání po nasazení trvá až 8 sekund',
]
const ADR_VERB_EN = ['Use', 'Adopt', 'Drop', 'Standardise on', 'Move to', 'Keep', 'Replace']
const ADR_VERB_CZ = ['Použít', 'Přejít na', 'Opustit', 'Sjednotit na', 'Ponechat', 'Nahradit']
const ADR_OBJ = [
  'pgvector for semantic search',
  'a modular monolith',
  'server-side sessions',
  'Postgres LISTEN/NOTIFY for the queue',
  'cursor pagination',
  'Zod at every boundary',
  'pnpm workspaces',
  'row-level tenant filters',
  'Playwright for e2e',
  'a single Dockerfile',
  'structured JSON logs',
  'S3-compatible object storage',
  'feature flags in the database',
  'optimistic locking on items',
  'UTC timestamps everywhere',
]
const DOC_TITLES = [
  'Runbook: restoring the database from backup',
  'Architecture overview',
  'Onboarding for new developers',
  'Deploy checklist',
  'Provozní příručka: fronta e-mailů',
  'Incident response',
  'API conventions',
  'Návod na lokální vývoj',
  'Release process',
  'Data model reference',
  'Testing strategy',
  'Security checklist',
  'Pravidla pro code review',
  'Observability and alerts',
  'Postup při výpadku plateb',
  'Seat map file format',
  'Glossary',
  'Environment variables',
  'Postup nasazení na produkci',
  'Capacity planning',
]

const sentence = (cz: boolean) =>
  `${cz ? pick(SUBJ_CZ) : pick(SUBJ_EN)} ${cz ? pick(PRED_CZ) : pick(PRED_EN)}.`
const memTitle = (cz: boolean) => {
  const t = sentence(cz)
  return t[0]?.toUpperCase() + t.slice(1, -1)
}
const memBody = (cz: boolean) => `${sentence(cz)} ${sentence(cz)}${rnd() < 0.3 ? ` ${sentence(cz)}` : ''}`
const docBody = (cz: boolean) =>
  Array.from(
    { length: 4 + Math.floor(rnd() * 8) },
    (_, i) =>
      `## ${cz ? 'Krok' : 'Step'} ${i + 1}\n\n${Array.from({ length: 5 }, () => sentence(cz)).join(' ')}`,
  ).join('\n\n')

const hotDirs = tree.dirs.slice(0, 25) // anchors cluster in a few hot directories, like real repos
const anchorsFor = (): string[] => {
  const n = rnd() < 0.7 ? 1 : 2
  return Array.from({ length: n }, () => {
    const r = rnd()
    if (r < 0.5) return pick(tree.files)
    if (r < 0.9) return `${rnd() < 0.5 ? pick(hotDirs) : pick(tree.dirs)}/`
    return `${pick(hotDirs)}/**/*.ts`
  })
}

// ---- stats ------------------------------------------------------------------------------------------------

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number
}
/** Item lines under `## <name>` (roll-up lines `+N more` not counted). */
function sectionLines(text: string, name: string): number {
  const ls = text.split('\n')
  const i = ls.findIndex((l) => l === `## ${name}` || l.startsWith(`## ${name}:`))
  if (i < 0) return 0
  let n = 0
  for (let j = i + 1; j < ls.length && !(ls[j] as string).startsWith('## '); j++) {
    const l = ls[j] as string
    if (l && !l.startsWith('+') && !l.startsWith('(+')) n++
  }
  return n
}
const r1 = (n: number) => Math.round(n * 10) / 10
const timing = (ms: number[]) => ({
  n: ms.length,
  p50_ms: r1(pct(ms, 50)),
  p95_ms: r1(pct(ms, 95)),
  max_ms: r1(Math.max(...ms)),
})

// ---- main -------------------------------------------------------------------------------------------------

const { db, pool } = createDb(url, 5)
await runMigrations({ databaseUrl: url, migrateUrl: process.env.DATABASE_MIGRATE_URL ?? url })

async function truncateAll() {
  const res = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  )
  const t = res.rows.map((r) => `"public"."${r.tablename}"`)
  if (t.length) await pool.query(`TRUNCATE ${t.join(', ')} RESTART IDENTITY CASCADE`)
}

const provider = new LocalE5Provider({ modelDir, threads: 2 })
await provider.ready()
const deps: ServerDeps = {
  config: testConfig(),
  logger: pino({ level: 'silent' }),
  db,
  ports: {
    embeddings: new StaticEmbeddingRegistry(provider, []),
    search: new NoopSearchPort(),
    jobs: new MemoryJobsPort(),
  },
}
const mod = createSearchModule(deps)
deps.ports.search = mod.search

const e5Tokens = (text: string) => provider.countTokens(text) - provider.countTokens('')

async function addItem(opts: ItemOpts) {
  const item = await createItem(db, opts)
  const prepared = await mod.search.prepareChunks({
    projectId: item.projectId,
    space: item.space,
    title: item.title,
    tags: item.tags,
    body: item.body,
  })
  await withTx(db, (tx) =>
    mod.search.indexItemChunks(
      tx,
      { id: item.id, projectId: item.projectId, space: item.space, revision: item.revision },
      prepared,
    ),
  )
  return item
}

const out: Record<string, unknown> = {}
try {
  await truncateAll()
  const proj = await createProject(db, { slug: 'bench', embeddingModel: provider.tag })
  const shared = await createSharedProject(db)
  await db.execute(sql`UPDATE projects SET embedding_model = ${provider.tag} WHERE id = ${shared.id}`)

  // warm the model so the throughput number is steady state
  await mod.search.prepareChunks({
    projectId: proj.id,
    space: 'memories',
    title: 'warm-up',
    tags: [],
    body: '',
  })

  const TYPES = ['fact', 'fact', 'fact', 'procedure', 'decision', 'observation'] as const
  const t0 = performance.now()
  const ids: { id: string; kind: string }[] = []
  let count = 0

  // 300 memories: 40% anchored, 45% Czech, 6 pinned of 30 total later
  for (let i = 0; i < 300; i++) {
    const cz = rnd() < 0.45
    const it = await addItem({
      projectId: proj.id,
      space: 'memories',
      type: pick(TYPES),
      title: memTitle(cz),
      body: memBody(cz),
      tags: [pick(AREAS)],
      anchors: rnd() < 0.4 ? anchorsFor() : [],
      provenance: rnd() < 0.5 ? 'agent' : 'human',
    })
    ids.push({ id: it.id, kind: 'memory' })
    count++
  }
  // 40 ADRs: 25 accepted within 30 days, 10 accepted older, 5 proposed
  for (let i = 0; i < 40; i++) {
    const cz = rnd() < 0.4
    const title = `${cz ? pick(ADR_VERB_CZ) : pick(ADR_VERB_EN)} ${pick(ADR_OBJ)}${i > 14 ? ` (${i})` : ''}`
    const status = i < 35 ? 'accepted' : 'proposed'
    const it = await addItem({
      projectId: proj.id,
      space: 'decisions',
      title,
      body: `## Context\n\n${sentence(cz)}\n\n## Decision\n\n${sentence(cz)}\n\n## Consequences\n\n${sentence(cz)}`,
      status,
      anchors: rnd() < 0.4 ? anchorsFor() : [],
    })
    if (status === 'accepted') {
      const ago = i < 25 ? Math.floor(rnd() * 30) : 60 + Math.floor(rnd() * 300)
      await db.execute(sql`UPDATE items SET decided_on = current_date - ${ago}::int WHERE id = ${it.id}`)
    }
    ids.push({ id: it.id, kind: 'adr' })
    count++
  }
  // 20 docs (multi-chunk)
  for (let i = 0; i < 20; i++) {
    const cz = (DOC_TITLES[i] as string).match(/[áčďéěíňóřšťúůýž]/i) !== null
    const it = await addItem({
      projectId: proj.id,
      space: 'docs',
      title: DOC_TITLES[i] as string,
      body: docBody(cz),
      tags: ['ops'],
    })
    ids.push({ id: it.id, kind: 'doc' })
    count++
  }
  // 50 shared items (docs + memories), 4 pinned
  for (let i = 0; i < 50; i++) {
    const cz = rnd() < 0.5
    const asDoc = i % 5 === 0
    await addItem({
      projectId: shared.id,
      space: asDoc ? 'docs' : 'memories',
      type: asDoc ? undefined : pick(TYPES),
      title: asDoc ? `${cz ? 'Firemní standard' : 'Org standard'}: ${pick(ADR_OBJ)}` : memTitle(cz),
      body: asDoc ? docBody(cz) : memBody(cz),
      pinned: i < 4,
    })
    count++
  }
  const indexSecs = (performance.now() - t0) / 1000
  const chunkCount = Number((await pool.query('SELECT count(*) FROM chunks')).rows[0].count)
  // 30 pinned in the project: 8 ADRs, 6 docs, 16 memories
  const pinIds = [
    ...ids.filter((x) => x.kind === 'adr').slice(0, 8),
    ...ids.filter((x) => x.kind === 'doc').slice(0, 6),
    ...ids.filter((x) => x.kind === 'memory').slice(0, 16),
  ].map((x) => x.id)
  await db.execute(
    sql`UPDATE items SET pinned = true WHERE id IN (${sql.join(
      pinIds.map((i) => sql`${i}`),
      sql`, `,
    )})`,
  )
  await db.execute(sql`ANALYZE`)

  const counts = (
    await pool.query(
      `SELECT p.kind, i.space, count(*) n, count(*) FILTER (WHERE cardinality(i.anchors) > 0) anchored, count(*) FILTER (WHERE i.pinned) pinned
         FROM items i JOIN projects p ON p.id = i.project_id GROUP BY 1, 2 ORDER BY 1, 2`,
    )
  ).rows
  out.seed = {
    items: count,
    chunks: chunkCount,
    tree_files: tree.files.length,
    tree_dirs: tree.dirs.length,
    counts,
  }
  out.indexing = {
    items: count,
    chunks: chunkCount,
    seconds: r1(indexSecs),
    items_per_s: r1(count / indexSecs),
    chunks_per_s: r1(chunkCount / indexSecs),
    note: 'prepareChunks (embed, single-threaded SerialQueue, 2 ORT threads) + indexItemChunks (tx), sequential; factory insert for the item row',
  }

  // ---- digest ----------------------------------------------------------------------------------------------
  const anchoredRows = (
    await pool.query(`SELECT anchors FROM items WHERE project_id = $1 AND cardinality(anchors) > 0`, [
      proj.id,
    ])
  ).rows.flatMap((r) => r.anchors as string[])
  // an agent working on 5 files: files under the most anchored hot directories
  const concrete = anchoredRows.filter((a) => !a.endsWith('/') && !a.includes('*'))
  const dirAnch = anchoredRows.filter((a) => a.endsWith('/'))
  const fileSets: string[][] = Array.from({ length: 5 }, (_, i) => [
    concrete[i * 3] as string,
    concrete[i * 3 + 1] as string,
    `${dirAnch[i] ?? hotDirs[i]}x-${i}.ts`,
    `${hotDirs[i]}/new-${i}.ts`,
    tree.files[i * 40] as string,
  ])
  const queries = [
    'session expiry',
    'platnost relace a odhlášení',
    'payment webhook retries',
    'jak funguje fronta e-mailů',
    'idempotency keys checkout',
    'migrace databáze nasazení',
    'rate limiting API',
    'refund handling',
  ]
  const REPS = 20
  const digest: unknown[] = []
  for (const budget of [1500, 2500]) {
    for (const withFiles of [false, true]) {
      for (const withQuery of [false, true]) {
        const ms: number[] = []
        const est: number[] = []
        const e5: number[] = []
        const lines: number[] = []
        const items_: number[] = []
        let tiers: string[] = []
        const anchoredLines: number[] = []
        // one warm-up call (first query embed / plan cache) is excluded and reported separately
        const warm = performance.now()
        await mod.context.build({
          projectId: proj.id,
          budget,
          query: withQuery ? 'warm up query' : null,
          files: withFiles ? (fileSets[0] as string[]) : [],
          includeShared: true,
        })
        const warmMs = performance.now() - warm
        for (let i = 0; i < REPS; i++) {
          const t = performance.now()
          const res = await mod.context.build({
            projectId: proj.id,
            budget,
            query: withQuery ? (queries[i % queries.length] as string) : null,
            files: withFiles ? (fileSets[i % fileSets.length] as string[]) : [],
            includeShared: true,
          })
          ms.push(performance.now() - t)
          est.push(estimateTokens(res.text))
          e5.push(e5Tokens(res.text))
          lines.push(res.text.split('\n').length)
          items_.push(
            (res as unknown as { itemCount?: number }).itemCount ??
              Number(/· (\d+) items/.exec(res.text)?.[1] ?? 0),
          )
          anchoredLines.push(sectionLines(res.text, 'Anchored'))
          if (i === 0)
            tiers = res.text
              .split('\n')
              .filter((l) => l.startsWith('## '))
              .map((l) => l.slice(3))
        }
        digest.push({
          budget,
          files: withFiles,
          query: withQuery,
          est_max: Math.max(...est),
          est_p50: pct(est, 50),
          e5_max: Math.max(...e5),
          e5_p50: pct(e5, 50),
          items_p50: pct(items_, 50),
          anchored_lines_min: withFiles ? Math.min(...anchoredLines) : null,
          anchored_lines_p50: withFiles ? pct(anchoredLines, 50) : null,
          overrun: Math.max(...est) > budget,
          first_call_ms: r1(warmMs),
          ...timing(ms),
          sections: tiers,
        })
      }
    }
  }
  out.digest = digest
  // one sample (budget 1500, files + query) for the doc
  out.digest_sample = (
    await mod.context.build({
      projectId: proj.id,
      budget: 1500,
      query: 'session expiry',
      files: fileSets[0] as string[],
      includeShared: true,
    })
  ).text

  // ---- spoor_search ----------------------------------------------------------------------------------------
  {
    const ms: number[] = []
    const est: number[] = []
    const e5: number[] = []
    await mod.search.search({
      projectId: proj.id,
      query: 'warm up',
      limit: 8,
      includeShared: true,
      includeInactive: false,
    })
    for (let i = 0; i < REPS; i++) {
      const q = queries[i % queries.length] as string
      const t = performance.now()
      const res = await mod.search.search({
        projectId: proj.id,
        query: q,
        limit: 8,
        includeShared: true,
        includeInactive: false,
      })
      ms.push(performance.now() - t)
      const text = formatSearchResults(q, res)
      est.push(estimateTokens(text))
      e5.push(e5Tokens(text))
    }
    out.search = {
      limit: 8,
      ...timing(ms),
      est_p50: pct(est, 50),
      est_max: Math.max(...est),
      e5_p50: pct(e5, 50),
      e5_max: Math.max(...e5),
    }
  }

  // ---- tools/list ------------------------------------------------------------------------------------------
  {
    const row: Record<string, unknown> = {}
    for (const role of ['editor', 'viewer'] as const) {
      const server = buildMcpServer({ logger: pino({ level: 'silent' }) } as unknown as McpServices, role)
      const [a, b] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: 'bench', version: '1' })
      await Promise.all([server.connect(a), client.connect(b)])
      const list = await client.listTools()
      const json = JSON.stringify(list)
      row[role] = {
        tools: list.tools.length,
        chars: json.length,
        est: estimateTokens(json),
        e5: e5Tokens(json),
      }
      await client.close()
    }
    out.tools_list = row
  }

  // ---- dedupe ----------------------------------------------------------------------------------------------
  {
    const prep: number[] = []
    const chk: number[] = []
    const sample = (
      await pool.query(
        `SELECT title, body, tags FROM items WHERE project_id = $1 AND space = 'memories' AND type = 'fact' ORDER BY number LIMIT 40`,
        [proj.id],
      )
    ).rows as { title: string; body: string; tags: string[] }[]
    const hits = { full_text: 0, title_only: 0, new_text_false_positive: 0 }
    const N = 10
    for (const kind of ['full_text', 'title_only', 'new'] as const) {
      for (let i = 0; i < N; i++) {
        const row = sample[i] as { title: string; body: string; tags: string[] }
        const probe =
          kind === 'new'
            ? { title: `${memTitle(rnd() < 0.5)} ${i}`, body: '', tags: [] as string[] }
            : {
                title: row.title,
                body: kind === 'full_text' ? row.body : '',
                tags: kind === 'full_text' ? row.tags : [],
              }
        const t1 = performance.now()
        const prepared = await mod.search.prepareChunks({ projectId: proj.id, space: 'memories', ...probe })
        const t2 = performance.now()
        const res = await mod.search.dedupeCandidates(db, {
          projectId: proj.id,
          space: 'memories',
          type: 'fact',
          prepared,
        })
        const t3 = performance.now()
        prep.push(t2 - t1)
        chk.push(t3 - t2)
        const hit = firstDuplicate(res, SETTINGS_DEFAULTS.dedupe.threshold) !== undefined
        if (hit && kind === 'full_text') hits.full_text++
        if (hit && kind === 'title_only') hits.title_only++
        if (hit && kind === 'new') hits.new_text_false_positive++
      }
    }
    const tot = prep.map((p, i) => p + (chk[i] as number))
    out.dedupe = {
      probes: tot.length,
      embed_probe: timing(prep),
      sql_check: timing(chk),
      total_p50_ms: r1(pct(tot, 50)),
      total_p95_ms: r1(pct(tot, 95)),
      threshold_0_92_hits: { ...hits, of_each: N },
    }
  }
} finally {
  await pool.end().catch(() => {})
  await adminSql(`DROP DATABASE IF EXISTS ${BENCH_DB} WITH (FORCE)`).catch((e) =>
    console.error('cleanup failed', e),
  )
}
console.log(JSON.stringify(out, null, 2))
process.exit(0)
