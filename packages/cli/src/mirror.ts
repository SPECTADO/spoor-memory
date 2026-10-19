/**
 * Repo mirror (cli-and-hooks.md sections 4.2 to 4.4, 5.1 step 6, 3.3): which files are mirrored, one push with its
 * result handling (write-back, renumber rename, bases, conflicts, queue), the import batches, the SessionStart
 * sweep by hash, the retry queue and orphan detection. Push-only (ADR 0009).
 */
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isGlob, matchAnchor, normalizePath, staticPrefix } from '@spoor/shared'
import { type ApiResult, api, type Ctx, projectPath } from './ctx.js'
import { sha256, writeAtomic } from './fsutil.js'
import type { Client } from './http.js'
import type { Deadline } from './runtime.js'
import { insideRoot, isSpoorId, pushResultProblem, validRenumber } from './safety.js'
import {
  addPending,
  type Base,
  baseFor,
  type MirrorKind,
  readState,
  type State,
  updateState,
} from './state.js'
import { adrNumberOf, insertSpoorId, padAdr, readSpoorId, rewriteAdrH1, setAdrNumber } from './writeback.js'

export interface PushWarning {
  code: string
  [k: string]: unknown
}

export interface PushResult {
  source_path?: string
  status: 'created' | 'updated' | 'unchanged'
  handle: string
  spoor_id: string
  space?: string
  revision: number
  number?: number
  adr_number?: number | null
  renumbered: { from: number; to: number } | null
  warnings?: PushWarning[]
}

export const PUSH_TIMEOUT_MS = 6000

// ---- which files are mirrored -----------------------------------------------------------------------------

const SKIP_ADR_NAME = (name: string) => {
  const n = name.toLowerCase()
  return n === 'readme.md' || n === 'index.md' || n.startsWith('template')
}

