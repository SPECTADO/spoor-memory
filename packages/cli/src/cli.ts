import { parseArgs } from 'node:util'
import { cmdAdrDraft } from './cmd/draft.js'
import { cmdContext, cmdStatus, cmdWhoami } from './cmd/info.js'
import { cmdAdrImport, cmdDocsImport, cmdPush } from './cmd/mirror.js'
import {
  type HookInput,
  POST_TOOL_USE_DEADLINE_MS,
  parseHookInput,
  postToolUse,
  SESSION_START_DEADLINE_MS,
  STOP_DEADLINE_MS,
  sessionStart,
  statusLines,
  stop,
} from './cmd/session.js'
import { cmdInit, cmdLogin } from './cmd/setup.js'
import { type Command, commandHelp, findCommand, helpText } from './commands.js'
import { type Ctx, makeCtx, VERSION } from './ctx.js'
import { logRun } from './fsutil.js'
import { runHook } from './hook-guard.js'
import { Deadline, type Io, runtimeOf } from './runtime.js'

export type { Io }
export { VERSION }

type Opt = { type: 'string' | 'boolean'; short?: string }

const GLOBAL: Record<string, Opt> = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  server: { type: 'string' },
  project: { type: 'string' },
  token: { type: 'string' },
  strict: { type: 'boolean' },
  quiet: { type: 'boolean' },
}

const OPTIONS: Record<string, Record<string, Opt>> = {
  login: { 'no-browser': { type: 'boolean' }, 'no-init': { type: 'boolean' }, untrack: { type: 'boolean' } },
  init: { 'dry-run': { type: 'boolean' } },
  whoami: { json: { type: 'boolean' } },
  status: { remote: { type: 'boolean' } },
  context: {
    query: { type: 'string' },
    files: { type: 'string' },
    git: { type: 'boolean' },
    budget: { type: 'string' },
    'no-shared': { type: 'boolean' },
    json: { type: 'boolean' },
  },
  'adr import': { dir: { type: 'string' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' } },
  'adr push': { force: { type: 'boolean' } },
  'adr draft': {
    since: { type: 'string' },
    max: { type: 'string' },
    'dry-run': { type: 'boolean' },
    session: { type: 'string' },
    background: { type: 'boolean' },
  },
  'docs import': { 'dry-run': { type: 'boolean' }, json: { type: 'boolean' } },
  'docs push': {},
}

const HOOK_DEADLINES: Record<string, number> = {
  'session-start': SESSION_START_DEADLINE_MS,
  stop: STOP_DEADLINE_MS,
  'post-tool-use': POST_TOOL_USE_DEADLINE_MS,
}

type HookFn = (ctx: Ctx, input: HookInput, d: Deadline) => Promise<string>
const HOOKS: Record<string, HookFn> = { 'session-start': sessionStart, stop, 'post-tool-use': postToolUse }

/** Hook deadline in ms for `argv` (bin.ts arms a hard exit just after it), or undefined for other commands. */
export function hookDeadlineMs(argv: string[]): number | undefined {
  return argv[0] === 'hook' ? (HOOK_DEADLINES[argv[1] ?? ''] ?? 2000) : undefined
}

const TIMED_OUT = Symbol('timed out')

async function runHookCommand(argv: string[], io: Io): Promise<number> {
  const rt = runtimeOf(io)
  const name = argv[1] ?? ''
  const fn = HOOKS[name]
  if (argv.includes('--help') || argv.includes('-h') || !fn) {
    // stderr for unknown names: hook stdout is agent context
    const cmd = findCommand(argv)
    if (fn || !cmd) io.err(cmd ? commandHelp(cmd) : helpText())
    else io.err(commandHelp(cmd))
    return 0
  }
  let root = rt.cwd
  return runHook(
    async () => {
      const deadlineMs = HOOK_DEADLINES[name] ?? 5000
      const deadline = new Deadline(rt.now, deadlineMs)
      const input = parseHookInput(await rt.readStdin())
      const cwd = typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : rt.cwd
      const ctx = makeCtx(rt, {}, cwd)
      root = ctx.root
      let timer: NodeJS.Timeout | undefined
      const guard = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadline.remaining() - 100))
        timer.unref?.()
      })
      try {
        const out = await Promise.race([fn(ctx, input, deadline), guard])
        if (out === TIMED_OUT) {
          logRun(ctx.root, `hook ${name}: deadline of ${deadlineMs} ms reached`, rt.now())
          if (name === 'session-start' && !ctx.optedOut)
            io.out(
              `${[...statusLines(ctx), 'Spoor: server unreachable, memory not loaded this session.'].join('\n')}\n`,
            )
        } else if (out) io.out(out)
      } finally {
        clearTimeout(timer)
      }
    },
    io.env,
    (e) => logRun(root, `hook ${name}: ${e instanceof Error ? e.message : String(e)}`),
  )
}

