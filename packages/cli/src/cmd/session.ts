/**
 * The three Claude Code hooks (cli-and-hooks.md section 5): SessionStart digest injection, the Stop nag plus the
 * detached drafting run, and PostToolUse push on change. Callers wrap them in `runHook` (always exit 0).
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { api, authProblem, type Ctx, clientFor, installUrl, mcpUrlMismatch, projectPath } from '../ctx.js'
import {
  jsonText,
  lockHolder,
  logRun,
  oncePerDay,
  readJsonObject,
  sha256,
  spoorDir,
  writeAtomic,
} from '../fsutil.js'
import { gitAnchors, gitDiffNames, gitHead, gitStatusPaths, isNoisePath, mtimeMs } from '../git.js'
import { offlineUntil } from '../http.js'
import {
  classify,
  orphans,
  PUSH_TIMEOUT_MS,
  pushFile,
  replayPending,
  repoRelative,
  sweepMirror,
} from '../mirror.js'
import type { Deadline } from '../runtime.js'
import { addPending, type Drafted, readState, type State, updateState } from '../state.js'
import { padAdr } from '../writeback.js'
import { contextQuery } from './info.js'

export const SESSION_START_DEADLINE_MS = 7000
export const STOP_DEADLINE_MS = 6000
export const POST_TOOL_USE_DEADLINE_MS = 8000
export const OUTPUT_MAX = 9500
const MARKER_MAX_AGE_MS = 14 * 24 * 3600 * 1000
const NO_MARKER_WINDOW_MS = 6 * 3600 * 1000

export type HookInput = Record<string, unknown>

export function parseHookInput(text: string): HookInput {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as HookInput) : {}
  } catch {
    return {}
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** File-name-safe session id (Claude Code uses uuids; anything else is hashed). */
export function sessionKey(id: string | undefined): string | undefined {
  if (!id) return undefined
  return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : sha256(id).slice(0, 32)
}

const sessionDir = (ctx: Ctx) => join(spoorDir(ctx.root), 'session')

interface Marker {
  started_at: string
  head: string | null
  source: string
}

function readMarker(ctx: Ctx, key: string): Marker | undefined {
  try {
    const m = readJsonObject(join(sessionDir(ctx), `${key}.json`))
    return typeof m.started_at === 'string' ? (m as unknown as Marker) : undefined
  } catch {
    return undefined
  }
}

function sweepOldMarkers(ctx: Ctx): void {
  try {
    const dir = sessionDir(ctx)
    for (const n of readdirSync(dir)) {
      const p = join(dir, n)
      try {
        if (ctx.rt.now() - statSync(p).mtimeMs > MARKER_MAX_AGE_MS) unlinkSync(p)
      } catch {
        // raced with another session
      }
    }
  } catch {
    // no directory yet
  }
}

/** Cut at a line boundary to at most `max` characters. */
export function cutOutput(text: string, max = OUTPUT_MAX): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const nl = cut.lastIndexOf('\n')
  return nl > 0 ? cut.slice(0, nl + 1) : cut
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** Drafted ADR files not announced yet whose file still exists (a human has not deleted or moved them). */
function newDrafts(ctx: Ctx, state: State): [string, Drafted][] {
  return Object.entries(state.drafted).filter(
    ([, d]) => d.announced !== true && d.adr !== undefined && existsSync(join(ctx.root, d.path)),
  )
}

