/**
 * Checks on values that come from the server before they reach the file system or a repo file (review-log-phase5
 * S1-S3). The server is trusted for content, not for paths: a compromised server, or anyone in the middle of a
 * plain-http connection, must not be able to write outside the repo or inject frontmatter lines.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parseHandle } from '@spoor/shared'

const SPOOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A Spoor item id: a uuid, nothing else (it is written into frontmatter and used as a state key). */
export const isSpoorId = (v: unknown): v is string => typeof v === 'string' && SPOOR_ID_RE.test(v)

/** ADR numbers the server may hand out (data-model.md section 7: at most five digits). */
export const isAdrNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 99_999

/** `rel` is a relative path that stays strictly inside `root` (lexically: no `..` escape, no absolute path). */
export function insideRoot(root: string, rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || isAbsolute(rel)) return false
  const r = relative(resolve(root), resolve(root, rel))
  return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)
}

/** `renumbered` of a push or import result: two valid ADR numbers, else undefined. */
export function validRenumber(v: unknown): { from: number; to: number } | undefined {
  if (!v || typeof v !== 'object') return undefined
  const { from, to } = v as { from?: unknown; to?: unknown }
  return isAdrNumber(from) && isAdrNumber(to) ? { from, to } : undefined
}

const STATUSES = new Set(['created', 'updated', 'unchanged'])

/**
 * Why a push or import result cannot be applied, or undefined when it can: the fields the CLI writes into files or
 * `state.json` (`spoor_id`, `handle`, `revision`, `renumbered`) must have their documented shape (api.md section 7.2).
 */
export function pushResultProblem(r: unknown): string | undefined {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'not an object'
  const o = r as Record<string, unknown>
  if (typeof o.status !== 'string' || !STATUSES.has(o.status)) return 'invalid status'
  if (!isSpoorId(o.spoor_id)) return 'spoor_id is not a uuid'
  if (typeof o.handle !== 'string' || parseHandle(o.handle) === null) return 'invalid handle'
  if (typeof o.revision !== 'number' || !Number.isInteger(o.revision) || o.revision < 1)
    return 'invalid revision'
  if (o.renumbered !== null && o.renumbered !== undefined && !validRenumber(o.renumbered))
    return 'invalid renumbered'
  return undefined
}
