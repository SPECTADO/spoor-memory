import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export type ConfigSource = 'flag' | 'env' | 'settings.local.json' | 'spoor.config.json'

export interface Resolved {
  value: string
  source: ConfigSource
}

export interface SpoorConfig {
  server?: Resolved
  project?: Resolved
  token?: Resolved
  repoRoot: string
  /** Set when the token must not be sent to `server` (design cli-and-hooks.md section 2). */
  tokenBlocked?: string
}

export interface ResolveInput {
  cwd?: string
  env?: NodeJS.ProcessEnv
  flags?: { server?: string; project?: string; token?: string }
}

export class ConfigError extends Error {}

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/** The user's home directory (`HOME` / `USERPROFILE` of `env`, else the OS answer). */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.HOME || env.USERPROFILE || homedir())
}

/**
 * The home directory is never a project: `~/.claude` holds the user's global Claude Code settings, so a `spoor init`
 * there would install the hooks for every project on the machine and put `AGENTS.md` outside any project.
 */
export function isHomeDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return real(dir) === real(homeDir(env))
}

/**
 * The project root: `CLAUDE_PROJECT_DIR`, else the nearest ancestor of cwd containing `.git` or `.claude`. The walk
 * stops below the home directory (its `.claude` is the user's global configuration, not a project marker); with no
 * marker on the way the root is cwd itself.
 */
export function findRepoRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_PROJECT_DIR) return resolve(env.CLAUDE_PROJECT_DIR)
  const start = resolve(cwd)
  let dir = start
  for (;;) {
    if (isHomeDir(dir, env)) return start
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, '.claude'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

/** The file whose presence marks a project as set up for Spoor; `spoor init` writes it and it is committed. */
export const PROJECT_MARKER = 'spoor.config.json'

/**
 * Whether `root` is a project set up for Spoor: it holds `spoor.config.json`, or (set up by a CLI older than the
 * marker) a `.mcp.json` with a `spoor` server. Never the home directory. Outside such a project hooks do nothing and
 * write nothing, and only `spoor login` / `spoor init` run.
 */
export function projectInitialized(root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isHomeDir(root, env)) return false
  if (existsSync(join(root, PROJECT_MARKER))) return true
  const servers = readJson(join(root, '.mcp.json'))?.mcpServers
  return !!servers && typeof servers === 'object' && 'spoor' in (servers as object)
}

function readJson(path: string): Record<string, unknown> | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

export function normalizeServer(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(s))
    throw new ConfigError(`SPOOR_URL must start with http:// or https:// (got "${raw}")`)
  return s
}

export function resolveConfig(input: ResolveInput = {}): SpoorConfig {
  const env = input.env ?? process.env
  const flags = input.flags ?? {}
  const repoRoot = findRepoRoot(input.cwd ?? process.cwd(), env)
  const local = readJson(join(repoRoot, '.claude', 'settings.local.json'))
  const localEnv =
    local && typeof local.env === 'object' && local.env ? (local.env as Record<string, unknown>) : {}
  const committed = readJson(join(repoRoot, 'spoor.config.json'))

  function pick(flag: string | undefined, key: string, fileKey: string | undefined): Resolved | undefined {
    const f = str(flag)
    if (f) return { value: f, source: 'flag' }
    const e = str(env[key])
    if (e) return { value: e, source: 'env' }
    const l = str(localEnv[key])
    if (l) return { value: l, source: 'settings.local.json' }
    const c = fileKey && committed ? str(committed[fileKey]) : undefined
    if (c) return { value: c, source: 'spoor.config.json' }
    return undefined
  }

  const server = pick(flags.server, 'SPOOR_URL', 'server')
  if (server) server.value = normalizeServer(server.value)
  const project = pick(flags.project, 'SPOOR_PROJECT', 'project')
  const token = pick(flags.token, 'SPOOR_TOKEN', undefined)

  const cfg: SpoorConfig = { repoRoot }
  if (server) cfg.server = server
  if (project) cfg.project = project
  if (token) cfg.token = token
  if (server && token && server.source === 'spoor.config.json' && token.source !== 'flag') {
    cfg.tokenBlocked =
      'SPOOR_URL comes from spoor.config.json, not from where the token is stored; run spoor login'
  }
  return cfg
}

export function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
  } catch {
    return false
  }
}
