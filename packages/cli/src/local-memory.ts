/**
 * Memory files that were in the repo before Spoor (ADR-0036, cli-and-hooks.md section 4.11): `MEMORY.md`,
 * `.memory/**` and the other `local_memory.paths`. `spoor init` asks once what to do with them and stores the answer
 * in `spoor.config.json` (`local_memory.mode`):
 *
 * - `sync`: the files stay and are mirrored to the docs space both ways. The push half is the ordinary mirror
 *   (mirror.ts `classify`); the pull half is here: a file that is unchanged since its last push takes the body of a
 *   newer server revision. A file changed on both sides is a push conflict, resolved by a human.
 * - `delete`: every file is pushed to the docs space once and removed only after the server took it.
 */
import { readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { api, authProblem, type Ctx, clientFor, projectPath } from './ctx.js'
import { logRun, sha256, writeAtomic } from './fsutil.js'
import type { Client } from './http.js'
import { localMemoryFiles, PUSH_TIMEOUT_MS, pushFile, readFileText } from './mirror.js'
import type { Deadline } from './runtime.js'
import { insideRoot, isSpoorId } from './safety.js'
import { baseFor, readState, updateState } from './state.js'
import { bodyStart, readSpoorId } from './writeback.js'

export type LocalMemoryMode = 'sync' | 'delete'

export const isLocalMemoryMode = (v: unknown): v is LocalMemoryMode => v === 'sync' || v === 'delete'

/** `a, b, +3 more` for a status line. */
export function fileList(files: string[], max = 3): string {
  const shown = files.slice(0, max)
  return files.length > shown.length
    ? `${shown.join(', ')}, +${files.length - shown.length} more`
    : shown.join(', ')
}

interface PullBody {
  spoor_id?: unknown
  revision?: unknown
  body?: unknown
}

/** The largest body the CLI writes into a file: what a push may carry (api.md section 7.2). */
const PULL_MAX_CHARS = 400_000

export interface PullReport {
  /** Files rewritten with Spoor's newer text. */
  pulled: string[]
  /** The server has no `GET pull` (older than the CLI): nothing can be pulled. */
  unsupported: boolean
  /** A network failure, a rejected token or the deadline ended the run early. */
  stopped: boolean
}

export interface PullOpts {
  deadline?: Deadline
  /** Overwrite these files with Spoor's text even when they changed locally (a human resolving a conflict). */
  takeServer?: Set<string>
}

/**
 * The pull half of `sync`. Per file that has a push base and is unchanged since that push: ask the server for the
 * item mirrored at this path and, when its revision is newer, replace the file's body (the frontmatter block stays).
 * The new base is the server's revision and the written text, so the next sweep does not push it back.
 */
export async function pullLocalMemory(ctx: Ctx, client: Client, opts: PullOpts = {}): Promise<PullReport> {
  const rep: PullReport = { pulled: [], unsupported: false, stopped: false }
  if (ctx.repo.local_memory.mode !== 'sync') return rep
  for (const rel of localMemoryFiles(ctx)) {
    if (opts.deadline?.expired(500)) {
      rep.stopped = true
      break
    }
    const content = readFileText(ctx, rel)
    if (content === undefined) continue
    const state = readState(ctx.root)
    const base = baseFor(state, readSpoorId(content), rel)
    if (!base) continue // never pushed: the sweep creates it
    const forced = opts.takeServer?.has(rel) === true
    const localChanged = sha256(content) !== base[1].sha256
    if (localChanged && !forced) continue // the push decides: fast-forward, or a conflict for a human
    const r = await api<PullBody>(
      client,
      'GET',
      projectPath(ctx, `/api/pull?source_path=${encodeURIComponent(rel)}`),
      { timeoutMs: opts.deadline ? opts.deadline.cap(4000) : 6000 },
    )
    if (r.kind === 'error') {
      // 404 `No item mirrors …`: retired on the server; any other 404 is a server without the route
      if (r.status === 404 && !r.message.startsWith('No item mirrors')) {
        rep.unsupported = true
        break
      }
      continue
    }
    if (r.kind !== 'ok') {
      rep.stopped = true
      break
    }
    const { spoor_id: id, revision, body } = r.body ?? {}
    if (
      !isSpoorId(id) ||
      typeof revision !== 'number' ||
      !Number.isInteger(revision) ||
      revision < 1 ||
      typeof body !== 'string' ||
      body.length > PULL_MAX_CHARS
    ) {
      logRun(ctx.root, `pull ${rel}: unexpected answer from the server`, ctx.rt.now())
      continue
    }
    if (revision <= base[1].revision && !forced) continue
    const head = content.slice(0, bodyStart(content))
    const same = content.slice(head.length).trim() === body.trim()
    const next = same ? content : `${head}${body.endsWith('\n') ? body : `${body}\n`}`
    if (!same) {
      if (!insideRoot(ctx.root, rel)) continue
      writeAtomic(join(ctx.root, rel), next)
      rep.pulled.push(rel)
    }
    await updateState(ctx.root, (s) => {
      for (const [k, b] of Object.entries(s.bases)) if (k !== id && b.path === rel) delete s.bases[k]
      const handle = base[1].handle
      s.bases[id] = { path: rel, revision, sha256: sha256(next), kind: 'doc', ...(handle ? { handle } : {}) }
      s.conflicts = s.conflicts.filter((c) => c.path !== rel)
      s.pending = s.pending.filter((p) => p.path !== rel)
    })
  }
  return rep
}

/** Remove `rel`'s directory, and its parents up to the repo root, while they are empty. */
function removeEmptyDirs(root: string, rel: string): void {
  let dir = dirname(rel)
  while (dir !== '.' && dir !== '' && insideRoot(root, dir)) {
    try {
      if (readdirSync(join(root, dir)).length > 0) return
      rmdirSync(join(root, dir))
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

/** One line per file, and the worst exit code: 0 done, 1 an error, 2 a conflict, 3 the server did not answer. */
interface Run {
  code: number
}

const worse = (run: Run, code: number) => {
  run.code = Math.max(run.code, code)
}

/** Push one local memory file and print the outcome. Returns true when the server now holds the file's text. */
async function pushOne(
  ctx: Ctx,
  client: Client,
  rel: string,
  run: Run,
  o: { force?: boolean } = {},
): Promise<{ ok: boolean; handle?: string; id?: string }> {
  const out = await pushFile(ctx, client, 'doc', rel, {
    noQueue: true,
    timeoutMs: PUSH_TIMEOUT_MS,
    ...(o.force ? { force: true } : {}),
  })
  switch (out.kind) {
    case 'pushed':
      return { ok: true, handle: out.result.handle, id: out.result.spoor_id }
    case 'conflict':
      ctx.rt.err(
        `conflict ${rel}: ${out.handle} was edited in Spoor and the file changed too; run spoor memory sync --take-server or --take-local\n`,
      )
      worse(run, 2)
      return { ok: false }
    case 'queued':
      ctx.rt.err(`spoor: server unreachable (${out.code}); ${rel} was not sent\n`)
      worse(run, 3)
      return { ok: false }
    case 'unauthorized':
      ctx.rt.err(`spoor: token rejected by ${ctx.server ?? ''} (401). Run: spoor login\n`)
      worse(run, 3)
      return { ok: false }
    case 'missing':
      return { ok: false }
    case 'already_drafted':
      worse(run, 1)
      return { ok: false }
    case 'error':
      ctx.rt.err(`error ${rel}: ${out.code}${out.message ? `: ${out.message}` : ''}\n`)
      worse(run, 1)
      return { ok: false }
  }
}

export interface SyncOpts {
  /** Conflicted files take Spoor's text. */
  takeServer?: boolean
  /** Conflicted files overwrite Spoor (`force`); the caller has confirmed it. */
  takeLocal?: boolean
}

/**
 * `sync`, both halves, for a human command (`spoor init`, `spoor memory sync`): pull what is newer in Spoor, then
 * push every file that differs from its base. Prints one line per file that moved.
 */
export async function syncLocalMemory(ctx: Ctx, o: SyncOpts = {}): Promise<number> {
  const problem = authProblem(ctx)
  if (problem) {
    ctx.rt.err(`${problem}\n`)
    return 1
  }
  const run: Run = { code: 0 }
  const client = clientFor(ctx, { breaker: 'off', timeoutMs: 10_000 })
  const conflicted = new Set(readState(ctx.root).conflicts.map((c) => c.path))
  const pull = await pullLocalMemory(ctx, client, o.takeServer ? { takeServer: conflicted } : {})
  for (const p of pull.pulled) ctx.rt.out(`pulled ${p} (Spoor had a newer text)\n`)
  if (pull.unsupported)
    ctx.rt.err(
      'note: this server cannot send memory files back yet (it is older than the CLI); pushing only\n',
    )
  if (pull.stopped) {
    ctx.rt.err(`spoor: server unreachable or token rejected (${ctx.server ?? ''}); nothing more was synced\n`)
    return 3
  }
  let unchanged = 0
  for (const rel of localMemoryFiles(ctx)) {
    const content = readFileText(ctx, rel)
    if (content === undefined) continue
    const state = readState(ctx.root)
    const base = baseFor(state, readSpoorId(content), rel)
    const hash = sha256(content)
    if (base && base[1].sha256 === hash && base[1].path === rel) {
      unchanged++
      continue
    }
    const refused = state.conflicts.find((c) => c.path === rel)
    if (refused?.sha256 === hash && !o.takeLocal) {
      ctx.rt.err(
        `conflict ${rel}: ${refused.handle} was edited in Spoor and the file changed too; run spoor memory sync --take-server or --take-local\n`,
      )
      worse(run, 2)
      continue
    }
    const r = await pushOne(ctx, client, rel, run, { force: o.takeLocal === true && refused !== undefined })
    if (r.ok) ctx.rt.out(`pushed ${rel}${r.handle ? ` (${r.handle})` : ''}\n`)
    if (run.code === 3) break
  }
  if (unchanged > 0) ctx.rt.out(`${unchanged} local memory ${unchanged === 1 ? 'file' : 'files'} in sync\n`)
  return run.code
}

/**
 * `delete`: push each file to the docs space, and remove it only after the server answered that it holds the text.
 * The base is dropped with the file, so the item is not reported as an orphaned mirror file.
 */
export async function deleteLocalMemory(ctx: Ctx, files: string[]): Promise<number> {
  const problem = authProblem(ctx)
  if (problem) {
    ctx.rt.err(`${problem}\n`)
    ctx.rt.err('spoor: local memory files were not imported or deleted; run spoor login, then spoor init\n')
    return 1
  }
  const run: Run = { code: 0 }
  const client = clientFor(ctx, { breaker: 'off', timeoutMs: 10_000 })
  for (const rel of files) {
    if (!insideRoot(ctx.root, rel)) continue
    const r = await pushOne(ctx, client, rel, run)
    if (!r.ok) {
      if (run.code === 3) break
      continue
    }
    try {
      unlinkSync(join(ctx.root, rel))
    } catch (e) {
      ctx.rt.err(`spoor: ${rel} is in Spoor but could not be deleted (${(e as Error).message})\n`)
      worse(run, 1)
      continue
    }
    removeEmptyDirs(ctx.root, rel)
    await updateState(ctx.root, (s) => {
      for (const [k, b] of Object.entries(s.bases)) if (b.path === rel) delete s.bases[k]
      s.conflicts = s.conflicts.filter((c) => c.path !== rel)
      s.pending = s.pending.filter((p) => p.path !== rel)
    })
    ctx.rt.out(`imported ${rel} as ${r.handle ?? 'a doc'}, deleted the file\n`)
  }
  if (run.code !== 0) ctx.rt.err('spoor: files that were not imported were kept; run spoor init again\n')
  return run.code
}

/**
 * SessionStart lines about local memory files (section 5.1 step 5b). Nobody answered yet: the agent asks the user.
 * `delete` was chosen and files are there again (a merge brought them back): `spoor init` imports and removes them.
 */
export function localMemoryLines(ctx: Ctx): string[] {
  const mode = ctx.repo.local_memory.mode
  if (mode === 'sync') return []
  const files = localMemoryFiles(ctx)
  if (files.length === 0) return []
  const n = files.length
  if (mode === 'delete')
    return [
      `Spoor: ${n} local memory ${n === 1 ? 'file is' : 'files are'} in the repo again (${fileList(files)}); this project imports such files into Spoor and deletes them. Ask the user to run spoor init.`,
    ]
  return [
    `Spoor: this repo still has ${n} memory ${n === 1 ? 'file' : 'files'} from before Spoor (${fileList(files)}). Ask the user whether to delete ${n === 1 ? 'it' : 'them'} (after importing into Spoor) or keep ${n === 1 ? 'it' : 'them'} in sync with Spoor, then run: spoor init --local-memory delete (or sync).`,
  ]
}
