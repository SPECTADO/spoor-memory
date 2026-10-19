/**
 * Cursor pagination (api.md section 0.5): `?limit=` (default 50, max 200) and an opaque `?cursor=`, the
 * sort key of the last row returned. Sorts must tie-break on id so cursors never skip or repeat.
 */
import { type AnyColumn, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ApiError } from './errors.js'

export const DEFAULT_LIMIT = 50
export const MAX_LIMIT = 200

export const paginationQuery = {
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().max(1000).optional(),
}

export type CursorValue = string | number | null

export function encodeCursor(values: CursorValue[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url')
}

/** Decode a cursor of exactly `arity` JSON values; a malformed one is 400 `invalid_input`. Callers use `decodeTypedCursor`. */
export function decodeCursor(cursor: string, arity: number): CursorValue[] {
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      Array.isArray(v) &&
      v.length === arity &&
      v.every((x) => x === null || typeof x === 'string' || typeof x === 'number')
    ) {
      return v as CursorValue[]
    }
  } catch {
    // fall through
  }
  throw new ApiError('invalid_input', {
    message: 'Invalid cursor.',
    details: { issues: [{ path: 'cursor', message: 'invalid cursor' }] },
  })
}

export type CursorPart = 'timestamp' | 'uuid' | 'int' | 'string'

const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/
const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INT4_MAX = 2_147_483_647

function partOk(kind: CursorPart, v: CursorValue): boolean {
  switch (kind) {
    case 'timestamp': {
      // the `cursorTimestamp` form; the round trip rejects impossible dates (month 13, Feb 30) the SQL cast would
      if (typeof v !== 'string' || !CURSOR_TS_RE.test(v)) return false
      const d = new Date(`${v.slice(0, 23)}Z`)
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 19) === v.slice(0, 19)
    }
    case 'uuid':
      return typeof v === 'string' && CURSOR_UUID_RE.test(v)
    case 'int':
      return typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= INT4_MAX
    case 'string':
      return typeof v === 'string'
  }
}

/**
 * Decode a cursor whose parts have the given kinds, each checked before it reaches a SQL cast or compare,
 * so a well-encoded but malformed cursor is 400 `invalid_input`, never a 500 from Postgres (api.md 0.5).
 * Every list endpoint decodes through this.
 */
export function decodeTypedCursor<K extends readonly CursorPart[]>(
  cursor: string,
  kinds: K,
): { -readonly [I in keyof K]: K[I] extends 'int' ? number : string } {
  const parts = decodeCursor(cursor, kinds.length)
  if (!kinds.every((k, i) => partOk(k, parts[i] as CursorValue))) {
    throw new ApiError('invalid_input', {
      message: 'Invalid cursor.',
      details: { issues: [{ path: 'cursor', message: 'invalid cursor' }] },
    })
  }
  return parts as { -readonly [I in keyof K]: K[I] extends 'int' ? number : string }
}

/**
 * Callers fetch `limit + 1` rows; this trims to `limit` and builds `next_cursor` from the last kept row.
 */
export function page<R, J>(
  rows: R[],
  limit: number,
  keyOf: (row: R) => CursorValue[],
  toJson: (row: R) => J,
): { items: J[]; next_cursor: string | null } {
  const more = rows.length > limit
  const kept = more ? rows.slice(0, limit) : rows
  const last = kept[kept.length - 1]
  return {
    items: kept.map(toJson),
    next_cursor: more && last !== undefined ? encodeCursor(keyOf(last)) : null,
  }
}

/**
 * A timestamptz as UTC text with full microsecond precision, for cursors. JS Dates keep only
 * milliseconds, and a cursor built from one would skip rows that share the millisecond.
 * Compare with `(col, id) < (${at}::timestamptz, ${id}::uuid)`.
 */
export function cursorTimestamp(col: AnyColumn): SQL<string> {
  return sql<string>`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}
