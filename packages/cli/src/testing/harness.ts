/** Test harness: a fake Spoor HTTP server, temp repos and an in-memory `Io`. Not part of the build. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { agentsMdBlock } from '@spoor/shared'
import { main } from '../cli.js'
import type { Io } from '../runtime.js'

export interface Req {
  method: string
  path: string
  query: URLSearchParams
  headers: IncomingMessage['headers']
  body: unknown
}

export type Reply =
  | { status?: number; body?: unknown; text?: string; delayMs?: number; headers?: Record<string, string> }
  | 'hang'
export type Handler = (req: Req) => Reply | Promise<Reply>

export interface FakeServer {
  url: string
  requests: Req[]
  routes: Map<string, Handler>
  on(route: string, h: Handler | Reply): void
  close(): Promise<void>
  count(route: string): number
}

/** `on('GET /p/acme/api/whoami', {...})`; an unknown route answers 404 `not_found`. */
export async function fakeServer(): Promise<FakeServer> {
  const routes = new Map<string, Handler>()
  const requests: Req[] = []
  const server: Server = createServer((req, res) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => {
      data += c
    })
    req.on('end', async () => {
      const u = new URL(req.url ?? '/', 'http://x')
      let body: unknown = data
      try {
        body = data ? JSON.parse(data) : undefined
      } catch {
        // raw
      }
      const r: Req = {
        method: req.method ?? 'GET',
        path: u.pathname,
        query: u.searchParams,
        headers: req.headers,
        body,
      }
      requests.push(r)
      const h = routes.get(`${r.method} ${r.path}`)
      const reply: Reply = h ? await h(r) : { status: 404, body: { error: 'not_found' } }
      if (reply === 'hang') return
      if (reply.delayMs) await new Promise((x) => setTimeout(x, reply.delayMs))
      if (reply.text !== undefined) {
        res.writeHead(reply.status ?? 200, { 'content-type': 'text/plain; charset=utf-8', ...reply.headers })
        res.end(reply.text)
        return
      }
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers })
      res.end(JSON.stringify(reply.body ?? {}))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    routes,
    on(route, h) {
      routes.set(route, typeof h === 'function' ? h : () => h)
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
    count: (route) => requests.filter((q) => `${q.method} ${q.path}` === route).length,
  }
}

export interface RepoOpts {
  git?: boolean
  files?: Record<string, string>
  /** env block of .claude/settings.local.json; omit for an opted-out teammate */
  local?: Record<string, string>
  config?: unknown
  /** write the AGENTS.md block and the CLAUDE.md import `spoor init` would (`'shared'`: the non-exclusive block) */
  agents?: true | 'shared'
}

/** What `spoor init` writes into AGENTS.md and CLAUDE.md of an empty repo (ADR-0015). */
export const agentsFiles = (shared = false): Record<string, string> => ({
  'AGENTS.md': `${agentsMdBlock(!shared)}\n`,
  'CLAUDE.md': '@AGENTS.md\n',
})

export function makeRepo(o: RepoOpts = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'spoor-cli-'))
  mkdirSync(join(dir, '.claude'), { recursive: true })
  if (o.git) {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir })
  }
  for (const [p, c] of Object.entries(o.files ?? {})) writeFile(dir, p, c)
  if (o.local) writeFile(dir, '.claude/settings.local.json', JSON.stringify({ env: o.local }, null, 2))
  if (o.config !== undefined) writeFile(dir, 'spoor.config.json', JSON.stringify(o.config))
  if (o.agents) for (const [p, c] of Object.entries(agentsFiles(o.agents === 'shared'))) writeFile(dir, p, c)
  return dir
}

export function writeFile(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), content)
}

export function gitCommitAll(root: string, msg = 'c'): void {
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', msg, '--allow-empty'], { cwd: root })
}

export const localEnv = (server: string, project = 'acme', token = 'spr_testtoken123') => ({
  SPOOR_URL: server,
  SPOOR_PROJECT: project,
  SPOOR_TOKEN: token,
})

export interface RunOpts {
  cwd: string
  env?: NodeJS.ProcessEnv
  stdin?: string
  isTTY?: boolean
  prompt?: (q: string) => Promise<string>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  spawned?: { args: string[]; cwd: string; env: NodeJS.ProcessEnv }[]
  opened?: string[]
}

export interface RunResult {
  code: number
  out: string
  err: string
  ms: number
}

export async function run(argv: string[], o: RunOpts): Promise<RunResult> {
  let out = ''
  let err = ''
  const io: Io = {
    out: (s) => {
      out += s
    },
    err: (s) => {
      err += s
    },
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(o.env ?? {}) },
    cwd: o.cwd,
    readStdin: async () => o.stdin ?? '',
    isTTY: o.isTTY ?? false,
    prompt: o.prompt ?? (async () => ''),
    sleep: o.sleep ?? (async () => {}),
    spawnDetached: (args, opts) => {
      o.spawned?.push({ args, ...opts })
    },
    openBrowser: (u) => {
      o.opened?.push(u)
    },
    hostname: () => 'testhost',
  }
  if (o.now) io.now = o.now
  const t0 = Date.now()
  const code = await main(argv, io)
  return { code, out, err, ms: Date.now() - t0 }
}

export const whoami = (over: Record<string, unknown> = {}) => ({
  project: { slug: 'acme', name: 'Acme', next_adr_number: 1 },
  token: {
    id: 't1',
    name: 'claude-code (device 2026-10-19)',
    kind: 'user',
    prefix: 'spr_Ab12Cd34',
    role: 'editor',
  },
  user: { label: 'ann@example.com' },
  server: { version: '0.1.0' },
  ...over,
})

let idSeq = 0
export const uuid = () => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`

/** URL of a local port nobody listens on (connection refused at once). */
export async function deadUrl(): Promise<string> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return `http://127.0.0.1:${port}`
}

const spoorGroup = (event: string) => ({
  hooks: [
    {
      type: 'command',
      timeout: 15,
      command: `command -v spoor >/dev/null 2>&1 && exec spoor hook ${event} || exit 0`,
    },
  ],
})

/** The `.claude/settings.json` block of install.json (cli-and-hooks.md section 7.2). */
export const renderedSettings = {
  permissions: { allow: ['mcp__spoor'] },
  hooks: {
    SessionStart: [spoorGroup('session-start')],
    PostToolUse: [{ matcher: 'Write|Edit', ...spoorGroup('post-tool-use') }],
    Stop: [spoorGroup('stop')],
  },
}

/** The JSON body of a recorded request (throws when the request is missing). */
export function bodyOf<T>(r: Req | undefined): T {
  if (!r) throw new Error('request not recorded')
  return r.body as T
}
