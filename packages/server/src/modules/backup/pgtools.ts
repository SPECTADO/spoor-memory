/**
 * The Postgres client tools (pg_dump, pg_restore, psql) as child processes (ADR-0038).
 *
 * HARD RULE: the connection goes only through PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE (+ PGSSLMODE)
 * environment variables, never argv (no password in `ps`, no URL to parse twice), and data flows only through
 * stdin / stdout pipes handled here, never file-path arguments. Nothing runs through a shell. That also lets
 * the tests run the tools through a `docker exec -i` shim (test/pg-shim) on a machine without a pg client.
 *
 * Binaries come from `SPOOR_PG_BIN_DIR` when set (the image sets /usr/lib/postgresql/17/bin), else from PATH.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { PassThrough, type Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { appApplicationName } from '../../db/client.js'

export const PG_TOOLS = ['pg_dump', 'pg_restore', 'psql'] as const
export type PgTool = (typeof PG_TOOLS)[number]

/** The libpq environment of one connection. */
export interface PgConnectionEnv {
  PGHOST: string
  PGPORT: string
  PGUSER: string
  PGPASSWORD?: string
  PGDATABASE: string
  PGSSLMODE?: string
}

const SSLMODES = new Set(['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'])

/**
 * The libpq environment for a `postgres://` URL (user, password, host, port, database; `?host=` for a unix
 * socket directory; `?sslmode=`, where node-postgres's `no-verify` becomes `require` and `?ssl=true` is
 * `require`). Throws on a URL that is not one; the message never contains the password.
 */
export function pgConnectionEnv(databaseUrl: string): PgConnectionEnv {
  let u: URL
  try {
    u = new URL(databaseUrl)
  } catch {
    throw new Error('database URL is not a valid URL')
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error('database URL must start with postgres://')
  }
  const q = u.searchParams
  const host = q.get('host') ?? u.hostname.replace(/^\[(.*)\]$/, '$1')
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''))
  const user = decodeURIComponent(u.username)
  if (!host || !database || !user) throw new Error('database URL needs a user, a host and a database')
  const env: PgConnectionEnv = {
    PGHOST: host,
    PGPORT: q.get('port') ?? (u.port || '5432'),
    PGUSER: user,
    PGDATABASE: database,
  }
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password)
  let sslmode = q.get('sslmode') ?? undefined
  if (sslmode === 'no-verify') sslmode = 'require'
  if (sslmode === undefined && (q.get('ssl') === 'true' || q.get('ssl') === '1')) sslmode = 'require'
  if (sslmode !== undefined) {
    if (!SSLMODES.has(sslmode)) throw new Error(`unsupported sslmode "${sslmode}"`)
    env.PGSSLMODE = sslmode
  }
  return env
}

/** A failed tool run. `stderr` is the tool's own message (tail); libpq never prints the password. */
export class PgToolError extends Error {
  constructor(
    readonly tool: PgTool,
    readonly exitCode: number | null,
    readonly stderr: string,
    message?: string,
    readonly spawnCode?: string,
  ) {
    super(message ?? `${tool} exited with code ${exitCode}${stderr ? `: ${lastLine(stderr)}` : ''}`)
    this.name = 'PgToolError'
  }
}

const lastLine = (s: string) =>
  s
    .trim()
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-1)[0] ?? ''

/**
 * Options the HARD RULE forbids in argv: connection parameters and files. Short forms are refused alone and
 * with an attached value (`-hlocalhost`), long forms alone and as `--name=value`.
 */
const FORBIDDEN_SHORT = ['-d', '-h', '-p', '-U', '-W', '-f', '-o', '-L']
const FORBIDDEN_LONG = [
  '--dbname',
  '--host',
  '--port',
  '--username',
  '--password',
  '--file',
  '--output',
  '--log-file',
  '--maintenance-db',
]

/** `-f -` / `--file=-`: stdout, which pg_restore 17 wants spelled out for a script; not a file. */
const isStdoutFile = (args: readonly string[], i: number) =>
  ((args[i] === '-f' || args[i] === '--file') && args[i + 1] === '-') ||
  args[i] === '-f-' ||
  args[i] === '--file=-'

/** Throws when an argument would carry a connection parameter or a file path (see the HARD RULE above). */
export function assertSafeArgs(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (isStdoutFile(args, i)) {
      if (a === '-f' || a === '--file') i++
      continue
    }
    const long = FORBIDDEN_LONG.find((f) => a === f || a.startsWith(`${f}=`))
    const short = FORBIDDEN_SHORT.find((f) => a === f || (a.startsWith(f) && !a.startsWith('--')))
    if (long || short) throw new Error(`pg tool argument not allowed: ${long ?? short}`)
    if (a.includes('/') || a.includes('\\') || a.startsWith('~')) {
      throw new Error('pg tool arguments must not contain paths')
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
    if (/[\u0000-\u001f]/.test(a)) throw new Error('pg tool arguments must not contain control characters')
  }
}

