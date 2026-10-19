/**
 * End to end: BRIEF.md definition of done, items 2 and 3, from a teammate's point of view.
 *
 * The real server (createRuntime + createApp + startup, real migrations, real scheduler and SearchService; only
 * the embedding model is the deterministic fake, since the e5 model is not downloaded in CI) listens on a
 * random port against its own database (`<test db>_e2e_test`, test/e2e/global-setup.ts). The built CLI
 * (packages/cli/dist/bin.js) runs as a child process in a temp git repo, behind a `spoor` shim on PATH, and the
 * hooks run exactly as Claude Code would run them: the `command` strings `spoor init` wrote into
 * `.claude/settings.json`, through `sh -c`, with the hook JSON on stdin and CLAUDE_PROJECT_DIR set. The MCP
 * calls go through the SDK client with the URL and header of the `.mcp.json` that `spoor init` wrote. The
 * browser side (device approval, accepting the invite) is the cookie API over HTTP.
 *
 * Walk: bootstrap admin → project + user via REST → `spoor login` (device flow, approved in the browser
 * session) → init files → `spoor adr import` of two existing ADRs → PostToolUse push of an edited ADR →
 * spoor_decide (+ remember / search / context with anchors) over MCP → Stop with a fake SPOOR_DRAFT_CMD drafts
 * a proposed ADR file and pushes it → SessionStart digest → Stop nags exactly once in a session with changed
 * files and no writes → hooks still exit 0 fast with the server down.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { serve } from '@hono/node-server'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { pino } from 'pino'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { type AppModules, createApp, createAppModules } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { createDb } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createRuntime, type Runtime, shutdown, startup } from '../../src/runtime.js'
import { newReadyState } from '../../src/types.js'
import { FakeEmbeddingProvider, StaticEmbeddingRegistry } from '../ports.js'
import { CLI_BIN } from './paths.js'

const ADMIN = { email: 'admin@example.com', password: 'admin-password-e2e' }
const DEV = { email: 'dev@example.com', password: 'dev-password-e2e-1', name: 'Dev Eloper' }
const SLUG = 'acme'
const MCP_CLIENT = { name: 'claude-code', version: '2.1.400' }
const DECISION_TITLE = 'Cache rendered digests in Redis for 60 seconds'

// ---------------------------------------------------------------- server ----

let base = ''
let rt: Runtime
let modules: AppModules
let httpServer: ReturnType<typeof serve> | undefined
let endPool: () => Promise<void>

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => resolve(port))
    })
  })
}

function closeHttp(): Promise<void> {
  const s = httpServer
  httpServer = undefined
  if (!s) return Promise.resolve()
  return new Promise((resolve) => {
    s.close(() => resolve())
    ;(s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
  })
}

async function bootServer(): Promise<void> {
  const databaseUrl = inject('e2eDatabaseUrl')
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    SPOOR_PUBLIC_URL: base,
    SPOOR_PORT: String(port),
    SPOOR_HOST: '127.0.0.1',
    SPOOR_ADMIN_EMAIL: ADMIN.email,
    SPOOR_ADMIN_PASSWORD: ADMIN.password,
    SPOOR_WEB_DIR: join(tmpdir(), 'spoor-e2e-no-spa'),
    NODE_ENV: 'test',
  })
  const logger = pino({ level: 'silent' })
  const { pool, db } = createDb(config.DATABASE_URL, 5)
  endPool = () => pool.end()
  rt = createRuntime(
    { config, logger, db },
    {
      embeddings: new StaticEmbeddingRegistry(new FakeEmbeddingProvider()),
      scheduler: { instanceId: 'e2e' },
    },
  )
  modules = createAppModules(rt.deps, { scheduler: rt.scheduler, search: rt.search })
  const state = newReadyState()
  const app = createApp({
    config,
    logger,
    state,
    ports: rt.ports,
    modules,
    pingDb: () => pool.query('SELECT 1').then(() => true),
  })
  httpServer = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })
  // the real startup: migrations on an empty database, shared project, bootstrap admin, provider, scheduler
  await startup(rt, state, {
    migrate: () => runMigrations({ databaseUrl, migrateUrl: databaseUrl }),
  })
  const health = await fetch(`${base}/healthz`)
  expect(health.status).toBe(200)
}

/** The SPA's side of the API: cookie jar and the same-origin `Origin` header the server checks. */
class Browser {
  readonly cookies = new Map<string, string>()
  async request(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { origin: base }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (this.cookies.size > 0) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    for (const sc of res.headers.getSetCookie()) {
      const [pair = ''] = sc.split(';')
      const eq = pair.indexOf('=')
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
    return res
  }
  async json<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    status = 200,
  ): Promise<T> {
    const res = await this.request(method, path, body)
    const text = await res.text()
    expect(res.status, `${method} ${path}: ${text}`).toBe(status)
    return JSON.parse(text) as T
  }
}

