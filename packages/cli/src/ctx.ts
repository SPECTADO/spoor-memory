/**
 * Per-run context: the repo root, the resolved server/project/token (config.ts), `spoor.config.json`, an HTTP
 * client, and the one-line notices of cli-and-hooks.md section 3.2.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigError, isLoopback, resolveConfig, type SpoorConfig } from './config.js'
import { logRun, oncePerDay, readJsonObject } from './fsutil.js'
import { type Client, createClient, NetworkError, OfflineError } from './http.js'
import { loadRepoConfig, type RepoConfig } from './repo-config.js'
import type { Rt } from './runtime.js'

/**
 * The CLI's own version, from the package's package.json: it sits one level above both `src/` (tests) and `dist/`
 * (the bundled bin.js), and npm always ships it. Used in the User-Agent, `--version` and the device `client_name`.
 */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown
    }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()
export const USER_AGENT = `spoor-cli/${VERSION}`
/** Must equal the server's `AUTO_CLIENT_SUFFIX` (modules/mirror/service.ts). */
export const AUTO_SUFFIX = ' (auto)'

export interface Flags {
  server?: string
  project?: string
  token?: string
}

export interface Ctx {
  rt: Rt
  root: string
  repo: RepoConfig
  repoError?: string
  cfg?: SpoorConfig
  server?: string
  project?: string
  token?: string
  /** Why the CLI cannot talk to the server with a token (missing values, token origin binding, bad URL). */
  configError?: string
  /** No `.claude/settings.local.json` and no token in the environment (I45): hooks stay silent. */
  optedOut: boolean
}

export function makeCtx(rt: Rt, flags: Flags = {}, cwd?: string): Ctx {
  const env = rt.env
  let cfg: SpoorConfig | undefined
  let configError: string | undefined
  try {
    cfg = resolveConfig({ cwd: cwd ?? rt.cwd, env, flags })
  } catch (e) {
    configError = e instanceof ConfigError ? e.message : String(e)
  }
  const root = cfg?.repoRoot ?? cwd ?? rt.cwd
  const { config: repo, error: repoError } = loadRepoConfig(root)
  const ctx: Ctx = {
    rt,
    root,
    repo,
    optedOut: !existsSync(join(root, '.claude', 'settings.local.json')) && !env.SPOOR_TOKEN && !flags.token,
  }
  if (repoError) ctx.repoError = repoError
  if (cfg) {
    ctx.cfg = cfg
    if (cfg.server) ctx.server = cfg.server.value
    if (cfg.project) ctx.project = cfg.project.value
    if (cfg.token) ctx.token = cfg.token.value
    if (cfg.tokenBlocked) configError = cfg.tokenBlocked
  }
  if (configError) ctx.configError = configError
  return ctx
}

/** The one-line notice for missing values; it names only the ones that are missing (review-log-phase5 A6). */
export const notConfigured = (missing: string[]) =>
  `spoor: not configured for this repo (missing ${missing.join(', ')}). Run: spoor login`

/** The reason this context cannot make an authenticated call, or undefined when it can. */
export function authProblem(ctx: Ctx): string | undefined {
  if (ctx.configError) return `spoor: ${ctx.configError}`
  const missing = [
    ...(ctx.server ? [] : ['SPOOR_URL']),
    ...(ctx.project ? [] : ['SPOOR_PROJECT']),
    ...(ctx.token ? [] : ['SPOOR_TOKEN']),
  ]
  return missing.length > 0 ? notConfigured(missing) : undefined
}

export function projectPath(ctx: Ctx, rest: string): string {
  return `/p/${encodeURIComponent(ctx.project ?? '')}${rest}`
}

export function clientFor(
  ctx: Ctx,
  opts: {
    breaker?: 'check' | 'trip' | 'off'
    timeoutMs?: number
    token?: string | null
    server?: string
    /**
     * Pushes the CLI makes on its own (drafting, queue replay, mirror sweep): the User-Agent gets ` (auto)`, which the
     * server's activity count skips, so they never suppress the Stop nag (review-log-phase5 A3).
     */
    auto?: boolean
  } = {},
): Client {
  const server = opts.server ?? ctx.server ?? ''
  warnPlainHttp(ctx, server)
  const o: Parameters<typeof createClient>[0] = {
    repoRoot: ctx.root,
    now: ctx.rt.now,
    server,
    userAgent: opts.auto ? `${USER_AGENT}${AUTO_SUFFIX}` : USER_AGENT,
    breaker: opts.breaker ?? 'check',
  }
  const token = opts.token === null ? undefined : (opts.token ?? ctx.token)
  if (token) o.token = token
  if (opts.timeoutMs) o.timeoutMs = opts.timeoutMs
  return createClient(o)
}