export interface PgToolsOptions {
  /** `SPOOR_PG_BIN_DIR`; unset = PATH lookup by the bare name. */
  binDir?: string
  /** The connection (see `pgConnectionEnv`); omitted for runs that need none (`--version`). */
  connection?: PgConnectionEnv
  /** `PGAPPNAME` of the tools' connections; default this process's `spoor:<host>:<pid>`. */
  applicationName?: string
  /** Extra variables for the child (tests: what the docker CLI of the shim needs). Never PG* connection vars. */
  extraEnv?: Record<string, string | undefined>
}

export interface PgRunIo {
  /** Fed to the child's stdin (then closed); none = stdin closed at once. */
  stdin?: Readable | Uint8Array | string
  /** The child's stdout is piped here; none = collected into `stdout` of the result (capped). */
  stdout?: Writable
  /** Cap of the collected stdout (default 16 MiB); more kills the child. */
  maxStdoutBytes?: number
  signal?: AbortSignal
}

export interface PgRunResult {
  /** Collected stdout (empty when it was piped to `io.stdout`). */
  stdout: Buffer
  /** Tail of stderr (warnings of a successful run). */
  stderr: string
}

const STDERR_TAIL = 64 * 1024
const DEFAULT_STDOUT_CAP = 16 * 1024 * 1024

/** `pg_dump (PostgreSQL) 17.6 (Debian 17.6-1.pgdg120+1)` -> 17.6; null when the text is not a version. */
export function parsePgVersion(text: string): { text: string; major: number; minor: number } | null {
  const m = /\(PostgreSQL\)\s+(\d+)(?:\.(\d+))?/.exec(text) ?? /^(\d+)(?:\.(\d+))?/.exec(text.trim())
  if (!m) return null
  return { text: text.trim().split('\n')[0] ?? '', major: Number(m[1]), minor: Number(m[2] ?? 0) }
}

/** `SHOW server_version_num` (170006) -> 17. */
export function serverMajor(serverVersionNum: string | number): number {
  return Math.floor(Number(serverVersionNum) / 10000)
}

export class PgTools {
  readonly #o: PgToolsOptions

  constructor(opts: PgToolsOptions = {}) {
    this.#o = opts
  }