// ---------------------------------------------------------------- repo + CLI ----

let work = ''
let repo = ''
let binDir = ''
let draftScript = ''
let draftLog = ''

/** The environment of a developer machine: none of this process's SPOOR_* / Claude Code / CI variables. */
function cliEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('SPOOR_') || k.startsWith('CLAUDE') || k === 'CI' || k.startsWith('VITEST')) continue
    if (k === 'NODE_OPTIONS' || k === 'DATABASE_URL') continue
    env[k] = v
  }
  env.PATH = `${binDir}${delimiter}${process.env.PATH ?? ''}`
  return { ...env, ...extra }
}

interface Run {
  code: number | null
  stdout: string
  stderr: string
  ms: number
}

function collect(child: ChildProcess, started: number): Promise<Run> {
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', (c: string) => {
    stdout += c
  })
  child.stderr?.setEncoding('utf8').on('data', (c: string) => {
    stderr += c
  })
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }))
  })
}

/** `spoor <args>` as a human runs it in the repo. */
function spoor(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<Run> {
  const child = spawn(process.execPath, [CLI_BIN, ...args], { cwd: repo, env: cliEnv(opts.env) })
  const done = collect(child, Date.now())
  child.stdin?.end(opts.input ?? '')
  return done
}

type HookEvent = 'SessionStart' | 'PostToolUse' | 'Stop'

/** The hook `command` that `spoor init` wrote for this event (and tool), run as Claude Code runs it. */
function hookCommand(event: HookEvent, tool?: string): string {
  const settings = readJson(join(repo, '.claude', 'settings.json'))
  const groups = (settings.hooks as Record<string, { matcher?: string; hooks: { command: string }[] }[]>)[
    event
  ]
  const group = groups?.find(
    (g) => !g.matcher || (tool !== undefined && new RegExp(`^(${g.matcher})$`).test(tool)),
  )
  const command = group?.hooks[0]?.command
  if (!command) throw new Error(`no ${event} hook for ${tool ?? '-'} in .claude/settings.json`)
  return command
}

function hook(
  event: HookEvent,
  input: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<Run> {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : undefined
  const child = spawn('/bin/sh', ['-c', hookCommand(event, tool)], {
    cwd: repo,
    env: cliEnv({ CLAUDE_PROJECT_DIR: repo, ...env }),
  })
  const done = collect(child, Date.now())
  child.stdin?.end(
    JSON.stringify({
      transcript_path: join(work, 'transcript.jsonl'),
      cwd: repo,
      hook_event_name: event,
      ...input,
    }),
  )
  return done
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: cliEnv() })
}

