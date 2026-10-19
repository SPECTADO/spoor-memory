/** Small file helpers: atomic writes, strict JSON reads, `.spoor/` paths, the run log and lock files. */
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export const spoorDir = (root: string) => join(root, '.spoor')

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Write through a temp file in the same directory and rename (atomic on POSIX). */
export function writeAtomic(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, content, mode === undefined ? undefined : { mode })
    renameSync(tmp, path)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      // nothing to clean
    }
    throw e
  }
}

export class InvalidJsonFile extends Error {
  constructor(readonly path: string) {
    super(`${path} is not valid JSON; fix or remove it, nothing was written`)
  }
}

/** A missing file is `{}`; invalid JSON or a non-object throws InvalidJsonFile. */
export function readJsonObject(path: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  if (text.trim() === '') return {}
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    throw new InvalidJsonFile(path)
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new InvalidJsonFile(path)
  return v as Record<string, unknown>
}

export const jsonText = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`

export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

const LOG_MAX_LINES = 200

/** Append notices to `.spoor/last-run.log`, keeping the last 200 lines. Never throws. */
export function logRun(root: string, line: string, now: number = Date.now()): void {
  try {
    const path = join(spoorDir(root), 'last-run.log')
    const stamp = new Date(now).toISOString()
    const lines = (readText(path) ?? '').split('\n').filter((l) => l !== '')
    for (const l of line.split('\n')) if (l.trim() !== '') lines.push(`${stamp} ${l}`)
    writeAtomic(path, `${lines.slice(-LOG_MAX_LINES).join('\n')}\n`)
  } catch {
    // logging must never break a hook
  }
}

/** True once per local day per `kind` (marker `.spoor/notice-day`). */
export function oncePerDay(root: string, kind: string, now: number): boolean {
  const path = join(spoorDir(root), 'notice-day')
  const d = new Date(now)
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  let marks: Record<string, unknown> = {}
  try {
    marks = readJsonObject(path)
  } catch {
    marks = {}
  }
  if (marks[kind] === day) return false
  marks[kind] = day
  try {
    writeAtomic(path, jsonText(marks))
  } catch {
    // read-only checkout: show the notice anyway
  }
  return true
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Pid written in a lock file, when that process is still alive. */
export function lockHolder(path: string): number | undefined {
  const text = readText(path)
  if (text === undefined) return undefined
  const pid = Number(text.trim())
  return pidAlive(pid) ? pid : undefined
}

/**
 * Take a pid lock file (`.spoor/draft.lock`, `.spoor/state.lock`). A lock whose process is gone, or which
 * is older than `staleMs`, is taken over. Returns a release function, or undefined when it is held.
 */
export function tryLock(
  path: string,
  staleMs = 10 * 60 * 1000,
  now: number = Date.now(),
): (() => void) | undefined {
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => {
        try {
          if (readText(path)?.trim() === String(process.pid)) rmSync(path, { force: true })
        } catch {
          // already gone
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const pidText = readText(path)?.trim() ?? ''
      let age = 0
      try {
        age = now - statSync(path).mtimeMs
      } catch {
        continue // vanished meanwhile: retry
      }
      const stale = pidText === '' ? age > 5000 : !pidAlive(Number(pidText)) || age > staleMs
      if (!stale) return undefined
      try {
        rmSync(path, { force: true })
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

export function fileExists(path: string): boolean {
  return existsSync(path)
}