/** Status lines shown before the digest: open push conflicts, a foreign `.mcp.json` URL, new drafts, orphans. */
export function statusLines(ctx: Ctx): string[] {
  const state = readState(ctx.root)
  const lines: string[] = []
  const c = state.conflicts
  if (c.length > 0) {
    const list = c.map((x) => `${x.path} (${x.handle})`).join(', ')
    lines.push(
      `Spoor: ${c.length} repo ${plural(c.length, 'file', 'files')} not pushed because ${plural(c.length, 'it was', 'they were')} edited in the Spoor web UI: ${list}. Ask the user to resolve ${plural(c.length, 'it', 'them')}.`,
    )
  }
  const mismatch = mcpUrlMismatch(ctx)
  if (mismatch) lines.push(`Spoor: warning: ${mismatch}. Tell the user before using the spoor tools.`)
  const drafts = newDrafts(ctx, state)
  if (drafts.length > 0) {
    const list = drafts
      .map(
        ([, d]) =>
          `${d.path}${d.adr ? ` (${d.adr})` : ''}${d.fallback ? ' [fallback template: needs writing]' : ''}`,
      )
      .join(', ')
    lines.push(
      `Spoor: ${drafts.length} ADR ${plural(drafts.length, 'draft was', 'drafts were')} written from recorded decisions and ${plural(drafts.length, 'waits', 'wait')} for a human to accept (status: proposed): ${list}. Tell the user.`,
    )
  }
  const o = orphans(ctx, state)
  if (o.length > 0) {
    const list = o.map((x) => `${x.base.path} (${x.base.handle ?? x.id})`).join(', ')
    lines.push(
      `Spoor: ${o.length} mirrored ${plural(o.length, 'file was', 'files were')} deleted or renamed: ${list}. Ask the user to retire ${plural(o.length, 'it', 'them')} in the web UI.`,
    )
  }
  return lines
}

function sessionNotice(
  ctx: Ctx,
  kind: 'unreachable' | 'rejected' | 'not_configured' | 'error',
  detail?: string,
): string {
  switch (kind) {
    case 'unreachable':
      return 'Spoor: server unreachable, memory not loaded this session.'
    case 'rejected':
      return `Spoor: token rejected by ${ctx.server ?? 'the server'} (401), memory not loaded this session. Ask the user to run spoor login.`
    case 'not_configured':
      return 'Spoor: not configured for this repo, memory not loaded this session. Ask the user to run spoor login.'
    case 'error':
      return `Spoor: the server answered ${detail ?? 'an error'}, memory not loaded this session.`
  }
}

/** Section 5.1. Returns what goes to stdout (plain text). */
export async function sessionStart(ctx: Ctx, input: HookInput, deadline: Deadline): Promise<string> {
  const source = str(input.source) ?? 'startup'
  if (ctx.optedOut) {
    if (!oncePerDay(ctx.root, 'opt-out', ctx.rt.now())) return ''
    const url = installUrl(ctx)
    return url
      ? `Spoor memory is set up for this repo but not for you; see ${url}\n`
      : 'Spoor memory is set up for this repo but not for you; run spoor login.\n'
  }
  if (source === 'resume' || source === 'fork') return ''

  // 3. session marker
  const key = sessionKey(str(input.session_id))
  sweepOldMarkers(ctx)
  if (key) {
    const exists = readMarker(ctx, key) !== undefined
    if (!(source === 'compact' && exists)) {
      try {
        mkdirSync(sessionDir(ctx), { recursive: true })
        const marker: Marker = {
          started_at: new Date(ctx.rt.now()).toISOString(),
          head: await gitHead(ctx.root, deadline.cap(1000)),
          source,
        }
        writeAtomic(join(sessionDir(ctx), `${key}.json`), jsonText(marker))
      } catch (e) {
        logRun(ctx.root, `session-start: marker not written (${(e as Error).message})`, ctx.rt.now())
      }
    }
  }

  const problem = authProblem(ctx)
  let main: string
  let answered = false
  if (problem) {
    logRun(ctx.root, problem, ctx.rt.now())
    main = sessionNotice(ctx, 'not_configured')
  } else if (offlineUntil({ repoRoot: ctx.root, now: ctx.rt.now })) {
    main = sessionNotice(ctx, 'unreachable')
  } else {
    // 4. anchors from git
    const files = await gitAnchors(ctx.root, ctx.repo.context.max_files, deadline.cap(2000), ctx.rt.now)
    // 5. digest
    const client = clientFor(ctx, { breaker: 'check' })
    const r = await api<unknown>(client, 'GET', projectPath(ctx, `/api/context${contextQuery({ files })}`), {
      timeoutMs: deadline.cap(4000),
    })
    if (r.kind === 'ok') {
      answered = true
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body)
      main = text.endsWith('\n') ? text.slice(0, -1) : text
      // 6. queue replay and mirror sweep in the time left (marked automatic: not the agent's own recording)
      const auto = clientFor(ctx, { breaker: 'check', auto: true })
      try {
        if (!deadline.expired(1000)) await replayPending(ctx, auto, deadline)
        if (!deadline.expired(1000)) await sweepMirror(ctx, auto, deadline)
      } catch (e) {
        logRun(ctx.root, `session-start: sweep failed (${(e as Error).message})`, ctx.rt.now())
      }
    } else if (r.kind === 'unauthorized') main = sessionNotice(ctx, 'rejected')
    else if (r.kind === 'error') main = sessionNotice(ctx, 'error', `${r.status} ${r.code}`)
    else main = sessionNotice(ctx, 'unreachable')
    if (!answered) logRun(ctx.root, main, ctx.rt.now())
  }
  const status = statusLines(ctx)
  const announced = newDrafts(ctx, readState(ctx.root)).map(([h]) => h)
  if (announced.length > 0)
    await updateState(ctx.root, (s) => {
      for (const h of announced) {
        const d = s.drafted[h]
        if (d) d.announced = true
      }
    })
  const out = [...status, main].join('\n')
  return cutOutput(`${out}\n`)
}