  /** The same tools on another connection. */
  withConnection(connection: PgConnectionEnv): PgTools {
    return new PgTools({ ...this.#o, connection })
  }

  /** The executable for a tool: `<binDir>/<tool>` or the bare name for a PATH lookup. */
  bin(tool: PgTool): string {
    return this.#o.binDir ? join(this.#o.binDir, tool) : tool
  }

  #env(): Record<string, string> {
    const env: Record<string, string> = {
      LC_ALL: 'C',
      LANG: 'C',
      TZ: 'UTC',
      PGAPPNAME: this.#o.applicationName ?? appApplicationName(),
      PGCONNECT_TIMEOUT: '10',
    }
    if (process.env.PATH) env.PATH = process.env.PATH
    if (process.env.HOME) env.HOME = process.env.HOME
    for (const [k, v] of Object.entries(this.#o.extraEnv ?? {})) {
      if (v === undefined) continue
      if (k.startsWith('PG')) throw new Error(`extraEnv must not set ${k}`)
      env[k] = v
    }
    for (const [k, v] of Object.entries(this.#o.connection ?? {})) if (v !== undefined) env[k] = v
    return env
  }

  /**
   * Run a tool to completion. Resolves when it exited 0 and every pipe finished; rejects with `PgToolError`
   * otherwise (a missing binary has `spawnCode: 'ENOENT'`).
   */
  run(tool: PgTool, args: readonly string[], io: PgRunIo = {}): Promise<PgRunResult> {
    let env: Record<string, string>
    try {
      assertSafeArgs(args)
      env = this.#env()
    } catch (err) {
      return Promise.reject(err)
    }
    const child = spawn(this.bin(tool), [...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })
    // kill, and let go of the pipes: a grandchild that inherited them must not keep the run open
    const stop = (signal: NodeJS.Signals) => {
      child.kill(signal)
      child.stdout.destroy()
      child.stderr.destroy()
      child.stdin.destroy()
    }
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => {
      stderr = (stderr + d).slice(-STDERR_TAIL)
    })

    const chunks: Buffer[] = []
    let collected = 0
    let overflow = false
    const cap = io.maxStdoutBytes ?? DEFAULT_STDOUT_CAP
    const out: Promise<void> = io.stdout
      ? pipeline(child.stdout, io.stdout)
      : new Promise<void>((resolve, reject) => {
          child.stdout.on('data', (d: Buffer) => {
            collected += d.length
            if (collected > cap) {
              overflow = true
              stop('SIGKILL')
              return
            }
            chunks.push(d)
          })
          child.stdout.on('end', resolve)
          // a destroyed stream (abort, overflow) closes without 'end'
          child.stdout.on('close', resolve)
          child.stdout.on('error', reject)
        })

    // a child that exits early closes its stdin: EPIPE there is reported as the exit code instead
    let input: Promise<void> = Promise.resolve()
    if (io.stdin === undefined) child.stdin.end()
    else if (typeof io.stdin === 'string' || io.stdin instanceof Uint8Array) {
      input = pipeline(bufferStream(io.stdin), child.stdin)
    } else input = pipeline(io.stdin, child.stdin)

    const onAbort = () => stop('SIGTERM')
    io.signal?.addEventListener('abort', onAbort, { once: true })
    if (io.signal?.aborted) onAbort()

    const exited = new Promise<{ code: number | null; spawnError?: NodeJS.ErrnoException }>((resolve) => {
      child.once('error', (err: NodeJS.ErrnoException) => resolve({ code: null, spawnError: err }))
      child.once('close', (code) => resolve({ code }))
    })

    return (async () => {
      const [exit, inRes, outRes] = await Promise.all([
        exited,
        input.then(
          () => null,
          (e: unknown) => e,
        ),
        out.then(
          () => null,
          (e: unknown) => e,
        ),
      ])
      io.signal?.removeEventListener('abort', onAbort)
      if (exit.spawnError) {
        throw new PgToolError(
          tool,
          null,
          '',
          `${tool} could not be started: ${exit.spawnError.code ?? exit.spawnError.message}`,
          exit.spawnError.code,
        )
      }
      if (overflow) throw new PgToolError(tool, exit.code, stderr, `${tool} output over ${cap} bytes`)
      if (io.signal?.aborted) throw new PgToolError(tool, exit.code, stderr, `${tool} aborted`)
      if (exit.code !== 0) throw new PgToolError(tool, exit.code, stderr)
      if (outRes) throw outRes
      if (inRes) throw inRes
      return { stdout: Buffer.concat(chunks), stderr }
    })()
  }

  /** `<tool> --version`; null when the binary is missing or prints something else. */
  async version(tool: PgTool): Promise<{ text: string; major: number; minor: number } | null> {
    try {
      const r = await this.run(tool, ['--version'], { maxStdoutBytes: 4096 })
      return parsePgVersion(r.stdout.toString('utf8'))
    } catch {
      return null
    }
  }

  /**
   * Probe all three tools. `ok` when every one is there and none is older (major) than the server, which
   * pg_dump refuses ("server version mismatch"); `serverMajor` omitted = only presence is checked.
   */
  async probe(serverMajorVersion?: number): Promise<PgToolsProbe> {
    const versions = await Promise.all(PG_TOOLS.map((t) => this.version(t)))
    const missing = PG_TOOLS.filter((_, i) => versions[i] === null)
    const dump = versions[0]
    if (missing.length > 0 || !dump) {
      return {
        ok: false,
        reason: 'pg_tools_missing',
        message: `not found: ${missing.join(', ')}${this.#o.binDir ? ` in ${this.#o.binDir}` : ' on PATH'}`,
        pgDumpVersion: dump?.text ?? null,
        clientMajor: dump?.major ?? null,
      }
    }
    const clientMajor = Math.min(...versions.map((v) => (v as { major: number }).major))
    if (serverMajorVersion !== undefined && serverMajorVersion > clientMajor) {
      return {
        ok: false,
        reason: 'pg_version_mismatch',
        message: `database server is PostgreSQL ${serverMajorVersion}, client tools are ${clientMajor}`,
        pgDumpVersion: dump.text,
        clientMajor,
      }
    }
    return { ok: true, pgDumpVersion: dump.text, clientMajor }
  }
}

export type PgToolsProbe =
  | { ok: true; pgDumpVersion: string; clientMajor: number }
  | {
      ok: false
      reason: 'pg_tools_missing' | 'pg_version_mismatch'
      message: string
      pgDumpVersion: string | null
      clientMajor: number | null
    }

function bufferStream(data: string | Uint8Array): Readable {
  const s = new PassThrough()
  s.end(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data))
  return s
}
