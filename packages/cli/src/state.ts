/**
 * `.spoor/state.json` (cli-and-hooks.md section 2): push bases, drafted memories, the retry queue and open push
 * conflicts. Written atomically under `.spoor/state.lock`. Losing it is harmless (the server matches by
 * `spoor_id` / `source_path`), so a corrupt file reads as empty.
 */
import { join } from 'node:path'
import { jsonText, readJsonObject, spoorDir, tryLock, writeAtomic } from './fsutil.js'

export type MirrorKind = 'adr' | 'doc'

export interface Base {
  path: string
  revision: number
  sha256: string
  /** Not in the design's minimal shape: kept so orphans and conflicts can name the item. */
  handle?: string
  kind?: MirrorKind
}

export interface Drafted {
  path: string
  pushed: boolean
  adr?: string
  /** The drafting command failed and the file holds the fallback template (it needs writing by a human). */
  fallback?: boolean
  /** A SessionStart status line already told the agent about this draft. */
  announced?: boolean
}

export interface Pending {
  kind: MirrorKind
  path: string
  since: string
}

export interface Conflict {
  path: string
  handle: string
  since: string
  edited_by: string | null
  /** Hash of the refused content: the sweep does not push the same bytes again. */
  sha256?: string
}

export interface State {
  version: 1
  bases: Record<string, Base>
  drafted: Record<string, Drafted>
  pending: Pending[]
  conflicts: Conflict[]
  /** Token bookkeeping written by `spoor login` (prefix and expiry, never the token). */
  login?: {
    prefix: string
    expires_at: string | null
    at: string
    /** whoami said the token never expires (expires_at null). */
    no_expiry?: boolean
    /** The token's effective role at login (viewer tokens get no Stop nag and no drafting). */
    role?: string
  }
}

export const emptyState = (): State => ({ version: 1, bases: {}, drafted: {}, pending: [], conflicts: [] })

const statePath = (root: string) => join(spoorDir(root), 'state.json')

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export function readState(root: string): State {
  let raw: Record<string, unknown>
  try {
    raw = readJsonObject(statePath(root))
  } catch {
    return emptyState()
  }
  const s = emptyState()
  if (isObj(raw.bases)) {
    for (const [id, b] of Object.entries(raw.bases)) {
      if (
        isObj(b) &&
        typeof b.path === 'string' &&
        typeof b.revision === 'number' &&
        typeof b.sha256 === 'string'
      )
        s.bases[id] = b as unknown as Base
    }
  }
  if (isObj(raw.drafted)) {
    for (const [h, d] of Object.entries(raw.drafted)) {
      if (isObj(d) && typeof d.path === 'string')
        s.drafted[h] = { ...(d as object), pushed: d.pushed === true } as Drafted
    }
  }
  if (Array.isArray(raw.pending))
    s.pending = raw.pending.filter(
      (p): p is Pending => isObj(p) && typeof p.path === 'string' && (p.kind === 'adr' || p.kind === 'doc'),
    )
  if (Array.isArray(raw.conflicts))
    s.conflicts = raw.conflicts.filter((c): c is Conflict => isObj(c) && typeof c.path === 'string')
  if (isObj(raw.login) && typeof raw.login.prefix === 'string') s.login = raw.login as State['login']
  return s
}

/**
 * Read-modify-write under the state lock. If the lock cannot be taken within ~1 s the update still runs
 * (a hook must not stall); the atomic rename keeps the file valid either way.
 */
export async function updateState<T>(
  root: string,
  fn: (s: State) => T,
  sleep?: (ms: number) => Promise<void>,
): Promise<T> {
  const lockPath = join(spoorDir(root), 'state.lock')
  let release: (() => void) | undefined
  const wait = sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let i = 0; i < 20; i++) {
    try {
      release = tryLock(lockPath, 30_000)
    } catch {
      release = undefined
      break
    }
    if (release) break
    await wait(50)
  }
  try {
    const s = readState(root)
    const out = fn(s)
    writeAtomic(statePath(root), jsonText(s))
    return out
  } finally {
    release?.()
  }
}

export function baseFor(s: State, spoorId: string | undefined, path: string): [string, Base] | undefined {
  if (spoorId && s.bases[spoorId]) return [spoorId, s.bases[spoorId]]
  for (const [id, b] of Object.entries(s.bases)) if (b.path === path) return [id, b]
  return undefined
}

export function addPending(s: State, kind: MirrorKind, path: string, now: number): void {
  if (s.pending.some((p) => p.path === path)) return
  s.pending.push({ kind, path, since: new Date(now).toISOString() })
}