/** Files changed in this session (section 5.2 step 2.1): mirrored files and noise excluded. */
export async function sessionChangedFiles(
  ctx: Ctx,
  sessionId: string | undefined,
  timeoutMs = 2000,
): Promise<string[]> {
  const key = sessionKey(sessionId)
  const marker = key ? readMarker(ctx, key) : undefined
  const startedMs = marker ? Date.parse(marker.started_at) : ctx.rt.now() - NO_MARKER_WINDOW_MS
  const out = new Set<string>()
  const keep = (p: string) => !isNoisePath(p) && classify(ctx, p) === undefined
  for (const p of await gitStatusPaths(ctx.root, timeoutMs)) {
    if (!keep(p)) continue
    const m = mtimeMs(join(ctx.root, p))
    if (m !== undefined && m > startedMs) out.add(p)
  }
  if (marker?.head) {
    const head = await gitHead(ctx.root, 1000)
    if (head && head !== marker.head)
      for (const p of await gitDiffNames(ctx.root, `${marker.head}..HEAD`, timeoutMs)) if (keep(p)) out.add(p)
  }
  return [...out]
}

export function nagReason(changed: string[]): string {
  const shown = changed.slice(0, 2)
  const more = changed.length - shown.length
  const list = more > 0 ? `${shown.join(', ')}, +${more} more` : shown.join(', ')
  return `Spoor: this session changed files (${list}) but nothing was recorded in Spoor. If you made or confirmed a lasting decision, call spoor_decide; for durable facts call spoor_remember. If there is nothing worth recording, say so in one sentence and stop. This reminder appears once per session.`
}

/** Section 5.2. Returns stdout: the block JSON, or empty. */
/** The token was a read-only (viewer) token at login: it cannot record anything, so no nag and no drafting. */
export function readOnlyLogin(ctx: Ctx): boolean {
  const login = readState(ctx.root).login
  return login?.role === 'viewer' && !!ctx.token && ctx.token.startsWith(login.prefix)
}

export async function stop(ctx: Ctx, input: HookInput, deadline: Deadline): Promise<string> {
  if (ctx.optedOut || authProblem(ctx) || readOnlyLogin(ctx)) return ''
  const sid = str(input.session_id)
  const key = sessionKey(sid)
  const breakerOpen = offlineUntil({ repoRoot: ctx.root, now: ctx.rt.now }) > 0
  const nagged = key ? existsSync(join(sessionDir(ctx), `${key}.nagged`)) : true
  if (input.stop_hook_active !== true && !breakerOpen && !nagged && key) {
    const changed = await sessionChangedFiles(ctx, sid, deadline.cap(2000))
    if (changed.length > 0) {
      const marker = readMarker(ctx, key)
      const since = marker?.started_at ?? new Date(ctx.rt.now() - NO_MARKER_WINDOW_MS).toISOString()
      const r = await api<{ writes?: number }>(
        clientFor(ctx, { breaker: 'check' }),
        'GET',
        projectPath(ctx, `/api/activity?since=${encodeURIComponent(since)}`),
        { timeoutMs: deadline.cap(3000) },
      )
      if (r.kind === 'ok' && typeof r.body?.writes === 'number' && r.body.writes === 0) {
        try {
          mkdirSync(sessionDir(ctx), { recursive: true })
          writeAtomic(join(sessionDir(ctx), `${key}.nagged`), new Date(ctx.rt.now()).toISOString())
        } catch {
          return '' // without the marker a nag could repeat: stay silent instead
        }
        return `${JSON.stringify({ decision: 'block', reason: nagReason(changed) })}\n`
      }
    }
  }
  maybeSpawnDraft(ctx, sid)
  return ''
}

