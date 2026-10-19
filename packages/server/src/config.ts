import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { parseTrustProxy, type TrustedProxies } from './lib/client-ip.js'

/**
 * Typed environment loading (docs/design/deployment.md section 5, .env.example).
 * Every secret also accepts `<NAME>_FILE` (Docker secrets); setting both is an error.
 * Compose-only variables (POSTGRES_*, SPOOR_IMAGE, SPOOR_HTTP_*, SPOOR_DOMAIN) are not read by the app.
 */

export const SECRET_VARS = [
  'DATABASE_URL',
  'DATABASE_MIGRATE_URL',
  'SPOOR_ADMIN_PASSWORD',
  'SPOOR_OPENAI_API_KEY',
  'SPOOR_VOYAGE_API_KEY',
] as const

type Env = Record<string, string | undefined>

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

/** Resolve `<NAME>_FILE` into `<NAME>`; collects problems instead of throwing. Never echoes secret values. */
function resolveSecrets(env: Env, problems: string[]): Env {
  const out: Env = { ...env }
  for (const name of SECRET_VARS) {
    const file = env[`${name}_FILE`]
    if (file === undefined || file === '') continue
    if (env[name] !== undefined && env[name] !== '') {
      problems.push(`${name} and ${name}_FILE are both set; set only one`)
      continue
    }
    try {
      out[name] = readFileSync(file, 'utf8').replace(/\r?\n$/, '')
    } catch {
      problems.push(`${name}_FILE: cannot read file ${file}`)
    }
  }
  return out
}

/** Empty string means unset (compose passes `${VAR:-}`). */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional())
const withDefault = <T extends z.ZodType>(schema: T, def: z.output<T>) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.default(def as never))

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max)
const pgUrl = z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL')

const schema = z
  .object({
    NODE_ENV: withDefault(z.enum(['development', 'production', 'test']), 'development'),
    DATABASE_URL: pgUrl,
    DATABASE_MIGRATE_URL: optional(pgUrl),
    SPOOR_PUBLIC_URL: withDefault(
      z
        .string()
        .url()
        .refine((u) => /^https?:$/.test(new URL(u).protocol), 'must be http or https')
        .refine(
          (u) => new URL(u).pathname === '/' && !u.endsWith('?') && !u.includes('#'),
          'origin only, no path',
        ),
      'http://localhost:3000',
    ),
    SPOOR_PORT: withDefault(int(1, 65535), 3000),
    SPOOR_HOST: withDefault(z.string().min(1), '0.0.0.0'),
    SPOOR_ADMIN_EMAIL: optional(z.string().email()),
    SPOOR_ADMIN_PASSWORD: optional(z.string().min(12).max(256)),
    SPOOR_ADMIN_NAME: withDefault(z.string().min(1).max(100), 'Admin'),
    LOG_LEVEL: withDefault(z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']), 'info'),
    SPOOR_DB_POOL_MAX: withDefault(int(1, 500), 10),
    SPOOR_JOBS: withDefault(z.enum(['on', 'off']), 'on'),
    SPOOR_TRUST_PROXY: optional(z.string().max(4000)),
    SPOOR_WEB_DIR: optional(z.string().min(1)),
    SPOOR_MIGRATIONS_DIR: optional(z.string().min(1)),
    SPOOR_MODEL_DIR: withDefault(z.string().min(1), '/opt/spoor/models'),
    SPOOR_EMBEDDING_DEFAULT: withDefault(z.enum(['local', 'openai', 'voyage']), 'local'),
    SPOOR_EMBED_THREADS: withDefault(int(1, 64), 2),
    SPOOR_OPENAI_API_KEY: optional(z.string().min(1)),
    SPOOR_OPENAI_EMBED_MODEL: withDefault(z.string().min(1), 'text-embedding-3-small'),
    SPOOR_OPENAI_EMBED_DIMS: withDefault(int(1, 2000), 1536),
    SPOOR_VOYAGE_API_KEY: optional(z.string().min(1)),
    SPOOR_VOYAGE_EMBED_MODEL: optional(z.string().min(1)),
    SPOOR_VOYAGE_EMBED_DIMS: optional(int(1, 2000)),
  })
  .superRefine((c, ctx) => {
    const need = (ok: boolean, path: string, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [path], message })
    }
    if (c.SPOOR_VOYAGE_API_KEY) {
      need(
        !!c.SPOOR_VOYAGE_EMBED_MODEL,
        'SPOOR_VOYAGE_EMBED_MODEL',
        'required when SPOOR_VOYAGE_API_KEY is set',
      )
      need(
        c.SPOOR_VOYAGE_EMBED_DIMS !== undefined,
        'SPOOR_VOYAGE_EMBED_DIMS',
        'required when SPOOR_VOYAGE_API_KEY is set',
      )
    }
    need(
      c.SPOOR_EMBEDDING_DEFAULT !== 'openai' || !!c.SPOOR_OPENAI_API_KEY,
      'SPOOR_EMBEDDING_DEFAULT',
      'openai needs SPOOR_OPENAI_API_KEY',
    )
    need(
      c.SPOOR_EMBEDDING_DEFAULT !== 'voyage' || !!c.SPOOR_VOYAGE_API_KEY,
      'SPOOR_EMBEDDING_DEFAULT',
      'voyage needs SPOOR_VOYAGE_API_KEY',
    )
  })

export type Config = z.output<typeof schema> & {
  /** `SPOOR_PUBLIC_URL` without a trailing slash; the only trusted origin. */
  publicOrigin: string
  /** Secure cookies / `__Host-` prefix only over https. */
  cookieSecure: boolean
  /** Parsed `SPOOR_TRUST_PROXY`; null = forwarded headers are ignored (the default). */
  trustedProxies: TrustedProxies | null
}

/** Parse and validate; throws ConfigError listing every problem (secret values are never included). */
export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = []
  const resolved = resolveSecrets(env, problems)
  const parsed = schema.safeParse(resolved)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`)
    }
  }
  let trustedProxies: TrustedProxies | null = null
  try {
    trustedProxies = parseTrustProxy(parsed.data?.SPOOR_TRUST_PROXY)
  } catch (err) {
    problems.push(`SPOOR_TRUST_PROXY: ${(err as Error).message}`)
  }
  if (problems.length > 0 || !parsed.success) throw new ConfigError(problems)
  const publicOrigin = new URL(parsed.data.SPOOR_PUBLIC_URL).origin
  return { ...parsed.data, publicOrigin, cookieSecure: publicOrigin.startsWith('https:'), trustedProxies }
}