function warnPlainHttp(ctx: Ctx, server: string): void {
  if (!server.startsWith('http://') || isLoopback(server)) return
  let host = server
  try {
    host = new URL(server).host
  } catch {
    // keep the raw value
  }
  if (!oncePerDay(ctx.root, 'plain-http', ctx.rt.now())) return
  const line = `spoor: the token is sent over plain http to ${host}`
  ctx.rt.err(`${line}\n`)
  logRun(ctx.root, line, ctx.rt.now())
}

export type ApiResult<T> =
  | { kind: 'ok'; status: number; body: T; headers?: Headers }
  | { kind: 'error'; status: number; code: string; message: string; body: Record<string, unknown> }
  | { kind: 'unauthorized'; status: 401 }
  | { kind: 'network'; code: string }
  | { kind: 'offline'; until: number }

export async function api<T>(
  client: Client,
  method: string,
  path: string,
  opts: { body?: unknown; timeoutMs?: number } = {},
): Promise<ApiResult<T>> {
  try {
    const r = await client.request<T>(method, path, opts)
    if (r.ok) return { kind: 'ok', status: r.status, body: r.body, headers: r.headers }
    if (r.status === 401) return { kind: 'unauthorized', status: 401 }
    const b = (r.body && typeof r.body === 'object' ? r.body : {}) as Record<string, unknown>
    return {
      kind: 'error',
      status: r.status,
      code: typeof b.error === 'string' ? b.error : `http_${r.status}`,
      message:
        typeof b.message === 'string' ? b.message : typeof r.body === 'string' ? r.body.slice(0, 200) : '',
      body: b,
    }
  } catch (e) {
    if (e instanceof OfflineError) return { kind: 'offline', until: e.until }
    if (e instanceof NetworkError) return { kind: 'network', code: e.code }
    return { kind: 'network', code: e instanceof Error ? e.name : 'error' }
  }
}

export function unreachableNotice(ctx: Ctx, code: string): string {
  return `spoor: server unreachable (${code} ${ctx.server ?? ''}); skipped. It will retry on the next session.`
}

export function rejectedNotice(ctx: Ctx): string {
  return `spoor: token rejected by ${ctx.server ?? ''} (401). Run: spoor login`
}

/** Notice line for a failed call (network, offline, 401, other). */
export function failureNotice(ctx: Ctx, r: Exclude<ApiResult<unknown>, { kind: 'ok' }>): string {
  switch (r.kind) {
    case 'network':
      return unreachableNotice(ctx, r.code)
    case 'offline':
      return unreachableNotice(ctx, 'offline')
    case 'unauthorized':
      return rejectedNotice(ctx)
    case 'error':
      return `spoor: ${r.code}${r.message ? `: ${r.message}` : ''}`
  }
}

/** Exit code of a failed call in human mode: 3 unreachable / rejected, 2 conflict, 1 otherwise. */
export function failureExit(r: Exclude<ApiResult<unknown>, { kind: 'ok' }>): number {
  if (r.kind === 'network' || r.kind === 'offline' || r.kind === 'unauthorized') return 3
  if (r.status === 409) return 2
  return 1
}

/** `<server>/p/<slug>/install.md`, from the config or the committed `.mcp.json`, for the opt-out line. */
export function installUrl(ctx: Ctx): string | undefined {
  if (ctx.server && ctx.project) return `${ctx.server}/p/${ctx.project}/install.md`
  try {
    const mcp = readJsonObject(join(ctx.root, '.mcp.json'))
    const servers = mcp.mcpServers as Record<string, { url?: unknown }> | undefined
    const url = servers?.spoor?.url
    if (typeof url === 'string') {
      const m = /^(https?:\/\/[^\s]+?)\/p\/([^/]+)\/mcp\/?$/.exec(url)
      if (m) return `${m[1]}/p/${m[2]}/install.md`
    }
  } catch {
    // no hint available
  }
  return undefined
}

/**
 * A warning when the committed `.mcp.json` sends the token somewhere else than this checkout's `SPOOR_URL`
 * (review-log-phase5 S8): Claude Code expands `${SPOOR_TOKEN}` into whatever URL the committed file names, so a change
 * to `mcpServers.spoor.url` in a pull request would hand every teammate's token to that host.
 */
export function mcpUrlMismatch(ctx: Ctx): string | undefined {
  if (!ctx.server || !ctx.project) return undefined
  let url: unknown
  try {
    const mcp = readJsonObject(join(ctx.root, '.mcp.json'))
    url = (mcp.mcpServers as Record<string, { url?: unknown }> | undefined)?.spoor?.url
  } catch {
    return undefined
  }
  if (typeof url !== 'string') return undefined
  const expected = `${ctx.server.replace(/\/+$/, '')}/p/${ctx.project}/mcp`
  if (url.replace(/\/+$/, '') === expected) return undefined
  return `.mcp.json sends the token to ${url}, not to ${expected} (SPOOR_URL); check who changed it, then run spoor init`
}