/** Section 5.2 step 3: start `spoor adr draft` detached when drafting is enabled and nobody holds the lock. */
export function maybeSpawnDraft(ctx: Ctx, sid: string | undefined): boolean {
  const d = ctx.repo.draft
  if (!d.enabled) return false
  if (ctx.rt.env.CI && !d.in_ci) return false
  if (offlineUntil({ repoRoot: ctx.root, now: ctx.rt.now })) return false
  if (lockHolder(join(spoorDir(ctx.root), 'draft.lock')) !== undefined) return false
  const args = ['adr', 'draft', '--background']
  if (sid) args.push('--session', sid)
  try {
    ctx.rt.spawnDetached(args, { cwd: ctx.root, env: ctx.rt.env })
    return true
  } catch (e) {
    logRun(ctx.root, `stop: drafting not started (${(e as Error).message})`, ctx.rt.now())
    return false
  }
}

export function conflictContext(handle: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `Spoor: ${handle} was edited in the Spoor web UI after the last push, so this file change was NOT pushed. Tell the user that the file and Spoor now differ and that they need to resolve it themselves; do not try to resolve it.`,
    },
  })
}

export function renumberContext(from: number, to: number, path: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `Spoor: ADR number ${padAdr(from)} was already taken; the file was renamed to ${path} (adr: ${to}). Use the new path from now on.`,
    },
  })
}

/** Section 5.3. Returns stdout (empty unless a conflict or a renumber needs the agent's attention). */
export async function postToolUse(ctx: Ctx, input: HookInput, deadline: Deadline): Promise<string> {
  const tool = str(input.tool_name)
  if (tool !== 'Write' && tool !== 'Edit') return ''
  const ti = (input.tool_input ?? {}) as Record<string, unknown>
  const tr = (input.tool_response ?? {}) as Record<string, unknown>
  const filePath = str(ti.file_path) ?? str(tr.filePath)
  if (!filePath) return ''
  const rel = repoRelative(ctx.root, filePath, str(input.cwd) ?? ctx.root)
  if (!rel) return ''
  const kind = classify(ctx, rel)
  if (!kind) return ''
  if (ctx.optedOut || authProblem(ctx)) return ''
  if (offlineUntil({ repoRoot: ctx.root, now: ctx.rt.now })) {
    await updateState(ctx.root, (s) => addPending(s, kind, rel, ctx.rt.now()))
    return ''
  }
  const client = clientFor(ctx, { breaker: 'check' })
  const out = await pushFile(ctx, client, kind, rel, { timeoutMs: deadline.cap(PUSH_TIMEOUT_MS) })
  switch (out.kind) {
    case 'conflict':
      return `${conflictContext(out.handle)}\n`
    case 'pushed': {
      for (const n of out.notes) logRun(ctx.root, `post-tool-use: ${n}`, ctx.rt.now())
      if (!deadline.expired(1500))
        await replayPending(ctx, clientFor(ctx, { breaker: 'check', auto: true }), deadline)
      if (out.renumbered) return `${renumberContext(out.renumbered.from, out.renumbered.to, out.path)}\n`
      return ''
    }
    case 'error':
      logRun(
        ctx.root,
        `post-tool-use: ${rel}: ${out.code}${out.message ? `: ${out.message}` : ''}`,
        ctx.rt.now(),
      )
      return ''
    case 'unauthorized':
      logRun(ctx.root, `spoor: token rejected by ${ctx.server ?? ''} (401). Run: spoor login`, ctx.rt.now())
      return ''
    default:
      return ''
  }
}
