/**
 * DB sessions behind an unsigned random cookie (auth-and-security.md section 3). The DB stores only
 * sha256(cookie value), so a DB leak yields no usable session.
 */

import { cleanLine } from '@spoor/shared'
import { and, eq, gt, ne, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Config } from '../../config.js'
import { sessions, users } from '../../db/schema.js'
import type { AuthUser } from '../../lib/auth-context.js'
import { randomSecret, sha256 } from '../../lib/crypto.js'
import type { DbOrTx } from '../../lib/db.js'

export const SESSION_ABSOLUTE_DAYS = 30
export const SESSION_IDLE_DAYS = 14
export const SESSION_TOUCH_MINUTES = 5
const SID_RE = /^[A-Za-z0-9_-]{43}$/

/** `__Host-spoor_sid` over https, `spoor_sid` on plain http. */
export function sessionCookieName(config: Pick<Config, 'cookieSecure'>): string {
  return config.cookieSecure ? '__Host-spoor_sid' : 'spoor_sid'
}

export function setSessionCookie(c: Context, config: Pick<Config, 'cookieSecure'>, sid: string): void {
  setCookie(c, sessionCookieName(config), sid, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: config.cookieSecure,
    maxAge: SESSION_ABSOLUTE_DAYS * 24 * 3600,
  })
}

export function clearSessionCookie(c: Context, config: Pick<Config, 'cookieSecure'>): void {
  deleteCookie(c, sessionCookieName(config), {
    path: '/',
    secure: config.cookieSecure,
    httpOnly: true,
    sameSite: 'Lax',
  })
}

export function readSessionCookie(c: Context, config: Pick<Config, 'cookieSecure'>): string | undefined {
  const v = getCookie(c, sessionCookieName(config))
  return v !== undefined && SID_RE.test(v) ? v : undefined
}

/** Issue a new session id (never reuse one: no fixation). Returns the cookie value. */
export async function createSession(
  db: DbOrTx,
  userId: string,
  userAgent: string | undefined,
): Promise<string> {
  const sid = randomSecret()
  const ua = userAgent ? cleanLine(userAgent).slice(0, 300) : null
  await db.insert(sessions).values({
    idHash: sha256(sid),
    userId,
    userAgent: ua,
    expiresAt: sql`now() + make_interval(days => ${SESSION_ABSOLUTE_DAYS})`,
  })
  return sid
}

/**
 * The live session's user: absolute expiry, idle expiry and a not-disabled user. `last_seen_at` is
 * written at most every 5 minutes.
 */
export async function loadSession(
  db: DbOrTx,
  sid: string,
): Promise<{ user: AuthUser; idHash: Buffer } | null> {
  const idHash = sha256(sid)
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      isAdmin: users.isAdmin,
      sharedEditor: users.sharedEditor,
      disabledAt: users.disabledAt,
      lastSeenStale: sql<boolean>`${sessions.lastSeenAt} < now() - make_interval(mins => ${SESSION_TOUCH_MINUTES})`,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.idHash, idHash),
        gt(sessions.expiresAt, sql`now()`),
        gt(sessions.lastSeenAt, sql`now() - make_interval(days => ${SESSION_IDLE_DAYS})`),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row || row.disabledAt !== null) return null
  if (row.lastSeenStale) {
    await db.update(sessions).set({ lastSeenAt: sql`now()` }).where(eq(sessions.idHash, idHash))
  }
  const { id, email, name, isAdmin, sharedEditor } = row
  return { user: { id, email, name, isAdmin, sharedEditor }, idHash }
}

export async function deleteSession(db: DbOrTx, idHash: Buffer): Promise<void> {
  await db.delete(sessions).where(eq(sessions.idHash, idHash))
}

/** All of a user's sessions, optionally keeping one (password change keeps the current session). */
export async function deleteUserSessions(db: DbOrTx, userId: string, keep?: Buffer): Promise<void> {
  await db
    .delete(sessions)
    .where(keep ? and(eq(sessions.userId, userId), ne(sessions.idHash, keep)) : eq(sessions.userId, userId))
}