/** Returns the process exit code. Hook commands always return 0. */
export async function main(argv: string[], io: Io): Promise<number> {
  // Hooks must never fail, not even on bad arguments.
  if (argv[0] === 'hook') return runHookCommand(argv, io)

  const pre = parseArgs({ args: argv, allowPositionals: true, strict: false, options: GLOBAL })
  if (pre.values.version) {
    io.out(`${VERSION}\n`)
    return 0
  }
  const pos = pre.positionals
  if (pos.length === 0) {
    io.out(helpText())
    return pre.values.help ? 0 : 1
  }
  const cmd = findCommand(pos)
  if (!cmd) {
    io.err(`spoor: unknown command "${pos.join(' ')}"\n\n${helpText()}`)
    return 1
  }
  if (pre.values.help) {
    io.out(commandHelp(cmd))
    return 0
  }
  const key = cmd.path.join(' ')
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: { ...GLOBAL, ...(OPTIONS[key] ?? {}) },
    })
  } catch (e) {
    io.err(`spoor: ${e instanceof Error ? e.message : String(e)}\n\n${commandHelp(cmd)}`)
    return 1
  }
  return runCommand(
    cmd,
    parsed.values as Record<string, string | boolean | undefined>,
    parsed.positionals.slice(cmd.path.length),
    io,
  )
}

async function runCommand(
  cmd: Command,
  v: Record<string, string | boolean | undefined>,
  rest: string[],
  io: Io,
): Promise<number> {
  const s = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : undefined)
  const b = (k: string) => v[k] === true
  const key0 = cmd.path.join(' ')
  // --quiet: no progress output; login (the device code) and commands whose stdout is the result keep it
  const quiet = b('quiet') && !['login', 'whoami', 'status', 'context'].includes(key0)
  const rt = runtimeOf(quiet ? { ...io, out: () => {} } : io)
  const flags: { server?: string; project?: string; token?: string } = {}
  if (s('server')) flags.server = s('server') as string
  if (s('project')) flags.project = s('project') as string
  const key = cmd.path.join(' ')
  // `login --token` is the token to store, not a config override
  if (s('token') !== undefined && key !== 'login') flags.token = s('token') as string
  const ctx = makeCtx(rt, flags)
  if (ctx.repoError && key !== 'status') {
    io.err(`spoor: ${ctx.repoError}\n`)
    if (!['context', 'adr push', 'docs push', 'adr draft'].includes(key) || b('strict')) return 1
  }
  const int = (k: string): number | undefined | null => {
    const raw = s(k)
    if (raw === undefined) return undefined
    return /^\d+$/.test(raw) ? Number(raw) : null
  }
  switch (key) {
    case 'login': {
      const o: Parameters<typeof cmdLogin>[1] = {
        noBrowser: b('no-browser'),
        noInit: b('no-init'),
        untrack: b('untrack'),
      }
      const t = s('token')
      if (t !== undefined) o.token = t
      return cmdLogin(ctx, o)
    }
    case 'init':
      return cmdInit(ctx, { dryRun: b('dry-run') })
    case 'whoami':
      return cmdWhoami(ctx, { json: b('json') })
    case 'status':
      return cmdStatus(ctx, { remote: b('remote') })
    case 'context': {
      const budget = int('budget')
      if (budget === null) {
        io.err('spoor: --budget must be a number\n')
        return 1
      }
      const o: Parameters<typeof cmdContext>[1] = {
        git: b('git'),
        noShared: b('no-shared'),
        json: b('json'),
        strict: b('strict'),
      }
      if (budget !== undefined) o.budget = budget
      const q = s('query')
      if (q !== undefined) o.query = q
      const files = s('files')
      if (files !== undefined) o.files = files.split(',')
      return cmdContext(ctx, o)
    }
    case 'adr import': {
      const o: Parameters<typeof cmdAdrImport>[1] = { dryRun: b('dry-run'), json: b('json') }
      const dir = s('dir')
      if (dir) o.dir = dir
      return cmdAdrImport(ctx, o)
    }
    case 'adr push':
      return cmdPush(ctx, 'adr', rest[0], { force: b('force'), strict: b('strict') })
    case 'docs import':
      return cmdDocsImport(ctx, { dryRun: b('dry-run'), json: b('json') })
    case 'docs push':
      return cmdPush(ctx, 'doc', rest[0], { strict: b('strict') })
    case 'adr draft': {
      const max = int('max')
      if (max === null || max === 0) {
        io.err('spoor: --max must be a positive number\n')
        return 1
      }
      const since = s('since')
      if (since !== undefined && Number.isNaN(Date.parse(since))) {
        io.err('spoor: --since must be an ISO date-time\n')
        return 1
      }
      const o: Parameters<typeof cmdAdrDraft>[1] = {
        dryRun: b('dry-run'),
        background: b('background'),
        strict: b('strict'),
      }
      if (max !== undefined) o.max = max
      if (since !== undefined) o.since = new Date(since).toISOString()
      const session = s('session')
      if (session) o.session = session
      return cmdAdrDraft(ctx, o)
    }
  }
  io.err(`spoor ${key}: not implemented\n`)
  return 1
}
