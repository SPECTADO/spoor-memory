/** git helpers with hard timeouts; every failure (no git, not a repo, timeout) is an empty result. */
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function git(cwd: string, args: string[], timeoutMs = 2000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    if (timeoutMs <= 0) {
      resolve({ ok: false, out: '' })
      return
    }
    try {
      execFile(
        'git',
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        },
        (err, stdout) => resolve({ ok: !err, out: err ? '' : String(stdout) }),
      )
    } catch {
      resolve({ ok: false, out: '' })
    }
  })
}

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')

/**
 * The repo root's place below the git work-tree top level: `''` at the top, `pkg/sub/` in a subdirectory, undefined
 * outside a repository. The CLI's root (nearest `.git` or `.claude`, or `CLAUDE_PROJECT_DIR`) can be below the top
 * level, while `git status`, `git diff` and `git log` print paths relative to the top level (deviations H11).
 */
export async function gitPrefix(root: string, timeoutMs = 1000): Promise<string | undefined> {
  const r = await git(root, ['rev-parse', '--show-prefix'], timeoutMs)
  return r.ok ? r.out.replace(/\r?\n$/, '') : undefined
}

/** Top-level-relative git paths → root-relative ones; paths outside the root are dropped (H11). */
export function relativeToRoot(paths: string[], prefix: string): string[] {
  if (prefix === '') return paths
  const out: string[] = []
  for (const p of paths)
    if (p.startsWith(prefix) && p.length > prefix.length) out.push(p.slice(prefix.length))
  return out
}

const LOCK_FILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
  'go.sum',
  'uv.lock',
  'Pipfile.lock',
  'flake.lock',
])

/** `.spoor/`, `.claude/` and lock files are never anchors or "changed files". */
export function isNoisePath(p: string): boolean {
  if (p.startsWith('.spoor/') || p.startsWith('.claude/') || p === '.spoor' || p === '.claude') return true
  const base = p.slice(p.lastIndexOf('/') + 1)
  return LOCK_FILES.has(base) || base.endsWith('.lock')
}

/**
 * Anchors from git (cli-and-hooks.md section 5.1 step 4): tracked uncommitted, untracked, then files of the last
 * 30 commits; de-duplicated, existing files only, noise skipped, capped at `max`. One time budget for all four git
 * calls. Paths are relative to `root` (diff and log print top-level paths, `ls-files` cwd-relative ones; H11).
 */
export async function gitAnchors(
  root: string,
  max: number,
  timeoutMs = 2000,
  now = Date.now,
): Promise<string[]> {
  const end = now() + timeoutMs
  const left = () => Math.max(0, end - now())
  const out: string[] = []
  const seen = new Set<string>()
  const add = (list: string[]) => {
    for (const p of list) {
      if (out.length >= max) return
      if (seen.has(p) || isNoisePath(p)) continue
      seen.add(p)
      if (!existsSync(join(root, p))) continue
      out.push(p)
    }
  }
  const prefix = await gitPrefix(root, left())
  if (prefix === undefined) return out
  // [args, prints top-level-relative paths]
  const steps: [string[], boolean][] = [
    [['diff', '--name-only', 'HEAD'], true],
    [['ls-files', '--others', '--exclude-standard'], false],
    [['log', '-n', '30', '--name-only', '--diff-filter=ACMR', '--pretty=format:'], true],
  ]
  for (const [args, fromTop] of steps) {
    if (out.length >= max) break
    const r = await git(root, ['-c', 'core.quotepath=off', ...args], left())
    if (r.ok) add(fromTop ? relativeToRoot(lines(r.out), prefix) : lines(r.out))
  }
  return out
}

export async function gitHead(root: string, timeoutMs = 1000): Promise<string | null> {
  const r = await git(root, ['rev-parse', 'HEAD'], timeoutMs)
  const head = r.out.trim()
  return r.ok && /^[0-9a-f]{7,64}$/.test(head) ? head : null
}

/**
 * Paths from `git status --porcelain` (renames give the new path), relative to `root`; deleted entries and paths
 * outside `root` are skipped. One time budget for both git calls.
 */
export async function gitStatusPaths(
  root: string,
  timeoutMs = 2000,
  now: () => number = Date.now,
): Promise<string[]> {
  const end = now() + timeoutMs
  const prefix = await gitPrefix(root, Math.min(1000, timeoutMs))
  if (prefix === undefined) return []
  const r = await git(
    root,
    ['-c', 'core.quotepath=off', 'status', '--porcelain', '--untracked-files=all'],
    Math.max(0, end - now()),
  )
  if (!r.ok) return []
  const out: string[] = []
  for (const line of r.out.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    if (code.includes('D')) continue
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) path = path.slice(arrow + 4)
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
    out.push(path)
  }
  return relativeToRoot(out, prefix)
}

/** `git diff --name-only <range>`, relative to `root`; paths outside `root` are skipped. */
export async function gitDiffNames(
  root: string,
  range: string,
  timeoutMs = 2000,
  now: () => number = Date.now,
): Promise<string[]> {
  const end = now() + timeoutMs
  const prefix = await gitPrefix(root, Math.min(1000, timeoutMs))
  if (prefix === undefined) return []
  const r = await git(
    root,
    ['-c', 'core.quotepath=off', 'diff', '--name-only', range],
    Math.max(0, end - now()),
  )
  return r.ok ? relativeToRoot(lines(r.out), prefix) : []
}

export function mtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

/** Git work-tree root, or undefined outside a repository. */
export async function gitTopLevel(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel'], 2000)
  return r.ok && r.out.trim() !== '' ? r.out.trim() : undefined
}

/** True when `rel` (a path or directory) has tracked files. */
export async function isTracked(root: string, rel: string): Promise<boolean> {
  const r = await git(root, ['ls-files', '--', rel], 2000)
  return r.ok && r.out.trim() !== ''
}