async function waitFor<T>(what: string, fn: () => T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ADR_1 = `# 1. Use Postgres with pgvector

Date: 2025-03-02

## Status

Accepted

## Context

We need one store for items, full-text search and vectors.

## Decision

We use Postgres 17 with the pgvector extension.

## Consequences

- One database to operate.
`

const ADR_2 = `---
adr: 2
title: Use Hono for the HTTP server
status: accepted
date: 2025-03-05
---
# Use Hono for the HTTP server

## Context

The server needs a small, typed router that runs on Node 22.

## Decision

We use Hono.

## Consequences

- Web-standard Request/Response everywhere.
`

function setupRepo(): void {
  work = mkdtempSync(join(tmpdir(), 'spoor-e2e-'))
  repo = join(work, 'repo')
  binDir = join(work, 'bin')
  mkdirSync(join(repo, 'docs', 'adr'), { recursive: true })
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(binDir)
  // `spoor` on PATH, as after `npm i -g spoor-memory`
  writeFileSync(join(binDir, 'spoor'), `#!/bin/sh\nexec "${process.execPath}" "${CLI_BIN}" "$@"\n`)
  chmodSync(join(binDir, 'spoor'), 0o755)
  // the drafting model: records what it was given, answers with a valid ADR body (cli-and-hooks.md section 6)
  draftLog = join(work, 'draft.log')
  draftScript = join(work, 'fake-model.sh')
  writeFileSync(
    draftScript,
    [
      '#!/bin/sh',
      `{ echo "SPOOR_DRAFTING=$SPOOR_DRAFTING"; echo "ARG=$(printf '%s' "$1" | head -c 60)"; cat; } >> '${draftLog}'`,
      "cat <<'MD'",
      '# Whatever the model calls it',
      '',
      '## Context',
      'Rendering the digest is slow when many sessions start at once.',
      '',
      '## Decision',
      'We will cache rendered digests in Redis for 60 seconds.',
      '',
      '## Consequences',
      '- Session starts get faster.',
      '- Trade-off: a digest can be up to 60 seconds old.',
      'MD',
      '',
    ].join('\n'),
  )
  chmodSync(draftScript, 0o755)
  writeFileSync(join(repo, 'docs', 'adr', '0001-use-postgres-with-pgvector.md'), ADR_1)
  writeFileSync(join(repo, 'docs', 'adr', '0002-use-hono.md'), ADR_2)
  writeFileSync(join(repo, 'src', 'app.ts'), 'export const app = 1\n')
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-q', '-m', 'initial')
}

// ---------------------------------------------------------------- the walk ----

const admin = new Browser()
const dev = new Browser()
let token = ''
let decisionHandle = ''
let draftedRel = ''

const bearer = async <T = Record<string, unknown>>(path: string): Promise<T> => {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
  const text = await res.text()
  expect(res.status, `${path}: ${text}`).toBe(200)
  return JSON.parse(text) as T
}

const item = (ref: string) =>
  dev.json<{
    handle: string
    revision: number
    title: string
    body: string
    status: string | null
    source_path: string | null
  }>('GET', `/api/v1/projects/${SLUG}/items/${encodeURIComponent(ref)}`)

beforeAll(async () => {
  await bootServer()
  setupRepo()
}, 120_000)

afterAll(async () => {
  modules?.mcp.close()
  if (rt) await shutdown(rt, { closeServer: closeHttp, endPool: () => endPool() })
  // a detached drafting run may still be finishing: wait for its lock, then remove the temp repo
  if (work) {
    await waitFor('the drafting lock', () => !existsSync(join(repo, '.spoor', 'draft.lock')), 10_000).catch(
      () => {},
    )
    rmSync(work, { recursive: true, force: true })
  }
}, 60_000)

describe('DoD 2: admin sets up a project and a user; the user logs in from the repo with the device flow', () => {
  it('the bootstrap admin creates the project and invites the user, who accepts in the browser', async () => {
    await admin.json('POST', '/api/v1/auth/login', ADMIN)
    await admin.json('POST', '/api/v1/projects', { slug: SLUG, name: 'Acme' }, 201)
    const invite = await admin.json<{ token: string; link: string }>(
      'POST',
      '/api/v1/invites',
      { email: DEV.email, grants: [{ project: SLUG, role: 'editor' }] },
      201,
    )
    expect(invite.link).toBe(`${base}/invite#${invite.token}`)
    await dev.json(
      'POST',
      '/api/v1/invites/accept',
      { token: invite.token, name: DEV.name, password: DEV.password },
      201,
    )
    const me = await dev.json<{ memberships: { project: { slug: string }; role: string }[] }>(
      'GET',
      '/api/v1/me',
    )
    expect(me.memberships).toEqual([
      expect.objectContaining({ project: expect.objectContaining({ slug: SLUG }), role: 'editor' }),
    ])

    // the public install doc is what the agent follows
    const md = await fetch(`${base}/p/${SLUG}/install.md`)
    expect(md.status).toBe(200)
    const doc = await md.text()
    expect(doc).toContain(`spoor login --server ${base} --project ${SLUG} --no-browser`)
    expect(doc).not.toMatch(/spr_[A-Za-z0-9]/)
  })

  it('spoor login runs the device flow; the user approves the code in the browser session; init writes the repo files', async () => {
    const child = spawn(
      process.execPath,
      [CLI_BIN, 'login', '--server', base, '--project', SLUG, '--no-browser'],
      {
        cwd: repo,
        env: cliEnv(),
      },
    )
    child.stdin?.end()
    const done = collect(child, Date.now())
    let out = ''
    child.stdout?.on('data', (c: string) => {
      out += c
    })
    const code = await waitFor(
      'the user code',
      () => /enter the code ([A-Z]{4}-[A-Z]{4})/.exec(out)?.[1],
      20_000,
    )
    expect(out).toContain(`Open ${base}/device`)

    const lookup = await dev.json<{ project: { slug: string }; client_name: string; your_role: string }>(
      'GET',
      `/api/v1/device/lookup?code=${code}`,
    )
    expect(lookup).toMatchObject({ project: { slug: SLUG }, your_role: 'editor' })
    expect(lookup.client_name).toMatch(/^spoor-cli\//)
    await dev.json('POST', '/api/v1/device/approve', { code })

    const run = await done
    expect(run.stderr).toBe('')
    expect(run.code).toBe(0)
    // the actor label is the email (data-model.md, actor_label)
    expect(run.stdout).toContain(`Logged in as ${DEV.email} to "${SLUG}" with role editor (token expires `)
    // login itself adds the .gitignore lines before init merges install.json
    expect(run.stdout).toContain('created .mcp.json\ncreated .claude/settings.json\nunchanged .gitignore\n')

    // .claude/settings.local.json: the token, never committed, 0600
    const localPath = join(repo, '.claude', 'settings.local.json')
    const local = readJson(localPath) as { env: Record<string, string> }
    expect(local.env).toMatchObject({ SPOOR_URL: base, SPOOR_PROJECT: SLUG })
    expect(local.env.SPOOR_TOKEN).toMatch(/^spr_/)
    token = local.env.SPOOR_TOKEN as string
    expect(statSync(localPath).mode & 0o777).toBe(0o600)
    expect(git('check-ignore', '.claude/settings.local.json', '.spoor/x').trim().split('\n')).toHaveLength(2)

    // .mcp.json and .claude/settings.json reference the token only as ${SPOOR_TOKEN}
    const mcp = readJson(join(repo, '.mcp.json')) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(mcp.mcpServers.spoor).toMatchObject({
      type: 'http',
      url: `${base}/p/${SLUG}/mcp`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder Claude Code expands
      headers: { Authorization: 'Bearer ${SPOOR_TOKEN}' },
    })
    const settings = readJson(join(repo, '.claude', 'settings.json')) as {
      permissions: { allow: string[] }
      hooks: Record<string, unknown[]>
    }
    expect(settings.permissions.allow).toContain('mcp__spoor')
    expect(Object.keys(settings.hooks).sort()).toEqual(['PostToolUse', 'SessionStart', 'Stop'])
    for (const f of ['.mcp.json', '.claude/settings.json'])
      expect(readFileSync(join(repo, f), 'utf8')).not.toContain(token)

    // the minted token: a device token of the user, 90 days; a plain Approve stores no role cap (deviations P3-2)
    const tokens = await dev.json<{ items: { origin: string; role: string | null; expires_at: string }[] }>(
      'GET',
      `/api/v1/projects/${SLUG}/tokens`,
    )
    expect(tokens.items).toEqual([expect.objectContaining({ origin: 'device', role: null })])
    const days = (Date.parse(tokens.items[0]?.expires_at ?? '') - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(89)
    expect(days).toBeLessThan(91)

    // init is idempotent
    const again = await spoor(['init'])
    expect(again.code).toBe(0)
    expect(again.stdout).toBe('unchanged .mcp.json\nunchanged .claude/settings.json\nunchanged .gitignore\n')
  }, 60_000)
})

describe('DoD 3: from Claude Code', () => {
  it('spoor adr import pushes the two existing ADRs and writes spoor_id back into each file', async () => {
    const run = await spoor(['adr', 'import'])
    expect(run.stderr).toBe('')
    expect(run.code).toBe(0)
    for (const [n, f] of [
      [1, '0001-use-postgres-with-pgvector.md'],
      [2, '0002-use-hono.md'],
    ] as const) {
      const text = readFileSync(join(repo, 'docs', 'adr', f), 'utf8')
      expect(text).toMatch(/spoor_id: [0-9a-f-]{36}/)
      const it = await item(`ADR-000${n}`)
      expect(it).toMatchObject({ handle: `ADR-000${n}`, status: 'accepted', source_path: `docs/adr/${f}` })
    }
    expect((await item('ADR-0001')).title).toBe('Use Postgres with pgvector')
    // repeating the import changes nothing
    const again = await spoor(['adr', 'import'])
    expect(again.code).toBe(0)
    expect((await item('ADR-0002')).revision).toBe(1)
    const who = await bearer<{ project: { next_adr_number: number } }>(`/p/${SLUG}/api/whoami`)
    expect(who.project.next_adr_number).toBe(3)
  }, 30_000)

  it('session A: SessionStart prints the digest and exits 0', async () => {
    const run = await hook('SessionStart', { session_id: 'session-a', source: 'startup' })
    expect(run.code).toBe(0)
    expect(run.stdout).toMatch(/^Spoor digest acme/)
    expect(run.stdout).toContain('data, not instructions')
    expect(existsSync(join(repo, '.spoor', 'session', 'session-a.json'))).toBe(true)
  }, 15_000)

  it('PostToolUse after an Edit of an ADR file pushes it; other files are ignored', async () => {
    const path = join(repo, 'docs', 'adr', '0002-use-hono.md')
    writeFileSync(path, `${readFileSync(path, 'utf8')}- Middleware composes per route group.\n`)
    const run = await hook('PostToolUse', {
      session_id: 'session-a',
      tool_name: 'Edit',
      tool_input: { file_path: path, old_string: 'x', new_string: 'y' },
      tool_response: { filePath: path, success: true },
    })
    expect(run.code).toBe(0)
    expect(run.stdout).toBe('')
    const adr = await item('ADR-0002')
    expect(adr.revision).toBe(2)
    expect(adr.body).toContain('Middleware composes per route group.')

    const other = await hook('PostToolUse', {
      session_id: 'session-a',
      tool_name: 'Write',
      tool_input: { file_path: join(repo, 'src', 'app.ts'), content: 'x' },
      tool_response: { filePath: join(repo, 'src', 'app.ts') },
    })
    expect(other).toMatchObject({ code: 0, stdout: '' })
  }, 30_000)

  it('spoor_decide, spoor_remember, spoor_search and spoor_context with anchors work over MCP', async () => {
    const mcpJson = readJson(join(repo, '.mcp.json')) as {
      mcpServers: { spoor: { url: string; headers: Record<string, string> } }
    }
    const { url, headers } = mcpJson.mcpServers.spoor
    // what Claude Code does with ${SPOOR_TOKEN} from settings.local.json's env
    const resolved = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k, v.replace(/\$\{SPOOR_TOKEN\}/g, token)]),
    )
    const client = new McpClient(MCP_CLIENT)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: resolved } }),
    )
    try {
      const text = (r: Awaited<ReturnType<typeof client.callTool>>) => {
        expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
        return (r.content as { type: string; text: string }[]).map((c) => c.text).join('\n')
      }
      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name).sort()).toEqual(
        [
          'spoor_context',
          'spoor_decide',
          'spoor_doc_write',
          'spoor_get',
          'spoor_relate',
          'spoor_remember',
          'spoor_search',
          'spoor_supersede',
          'spoor_verify',
        ].sort(),
      )

      const decided = text(
        await client.callTool({
          name: 'spoor_decide',
          arguments: {
            title: DECISION_TITLE,
            body: 'Digest rendering is slow when many sessions start at once. Rejected: an in-process LRU (not shared between replicas).',
            anchors: ['src/cache/**'],
            tags: ['cache'],
          },
        }),
      )
      expect(decided).toMatch(/^OK decided m\d+ r1 \[dec\]/)
      decisionHandle = /OK decided (m\d+)/.exec(decided)?.[1] as string

      const remembered = text(
        await client.callTool({
          name: 'spoor_remember',
          arguments: {
            title: 'Integration tests need the pgvector container on port 55432',
            type: 'fact',
            anchors: ['packages/server/test/**'],
          },
        }),
      )
      expect(remembered).toMatch(/^OK created m\d+ r1 \[fact\]/)

      const found = text(
        await client.callTool({ name: 'spoor_search', arguments: { query: 'Redis digest cache' } }),
      )
      expect(found).toContain(decisionHandle)

      const digest = text(
        await client.callTool({ name: 'spoor_context', arguments: { files: ['src/cache/redis.ts'] } }),
      )
      expect(digest).toContain('## Anchored')
      expect(digest).toMatch(new RegExp(`${decisionHandle}~ \\[dec\\] ${DECISION_TITLE} @src/cache/\\*\\*`))
    } finally {
      await client.close()
    }
    // every write records the token owner and the MCP client name
    const audit = await dev.json<{
      items: { action: string; actor: { label: string; client_name: string | null; via: string } }[]
    }>('GET', `/api/v1/projects/${SLUG}/audit?item=${decisionHandle}`)
    expect(audit.items[0]).toMatchObject({
      action: 'item.create',
      actor: expect.objectContaining({
        label: DEV.email,
        via: 'mcp',
        client_name: `${MCP_CLIENT.name}/${MCP_CLIENT.version}`,
      }),
    })

    // the session also changed code
    mkdirSync(join(repo, 'src', 'cache'), { recursive: true })
    writeFileSync(join(repo, 'src', 'cache', 'redis.ts'), 'export const ttl = 60\n')
  }, 30_000)

  it('Stop after a session with writes does not nag; it drafts a proposed ADR from the decision and pushes it', async () => {
    const run = await hook(
      'Stop',
      { session_id: 'session-a', stop_hook_active: false },
      { SPOOR_DRAFT_CMD: `sh '${draftScript}'`, SPOOR_E2E: '1' },
    )
    expect(run.code).toBe(0)
    expect(run.stdout).toBe('')
    expect(run.ms).toBeLessThan(6000)

    // the detached `spoor adr draft --background` writes docs/adr/0003-*.md, pushes it and writes spoor_id back
    const adrDir = join(repo, 'docs', 'adr')
    const name = await waitFor('the drafted ADR file with its spoor_id', () => {
      const f = readdirSync(adrDir).find((n) => n.startsWith('0003-'))
      return f && /spoor_id: /.test(readFileSync(join(adrDir, f), 'utf8')) ? f : undefined
    })
    draftedRel = `docs/adr/${name}`
    expect(name).toBe('0003-cache-rendered-digests-in-redis-for-60-seconds.md')
    const file = readFileSync(join(repo, draftedRel), 'utf8')
    expect(file).toMatch(/^---\nspoor_id: [0-9a-f-]{36}\nadr: 3\n/)
    expect(file).toContain(`title: ${DECISION_TITLE}`)
    expect(file).toContain('status: proposed')
    expect(file).toContain(`drafted_from: [${decisionHandle}]`)
    expect(file).toContain('anchors: [src/cache/**]')
    expect(file).toContain(`# ${DECISION_TITLE}\n`) // the H1 is the memory's title, not the model's
    expect(file).toContain('We will cache rendered digests in Redis for 60 seconds.')

    // the drafting command ran with SPOOR_DRAFTING=1, the instruction as its last argument, the note on stdin
    const log = readFileSync(draftLog, 'utf8')
    expect(log).toContain('SPOOR_DRAFTING=1')
    expect(log).toContain('ARG=You are drafting an Architecture Decision Record')
    expect(log).toContain(`Handle: ${decisionHandle}`)

    const adr = await item('ADR-0003')
    expect(adr).toMatchObject({ status: 'proposed', title: DECISION_TITLE, source_path: draftedRel })
    const edges = await dev.json<{ outgoing: { kind: string; other: { handle: string } | null }[] }>(
      'GET',
      `/api/v1/projects/${SLUG}/items/ADR-0003/edges`,
    )
    expect(edges.outgoing).toContainEqual(
      expect.objectContaining({
        kind: 'drafted_from',
        other: expect.objectContaining({ handle: decisionHandle }),
      }),
    )
    const undrafted = await bearer<{ items: unknown[] }>(`/p/${SLUG}/api/decisions/undrafted`)
    expect(undrafted.items).toEqual([])
  }, 45_000)

  it('SessionStart digest: the decision while its ADR is proposed; the ADR once a human accepts it', async () => {
    const before = await hook('SessionStart', { session_id: 'session-b', source: 'startup' })
    expect(before.code).toBe(0)
    // the new draft is announced once, before the digest (review-log-phase5 A13)
    const [announce, ...digest] = before.stdout.split('\n')
    expect(announce).toBe(
      `Spoor: 1 ADR draft was written from recorded decisions and waits for a human to accept (status: proposed): ${draftedRel} (ADR-0003). Tell the user.`,
    )
    expect(digest.join('\n')).toMatch(/^Spoor digest acme/)
    // proposed ADRs stay out of the digest (BRIEF amendment I34, search-and-digest.md section 7); the decision
    // memory represents them until then, here through the anchor on the changed src/cache/redis.ts
    expect(before.stdout).toContain(`${decisionHandle}~ [dec] ${DECISION_TITLE}`)
    expect(digest.join('\n')).not.toContain('ADR-0003')

    // the human accepts the draft in the repo and pushes it
    const path = join(repo, draftedRel)
    writeFileSync(path, readFileSync(path, 'utf8').replace('status: proposed', 'status: accepted'))
    const push = await spoor(['adr', 'push', draftedRel])
    expect(push.stderr).toBe('')
    expect(push.code).toBe(0)
    expect((await item('ADR-0003')).status).toBe('accepted')

    const after = await hook('SessionStart', { session_id: 'session-b2', source: 'startup' })
    expect(after.code).toBe(0)
    expect(after.stdout).toMatch(/^Spoor digest acme/) // announced once only
    expect(after.stdout).toContain('## Decisions (30d)')
    expect(after.stdout).toMatch(new RegExp(`ADR-0003 \\[accepted \\d{4}-\\d{2}-\\d{2}\\] ${DECISION_TITLE}`))
    // the accepted ADR now represents the decision memory
    expect(after.stdout).not.toContain(`${decisionHandle}~ [dec]`)
  }, 30_000)

  it('Stop nags exactly once in a session that changed files and recorded nothing', async () => {
    const start = await hook('SessionStart', { session_id: 'session-c', source: 'startup' })
    expect(start.code).toBe(0)
    await sleep(20)
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const feature = true\n')

    const first = await hook('Stop', { session_id: 'session-c', stop_hook_active: false })
    expect(first.code).toBe(0)
    const block = JSON.parse(first.stdout) as { decision: string; reason: string }
    expect(block.decision).toBe('block')
    expect(block.reason).toContain('src/feature.ts')
    expect(block.reason).toContain('spoor_decide')
    expect(block.reason).toContain('once per session')

    // Claude Code continues with stop_hook_active=true, then the session may stop again later: no second nag
    const second = await hook('Stop', { session_id: 'session-c', stop_hook_active: true })
    expect(second).toMatchObject({ code: 0, stdout: '' })
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const feature = false\n')
    const third = await hook('Stop', { session_id: 'session-c', stop_hook_active: false })
    expect(third).toMatchObject({ code: 0, stdout: '' })
    expect(existsSync(join(repo, '.spoor', 'session', 'session-c.nagged'))).toBe(true)
  }, 30_000)

  it('a draft the CLI pushes on its own does not count as recording: the next Stop still nags (review-log-phase5 A3)', async () => {
    // a decision recorded before this session, still undrafted
    const mcpJson = readJson(join(repo, '.mcp.json')) as {
      mcpServers: { spoor: { url: string; headers: Record<string, string> } }
    }
    const { url, headers } = mcpJson.mcpServers.spoor
    const resolved = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k, v.replace(/\$\{SPOOR_TOKEN\}/g, token)]),
    )
    const client = new McpClient(MCP_CLIENT)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: resolved } }),
    )
    try {
      const r = await client.callTool({
        name: 'spoor_decide',
        arguments: { title: 'Ship the CLI as one bundled file', body: 'Fewer install failures.' },
      })
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy()
    } finally {
      await client.close()
    }
    await sleep(20)
    expect((await hook('SessionStart', { session_id: 'session-e', source: 'startup' })).code).toBe(0)
    // first Stop: nothing changed yet, so no nag; it starts drafting, which pushes ADR-0004 with the (auto) User-Agent
    const first = await hook(
      'Stop',
      { session_id: 'session-e', stop_hook_active: false },
      { SPOOR_DRAFT_CMD: `sh '${draftScript}'`, SPOOR_E2E: '1' },
    )
    expect(first).toMatchObject({ code: 0, stdout: '' })
    const adrDir = join(repo, 'docs', 'adr')
    await waitFor('the second drafted ADR, pushed', () => {
      const f = readdirSync(adrDir).find((n) => n.startsWith('0004-'))
      return f && /spoor_id: /.test(readFileSync(join(adrDir, f), 'utf8')) ? f : undefined
    })
    expect((await item('ADR-0004')).status).toBe('proposed')
    // then the session changes code and records nothing: the draft push must not suppress the nag
    writeFileSync(join(repo, 'src', 'bundle.ts'), 'export const bundled = true\n')
    const second = await hook('Stop', { session_id: 'session-e', stop_hook_active: false })
    expect(second.code).toBe(0)
    expect((JSON.parse(second.stdout) as { decision: string; reason: string }).reason).toContain(
      'src/bundle.ts',
    )
  }, 45_000)

  it('with the server down, hooks still exit 0 within their deadline (SessionStart prints one notice)', async () => {
    await closeHttp()
    const start = await hook('SessionStart', { session_id: 'session-d', source: 'startup' })
    expect(start.code).toBe(0)
    expect(start.ms).toBeLessThan(7000)
    // local status lines still come first (here the ADR-0004 draft of the previous test), then the one notice
    const lines = start.stdout.trimEnd().split('\n')
    expect(lines.at(-1)).toBe('Spoor: server unreachable, memory not loaded this session.')
    expect(lines.slice(0, -1).every((l) => l.startsWith('Spoor: 1 ADR draft'))).toBe(true)
    const stop = await hook('Stop', { session_id: 'session-d', stop_hook_active: false })
    expect(stop).toMatchObject({ code: 0, stdout: '' })
    const post = await hook('PostToolUse', {
      session_id: 'session-d',
      tool_name: 'Edit',
      tool_input: { file_path: join(repo, draftedRel) },
      tool_response: { filePath: join(repo, draftedRel) },
    })
    expect(post).toMatchObject({ code: 0, stdout: '' })
  }, 30_000)
})