/** Repo-relative POSIX path of `p` (absolute or relative to `cwd`), or undefined outside the repo. */
export function repoRelative(root: string, p: string, cwd: string = root): string | undefined {
  const abs = isAbsolute(p) ? p : resolve(cwd, p)
  const rel = relative(root, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return rel.split(sep).join('/')
}

export function isAdrPath(ctx: Ctx, rel: string): boolean {
  const dir = ctx.repo.adr_dir
  return dirname(rel) === dir && rel.endsWith('.md') && !SKIP_ADR_NAME(basename(rel))
}

const patternMatches = (pattern: string, rel: string) => {
  const p = normalizePath(pattern)
  return p !== null && matchAnchor(p, rel) > 0
}

export function isDocPath(ctx: Ctx, rel: string): boolean {
  if (isAdrPath(ctx, rel)) return false
  const d = ctx.repo.docs
  return d.include.some((p) => patternMatches(p, rel)) && !d.exclude.some((p) => patternMatches(p, rel))
}

export function classify(ctx: Ctx, rel: string): MirrorKind | undefined {
  if (isAdrPath(ctx, rel)) return 'adr'
  if (isDocPath(ctx, rel)) return 'doc'
  return undefined
}

/** ADR files (`*.md` directly in adr_dir, sorted) and the entries skipped. */
export function adrFiles(ctx: Ctx): { files: string[]; skipped: string[] } {
  const dir = ctx.repo.adr_dir
  let names: string[] = []
  try {
    names = readdirSync(join(ctx.root, dir)).sort()
  } catch {
    return { files: [], skipped: [] }
  }
  const files: string[] = []
  const skipped: string[] = []
  for (const name of names) {
    const rel = `${dir}/${name}`
    let isFile = false
    try {
      isFile = statSync(join(ctx.root, rel)).isFile()
    } catch {
      continue
    }
    if (!isFile) continue
    if (name.endsWith('.md') && !SKIP_ADR_NAME(name)) files.push(rel)
    else skipped.push(rel)
  }
  return { files, skipped }
}

const WALK_SKIP = new Set(['node_modules', '.git', '.spoor', '.claude', 'dist', 'build', 'coverage'])
const WALK_MAX = 5000

/** Files matched by `docs.include` minus `docs.exclude`, sorted. */
export function docFiles(ctx: Ctx): string[] {
  const out = new Set<string>()
  let budget = WALK_MAX
  const walk = (relDir: string, depth: number, visit: (rel: string) => void) => {
    if (depth > 12 || budget <= 0) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(join(ctx.root, relDir), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (--budget <= 0) return
      const rel = relDir === '' ? e.name : `${relDir}/${e.name}`
      if (e.isDirectory()) {
        if (!WALK_SKIP.has(e.name)) walk(rel, depth + 1, visit)
      } else if (e.isFile()) visit(rel)
    }
  }
  for (const pattern of ctx.repo.docs.include) {
    const p = normalizePath(pattern)
    if (p === null) continue
    if (!isGlob(p)) {
      const abs = join(ctx.root, p)
      try {
        const st = statSync(abs)
        if (st.isFile()) {
          if (isDocPath(ctx, p)) out.add(p)
        } else if (st.isDirectory()) {
          walk(p.replace(/\/$/, ''), 0, (rel) => {
            if (isDocPath(ctx, rel)) out.add(rel)
          })
        }
      } catch {
        // missing file
      }
      continue
    }
    const prefix = staticPrefix(p)
    const baseDir = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/')) : ''
    walk(baseDir, 0, (rel) => {
      if (isDocPath(ctx, rel)) out.add(rel)
    })
  }
  return [...out].sort()
}

export function mirroredFiles(ctx: Ctx): { kind: MirrorKind; path: string }[] {
  return [
    ...adrFiles(ctx).files.map((path) => ({ kind: 'adr' as const, path })),
    ...docFiles(ctx).map((path) => ({ kind: 'doc' as const, path })),
  ]
}

// ---- one push -------------------------------------------------------------------------------------------

export type PushOutcome =
  | {
      kind: 'pushed'
      result: PushResult
      path: string
      notes: string[]
      renamedFrom?: string
      /** From the first response when a renumber caused a follow-up push. */
      renumbered?: { from: number; to: number }
    }
  | {
      kind: 'conflict'
      handle: string
      editedBy: string | null
      via: string | null
      currentRevision?: number
    }
  | { kind: 'already_drafted'; handle: string; adr: string }
  | { kind: 'error'; code: string; message: string; status?: number }
  | { kind: 'queued'; code: string }
  | { kind: 'unauthorized' }
  | { kind: 'missing' }

const spaceOf = (kind: MirrorKind) => (kind === 'adr' ? 'decisions' : 'docs')

function readFileText(ctx: Ctx, rel: string): string | undefined {
  if (!insideRoot(ctx.root, rel)) return undefined
  try {
    return readFileSync(join(ctx.root, rel), 'utf8')
  } catch {
    return undefined
  }
}

/** A doc path with no base whose content equals a base whose file is gone: a local rename (section 4.4). */
function renamedDocBase(ctx: Ctx, s: State, rel: string, hash: string): [string, Base] | undefined {
  if (baseFor(s, undefined, rel)) return undefined
  for (const [id, b] of Object.entries(s.bases)) {
    if (b.kind === 'adr' || b.sha256 !== hash || b.path === rel) continue
    if (!existsSync(join(ctx.root, b.path))) return [id, b]
  }
  return undefined
}

/** Handle of a conflicted item: from the base, else from the server message ("ADR-0007 was edited ..."). */
function conflictHandle(base: Base | undefined, message: string, rel: string): string {
  if (base?.handle) return base.handle
  const m = /^(\S+) was edited in Spoor/.exec(message)
  return m?.[1] ?? rel
}

export interface PushOpts {
  force?: boolean
  timeoutMs?: number
  /** Do not queue on a network failure (human commands report instead). */
  noQueue?: boolean
  /** Internal: this is the follow-up push after a renumber. */
  followUp?: boolean
}

/** Push one mirrored file and apply the result to the file and `state.json`. */
export async function pushFile(
  ctx: Ctx,
  client: Client,
  kind: MirrorKind,
  rel: string,
  opts: PushOpts = {},
): Promise<PushOutcome> {
  if (!insideRoot(ctx.root, rel)) {
    await updateState(ctx.root, (s) => {
      s.pending = s.pending.filter((p) => p.path !== rel)
    })
    return { kind: 'error', code: 'outside_repo', message: `${rel} is not inside the repo` }
  }
  const content = readFileText(ctx, rel)
  if (content === undefined) {
    await updateState(ctx.root, (s) => {
      s.pending = s.pending.filter((p) => p.path !== rel)
    })
    return { kind: 'missing' }
  }
  const hash = sha256(content)
  const state = readState(ctx.root)
  const fileId = readSpoorId(content)
  let base = baseFor(state, fileId, rel)
  let sent = content
  if (!base && kind === 'doc' && !fileId) {
    const renamed = renamedDocBase(ctx, state, rel, hash)
    if (renamed && isSpoorId(renamed[0])) {
      base = renamed
      sent = insertSpoorId(content, renamed[0])
    }
  }
  const body: Record<string, unknown> = { space: spaceOf(kind), source_path: rel, content: sent }
  if (base) body.base_revision = base[1].revision
  if (opts.force) body.force = true
  const r = await api<PushResult>(client, 'POST', projectPath(ctx, '/api/push'), {
    body,
    timeoutMs: opts.timeoutMs ?? PUSH_TIMEOUT_MS,
  })
  return handlePushResponse(ctx, client, kind, rel, r, base?.[1], hash, opts)
}

async function handlePushResponse(
  ctx: Ctx,
  client: Client,
  kind: MirrorKind,
  rel: string,
  r: ApiResult<PushResult>,
  base: Base | undefined,
  hash: string,
  opts: PushOpts,
): Promise<PushOutcome> {
  const now = ctx.rt.now()
  switch (r.kind) {
    case 'ok': {
      const problem = pushResultProblem(r.body)
      if (problem) {
        // never write what an unexpected answer says into a repo file (review-log-phase5 S1-S3)
        await updateState(ctx.root, (s) => {
          s.pending = s.pending.filter((p) => p.path !== rel)
        })
        return { kind: 'error', code: 'invalid_response', message: `unexpected push result (${problem})` }
      }
      const applied = await applyPushResult(ctx, kind, rel, r.body)
      const renumbered = kind === 'adr' ? validRenumber(r.body.renumbered) : undefined
      if (applied.repush && !opts.followUp) {
        // renumbered: push the renamed file once more so Spoor's source_path (and `adr:`) follow the file
        const again = await pushFile(ctx, client, kind, applied.path, {
          ...opts,
          force: false,
          followUp: true,
        })
        if (again.kind === 'pushed')
          return {
            ...again,
            notes: [...applied.notes, ...again.notes],
            renamedFrom: rel,
            ...(renumbered ? { renumbered } : {}),
          }
      }
      const out: PushOutcome = { kind: 'pushed', result: r.body, path: applied.path, notes: applied.notes }
      if (renumbered) out.renumbered = renumbered
      if (applied.path !== rel) out.renamedFrom = rel
      return out
    }
    case 'network':
    case 'offline': {
      if (!opts.noQueue) await updateState(ctx.root, (s) => addPending(s, kind, rel, now))
      return { kind: 'queued', code: r.kind === 'offline' ? 'offline' : r.code }
    }
    case 'unauthorized':
      return { kind: 'unauthorized' }
    case 'error': {
      if (r.code === 'pushed_over_spoor_edit') {
        const details = (r.body.details ?? {}) as Record<string, unknown>
        const handle = conflictHandle(base, r.message, rel)
        const editedBy = typeof details.edited_by === 'string' ? details.edited_by : null
        await updateState(ctx.root, (s) => {
          const existing = s.conflicts.find((c) => c.path === rel)
          const entry = {
            path: rel,
            handle,
            since: existing?.since ?? new Date(now).toISOString(),
            edited_by: editedBy,
            sha256: hash,
          }
          s.conflicts = [...s.conflicts.filter((c) => c.path !== rel), entry]
          s.pending = s.pending.filter((p) => p.path !== rel)
        })
        const out: PushOutcome = {
          kind: 'conflict',
          handle,
          editedBy,
          via: typeof details.via === 'string' ? details.via : null,
        }
        if (typeof details.current_revision === 'number') out.currentRevision = details.current_revision
        return out
      }
      if (r.code === 'already_drafted') {
        const d = (r.body.details ?? {}) as Record<string, unknown>
        return { kind: 'already_drafted', handle: String(d.handle ?? ''), adr: String(d.adr ?? '') }
      }
      // validation and other client errors: never queued (section 3.3)
      await updateState(ctx.root, (s) => {
        s.pending = s.pending.filter((p) => p.path !== rel)
      })
      return { kind: 'error', code: r.code, message: r.message, status: r.status }
    }
  }
}

/**
 * Apply a successful push or import result: renumber rename, `spoor_id` write-back, bases, clear conflicts and
 * queue entries. Returns the file's final path, printable notes and whether a follow-up push is needed.
 * `rel` must be a path the CLI itself chose (never a path from the server) and `result` must have passed
 * `pushResultProblem`; both are checked again here and an unsafe value throws before anything is written.
 */
export async function applyPushResult(
  ctx: Ctx,
  kind: MirrorKind,
  rel: string,
  result: PushResult,
): Promise<{ path: string; notes: string[]; repush: boolean }> {
  if (!insideRoot(ctx.root, rel)) throw new Error(`refusing to write ${rel}: not inside the repo`)
  const problem = pushResultProblem(result)
  if (problem) throw new Error(`refusing to apply a push result: ${problem}`)
  const notes: string[] = []
  let path = rel
  let repush = false
  let content = readFileText(ctx, rel)
  if (content === undefined) return { path, notes, repush }

  const renumbered = kind === 'adr' ? validRenumber(result.renumbered) : undefined
  if (renumbered) {
    const { from, to } = renumbered
    const name = basename(rel)
    const m = /^(\d{1,5})-(.*)$/.exec(name)
    let next = content
    if (/^adr:/m.test(content)) next = setAdrNumber(content, to)
    const h1 = rewriteAdrH1(next, from, to)
    if (h1 !== next) {
      next = h1
      notes.push(`rewrote the H1 of ${rel} (ADR ${from} → ${to})`)
    }
    if (m) {
      const target = `${dirname(rel)}/${padAdr(to)}-${m[2]}`
      if (!insideRoot(ctx.root, target) || !isAdrPath(ctx, target)) {
        notes.push(`warning: cannot rename ${rel} to ${target}: not in ${ctx.repo.adr_dir}`)
      } else if (!existsSync(join(ctx.root, target))) {
        renameSync(join(ctx.root, rel), join(ctx.root, target))
        path = target
      } else {
        notes.push(`warning: cannot rename ${rel} to ${target}: the file exists`)
      }
    }
    if (next !== content) {
      writeAtomic(join(ctx.root, path), next)
      content = next
    }
    notes.push(`renumbered ${rel} → ${path} (ADR ${from} → ${to})`)
    repush = true
  }

  const writeBack = kind === 'adr' || ctx.repo.docs.write_back
  if (writeBack && !readSpoorId(content)) {
    const next = insertSpoorId(content, result.spoor_id)
    if (next !== content) {
      writeAtomic(join(ctx.root, path), next)
      content = next
    }
  }

  const hash = sha256(content)
  await updateState(ctx.root, (s) => {
    for (const [id, b] of Object.entries(s.bases)) {
      if (id !== result.spoor_id && (b.path === rel || b.path === path)) delete s.bases[id]
    }
    s.bases[result.spoor_id] = { path, revision: result.revision, sha256: hash, handle: result.handle, kind }
    s.conflicts = s.conflicts.filter((c) => c.path !== rel && c.path !== path)
    s.pending = s.pending.filter((p) => p.path !== rel && p.path !== path)
  })
  for (const w of result.warnings ?? []) {
    if (w.code === 'ambiguous_ref')
      notes.push(`warning: ${path}: ambiguous reference ${String(w.ref)} (not applied; fix the file)`)
    else if (w.code === 'unresolved_supersedes')
      notes.push(`warning: ${path}: unresolved supersedes ${String(w.ref)}`)
    else if (w.code === 'number_mismatch')
      notes.push(`warning: ${path}: file number ${String(w.file)} differs from Spoor's ${String(w.item)}`)
    else if (w.code === 'foreign_spoor_id')
      notes.push(`warning: ${path}: spoor_id belongs to another project; ignored`)
  }
  return { path, notes, repush }
}

// ---- retry queue, sweep, orphans --------------------------------------------------------------------------

export interface SweepReport {
  pushed: number
  queued: number
  conflicts: number
  stopped: boolean
}

/** Replay `state.pending` until the deadline (section 3.3). Stops at the first network failure. */
export async function replayPending(ctx: Ctx, client: Client, deadline: Deadline): Promise<SweepReport> {
  const rep: SweepReport = { pushed: 0, queued: 0, conflicts: 0, stopped: false }
  const pending = readState(ctx.root).pending
  for (const p of pending) {
    if (deadline.expired(500)) {
      rep.stopped = true
      break
    }
    if (!existsSync(join(ctx.root, p.path))) {
      await updateState(ctx.root, (s) => {
        s.pending = s.pending.filter((x) => x.path !== p.path)
      })
      continue
    }
    const o = await pushFile(ctx, client, p.kind, p.path, { timeoutMs: deadline.cap(PUSH_TIMEOUT_MS) })
    if (o.kind === 'pushed') rep.pushed++
    else if (o.kind === 'conflict') rep.conflicts++
    else if (o.kind === 'queued' || o.kind === 'unauthorized') {
      rep.stopped = true
      break
    }
  }
  return rep
}

/**
 * Local mirror sweep (section 5.1 step 6): hash every mirrored file, push changed or new ones; what does not fit
 * before the deadline is queued. No network when nothing changed.
 */
export async function sweepMirror(ctx: Ctx, client: Client, deadline: Deadline): Promise<SweepReport> {
  const rep: SweepReport = { pushed: 0, queued: 0, conflicts: 0, stopped: false }
  const state = readState(ctx.root)
  const changed: { kind: MirrorKind; path: string }[] = []
  for (const f of mirroredFiles(ctx)) {
    const content = readFileText(ctx, f.path)
    if (content === undefined) continue
    const hash = sha256(content)
    const base = baseFor(state, readSpoorId(content), f.path)
    if (base && base[1].sha256 === hash && base[1].path === f.path) continue
    const conflict = state.conflicts.find((c) => c.path === f.path)
    if (conflict?.sha256 === hash) continue // still the refused content: a human resolves it
    changed.push(f)
  }
  let offline = false
  for (const f of changed) {
    if (offline || deadline.expired(500)) {
      await updateState(ctx.root, (s) => addPending(s, f.kind, f.path, ctx.rt.now()))
      rep.queued++
      rep.stopped = true
      continue
    }
    const o = await pushFile(ctx, client, f.kind, f.path, { timeoutMs: deadline.cap(PUSH_TIMEOUT_MS) })
    if (o.kind === 'pushed') rep.pushed++
    else if (o.kind === 'conflict') rep.conflicts++
    else if (o.kind === 'queued') {
      rep.queued++
      offline = true
    } else if (o.kind === 'unauthorized') offline = true
  }
  return rep
}

/** Bases whose file is gone (section 4.4): listed, never retired automatically. */
export function orphans(ctx: Ctx, state: State = readState(ctx.root)): { id: string; base: Base }[] {
  return Object.entries(state.bases)
    .filter(([, b]) => !existsSync(join(ctx.root, b.path)))
    .map(([id, base]) => ({ id, base }))
    .sort((a, b) => a.base.path.localeCompare(b.base.path))
}

// ---- import -----------------------------------------------------------------------------------------------

export const IMPORT_MAX_FILES = 100
export const IMPORT_MAX_BYTES = 900 * 1024

export function importBatches(files: { source_path: string; content: string }[]) {
  const batches: { source_path: string; content: string }[][] = []
  let cur: { source_path: string; content: string }[] = []
  let bytes = 0
  for (const f of files) {
    const size = Buffer.byteLength(f.content) + Buffer.byteLength(f.source_path) + 64
    if (cur.length > 0 && (cur.length >= IMPORT_MAX_FILES || bytes + size > IMPORT_MAX_BYTES)) {
      batches.push(cur)
      cur = []
      bytes = 0
    }
    cur.push(f)
    bytes += size
  }
  if (cur.length > 0) batches.push(cur)
  return batches
}

export function highestAdrNumber(ctx: Ctx, files: string[]): number {
  let max = 0
  for (const rel of files) {
    const content = readFileText(ctx, rel) ?? ''
    const n = adrNumberOf(basename(rel), content)
    if (n !== undefined && n > max) max = n
  }
  return max
}

export { readFileText }
