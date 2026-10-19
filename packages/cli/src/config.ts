import { existsSync, readFileSync } from 'node:fs'
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

/** Nearest ancestor of cwd containing .git or .claude; CLAUDE_PROJECT_DIR wins. */
export function findRepoRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_PROJECT_DIR) return resolve(env.CLAUDE_PROJECT_DIR)
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, '.claude'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(cwd)
    dir = parent
  }
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
