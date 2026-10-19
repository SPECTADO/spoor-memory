/**
 * Process seams of the CLI (stdout, stderr, env, cwd, stdin, clock, child processes, browser), so every
 * command and hook runs in tests against a temp repo and a fake HTTP server.
 */
import { spawn } from 'node:child_process'
import { hostname as osHostname } from 'node:os'
import { createInterface } from 'node:readline'

export interface Io {
  out: (s: string) => void
  err: (s: string) => void
  env: NodeJS.ProcessEnv
  cwd?: string
  /** Whole stdin as text (hook JSON, `--token -`). Default: process.stdin, empty for a TTY. */
  readStdin?: () => Promise<string>
  /** True when a human is at the terminal (stdin and stdout are TTYs). */
  isTTY?: boolean
  /** Ask one question on the terminal and return the typed line. */
  prompt?: (question: string) => Promise<string>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Start `spoor <args>` detached from this process (the Stop hook's drafting run). */
  spawnDetached?: (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => void
  openBrowser?: (url: string) => void
  hostname?: () => string
}

export interface Rt {
  out: (s: string) => void
  err: (s: string) => void
  env: NodeJS.ProcessEnv
  cwd: string
  readStdin: () => Promise<string>
  isTTY: boolean
  prompt: (question: string) => Promise<string>
  now: () => number
  sleep: (ms: number) => Promise<void>
  spawnDetached: (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => void
  openBrowser: (url: string) => void
  hostname: () => string
}

export function readProcessStdin(timeoutMs = 1500): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('')
  return new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      process.stdin.removeAllListeners('data')
      process.stdin.pause()
      resolve(data)
    }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c: string) => {
      data += c
      if (data.length > 2_000_000) finish()
    })
    process.stdin.once('end', finish)
    process.stdin.once('error', finish)
  })
}

function terminalPrompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

/** Path of the running `spoor` entry point, for the detached drafting child. */
export function selfCommand(): string[] {
  const script = process.argv[1]
  return script ? [process.execPath, script] : [process.execPath]
}

function detached(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): void {
  const [cmd, ...rest] = selfCommand()
  const child = spawn(cmd as string, [...rest, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: 'ignore',
  })
  child.on('error', () => {})
  child.unref()
}

function browser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // no browser: the URL is printed anyway
  }
}

/**
 * Strip terminal control characters (C0 except TAB and LF, DEL, C1, bidi controls) from everything the CLI prints:
 * much of it is server-derived (codes, labels, handles, error messages, the digest), and an ESC/OSC sequence could
 * rewrite the terminal title, hide text or spoof lines (review-log-phase5 S6). JSON output is unaffected because
 * JSON.stringify already escapes control characters.
 */
export function terminalSafe(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0) as number
    const control =
      (c < 0x20 && c !== 0x09 && c !== 0x0a) ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x200e ||
      c === 0x200f ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    if (!control) out += ch
  }
  return out
}

export function runtimeOf(io: Io): Rt {
  return {
    out: (s) => io.out(terminalSafe(s)),
    err: (s) => io.err(terminalSafe(s)),
    env: io.env,
    cwd: io.cwd ?? process.cwd(),
    readStdin: io.readStdin ?? (() => readProcessStdin()),
    isTTY: io.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: (q) => (io.prompt ?? terminalPrompt)(terminalSafe(q)),
    now: io.now ?? Date.now,
    sleep: io.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    spawnDetached: io.spawnDetached ?? detached,
    openBrowser: io.openBrowser ?? browser,
    hostname: io.hostname ?? osHostname,
  }
}

/** One wall-clock budget shared by every step of a hook or the drafting run. */
export class Deadline {
  readonly end: number
  constructor(
    private readonly now: () => number,
    ms: number,
  ) {
    this.end = now() + ms
  }
  remaining(): number {
    return Math.max(0, this.end - this.now())
  }
  /** A step timeout: `ms`, but never past the deadline minus a margin for writing the output. */
  cap(ms: number, margin = 250): number {
    return Math.max(0, Math.min(ms, this.remaining() - margin))
  }
  expired(margin = 250): boolean {
    return this.remaining() <= margin
  }
}
