/**
 * `.spoor/import-queue.json` and `.spoor/import.lock`: the persisted progress of `spoor adr import` and
 * `spoor docs import`, so a stopped import resumes where it stopped, and the single-flight lock that keeps two imports
 * (or an import and a hook sweep) in one checkout from overlapping.
 *
 * Only the holder of the import lock writes the queue. A missing, corrupt or wrong-shaped file reads as empty. Losing
 * it is harmless for `pending` and `failed` entries (the next run plans them again from the push bases); losing it
 * with `edges` entries makes those files look imported, so their links are not re-sent: `--all` repairs that.
 */
import { existsSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { IMPORT_LOCK_STALE_MS, IMPORT_QUEUE_TTL_MS } from './backoff.js'
import {
  jsonText,
  lockHolder,
  readJsonObject,
  readText,
  sha256,
  spoorDir,
  tryLock,
  writeAtomic,
} from './fsutil.js'
import type { MirrorKind } from './state.js'

export type QueueStatus = 'pending' | 'edges' | 'done' | 'failed'

export interface QueueEntry {
  status: QueueStatus
  /** Hash of the file on disk after the last applied result (spoor_id write-back and rename included). */
  sha256: string
  attempts: number
  error?: string
  message?: string
}

export interface QueueSection {
  started_at: string
  updated_at: string
  /** Keyed by repo-relative path. */
  entries: Record<string, QueueEntry>
}

export interface ImportQueue {
  version: 1
  adr?: QueueSection
  doc?: QueueSection
}

const KINDS: MirrorKind[] = ['adr', 'doc']
const STATUSES = new Set<string>(['pending', 'edges', 'done', 'failed'])

const queuePath = (root: string) => join(spoorDir(root), 'import-queue.json')
const lockPath = (root: string) => join(spoorDir(root), 'import.lock')

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function readSection(v: unknown): QueueSection | undefined {
  if (!isObj(v) || typeof v.started_at !== 'string' || typeof v.updated_at !== 'string' || !isObj(v.entries))
    return undefined
  const entries: Record<string, QueueEntry> = {}
  for (const [path, e] of Object.entries(v.entries)) {
    if (!isObj(e) || typeof e.status !== 'string' || !STATUSES.has(e.status) || typeof e.sha256 !== 'string')
      continue
    const entry: QueueEntry = {
      status: e.status as QueueStatus,
      sha256: e.sha256,
      attempts: typeof e.attempts === 'number' && Number.isInteger(e.attempts) ? e.attempts : 0,
    }
    if (typeof e.error === 'string') entry.error = e.error
    if (typeof e.message === 'string') entry.message = e.message
    entries[path] = entry
  }
  return { started_at: v.started_at, updated_at: v.updated_at, entries }
}

export function readImportQueue(root: string): ImportQueue {
  let raw: Record<string, unknown>
  try {
    raw = readJsonObject(queuePath(root))
  } catch {
    return { version: 1 }
  }
  const q: ImportQueue = { version: 1 }
  if (raw.version !== 1) return q
  for (const k of KINDS) {
    const s = readSection(raw[k])
    if (s) q[k] = s
  }
  return q
}

/** Write the queue atomically; a section whose entries are all done is left out, an empty queue removes the file. */
export function writeImportQueue(root: string, q: ImportQueue): void {
  const out: ImportQueue = { version: 1 }
  for (const k of KINDS) {
    const s = q[k]
    if (s && Object.values(s.entries).some((e) => e.status !== 'done')) out[k] = s
  }
  if (!out.adr && !out.doc) {
    rmSync(queuePath(root), { force: true })
    return
  }
  writeAtomic(queuePath(root), jsonText(out))
}

/** Failure codes that say nothing about the file itself: the next run sends it again and may succeed. */
const RESUMABLE_ERRORS = new Set(['internal', 'file_moved', 'invalid_response'])

/**
 * A `failed` entry the import cannot finish by running again: refused locally (too large, path too long) or by the
 * server for its content (a per-file 4xx such as invalid frontmatter, a conflict, already drafted), and the file has
 * not changed since. It stops counting as unfinished work until the file changes.
 */
export function isRefused(root: string, path: string, e: QueueEntry): boolean {
  if (e.status !== 'failed' || e.error === undefined || RESUMABLE_ERRORS.has(e.error)) return false
  const text = readText(join(root, path))
  return text !== undefined && sha256(text) === e.sha256
}

/**
 * Imports with work a re-run can finish (`pending`, `edges`, a resumable failure): what `spoor status` and the
 * SessionStart status lines report. Refused files are not counted, so the nag stops when only they are left.
 */
export function unfinishedImports(root: string): { kind: MirrorKind; remaining: number; total: number }[] {
  const q = readImportQueue(root)
  const out: { kind: MirrorKind; remaining: number; total: number }[] = []
  for (const kind of KINDS) {
    const s = q[kind]
    if (!s) continue
    const all = Object.entries(s.entries)
    const remaining = all.filter(([p, e]) => e.status !== 'done' && !isRefused(root, p, e)).length
    if (remaining > 0) out.push({ kind, remaining, total: all.length })
  }
  return out
}

/**
 * Paths of an unfinished import that the SessionStart sweep leaves to the import (it resumes them with
 * `reserve_above`). A section not updated for 7 days is ignored here, so its files are pushed one by one again.
 */
export function unfinishedImportPaths(root: string, now: number): Set<string> {
  const q = readImportQueue(root)
  const out = new Set<string>()
  for (const kind of KINDS) {
    const s = q[kind]
    if (!s) continue
    const updated = Date.parse(s.updated_at)
    if (!Number.isFinite(updated) || now - updated > IMPORT_QUEUE_TTL_MS) continue
    for (const [path, e] of Object.entries(s.entries)) if (e.status !== 'done') out.add(path)
  }
  return out
}

export interface ImportLock {
  /** Refresh the lock's mtime; false when another process has taken it over (or it was removed). */
  touch(now: number): boolean
  release(): void
}

/** The lock is refreshed this often while it is held, also during a long request or a long backoff wait. */
export const IMPORT_LOCK_HEARTBEAT_MS = 60_000

/**
 * Take `.spoor/import.lock`; `{ heldBy }` when another live import holds it. While held, a timer refreshes the lock
 * every minute, so it never looks stale (10 minutes) during a slow request plus its retry wait.
 */
export function acquireImportLock(
  root: string,
  now: number,
  clock: () => number = Date.now,
): ImportLock | { heldBy?: number } {
  const path = lockPath(root)
  const unlock = tryLock(path, IMPORT_LOCK_STALE_MS, now)
  if (!unlock) {
    const heldBy = lockHolder(path)
    return heldBy === undefined ? {} : { heldBy }
  }
  const touch = (t: number) => {
    if (readText(path)?.trim() !== String(process.pid)) return false
    try {
      utimesSync(path, t / 1000, t / 1000)
      return true
    } catch {
      return false
    }
  }
  const heartbeat = setInterval(() => {
    if (!touch(clock())) clearInterval(heartbeat)
  }, IMPORT_LOCK_HEARTBEAT_MS)
  heartbeat.unref()
  return {
    touch,
    release() {
      clearInterval(heartbeat)
      unlock()
    },
  }
}

export const isImportLock = (l: ImportLock | { heldBy?: number }): l is ImportLock => 'touch' in l

/** An import runs in this checkout: the lock exists, its pid is alive and it was touched in the last 10 minutes. */
export function importRunning(root: string, now: number): boolean {
  const path = lockPath(root)
  if (!existsSync(path) || lockHolder(path) === undefined) return false
  try {
    return now - statSync(path).mtimeMs <= IMPORT_LOCK_STALE_MS
  } catch {
    return false
  }
}
