/**
 * Startup step 6 (deployment.md section 4): on an empty `users` table create the instance admin from
 * SPOOR_ADMIN_EMAIL / SPOOR_ADMIN_PASSWORD (or _FILE) / SPOOR_ADMIN_NAME. Missing or invalid values are a
 * StartupError (the process exits 1 with the message). Once any user exists the variables are ignored.
 */
import { emailSchema, nameSchema, passwordSchema } from '@spoor/shared'
import { sql } from 'drizzle-orm'
import type { Config } from '../../config.js'
import { StartupError } from '../../db/migrate.js'
import { users } from '../../db/schema.js'
import { systemActor, writeAudit } from '../../lib/audit.js'
import { type Db, withTx } from '../../lib/db.js'
import { hashPassword } from './passwords.js'

type AdminEnv = Pick<Config, 'SPOOR_ADMIN_EMAIL' | 'SPOOR_ADMIN_PASSWORD' | 'SPOOR_ADMIN_NAME'>

export type BootstrapResult = { created: false } | { created: true; userId: string; email: string }

export async function bootstrapAdmin(db: Db, config: AdminEnv): Promise<BootstrapResult> {
  return withTx(db, async (tx) => {
    // two containers starting together: only one may see the table empty
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('spoor-bootstrap-admin'))`)
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(users)
    if ((row?.n ?? 0) > 0) return { created: false }

    const missing = [
      config.SPOOR_ADMIN_EMAIL ? null : 'SPOOR_ADMIN_EMAIL',
      config.SPOOR_ADMIN_PASSWORD ? null : 'SPOOR_ADMIN_PASSWORD (or SPOOR_ADMIN_PASSWORD_FILE)',
    ].filter((x) => x !== null)
    if (missing.length > 0) {
      throw new StartupError(
        `the database has no users yet: set ${missing.join(' and ')} to create the bootstrap instance admin`,
      )
    }
    const email = emailSchema.safeParse(config.SPOOR_ADMIN_EMAIL)
    const password = passwordSchema.safeParse(config.SPOOR_ADMIN_PASSWORD)
    const name = nameSchema.safeParse(config.SPOOR_ADMIN_NAME)
    if (!email.success) throw new StartupError('SPOOR_ADMIN_EMAIL is not a valid email address')
    if (!password.success)
      throw new StartupError('SPOOR_ADMIN_PASSWORD must be 12 to 256 characters (after NFKC)')
    if (!name.success) throw new StartupError('SPOOR_ADMIN_NAME must be 1 to 100 printable characters')

    const [user] = await tx
      .insert(users)
      .values({
        email: email.data,
        name: name.data,
        passwordHash: await hashPassword(password.data),
        isAdmin: true,
      })
      .returning({ id: users.id, email: users.email })
    const created = user as { id: string; email: string }
    await writeAudit(tx, systemActor, {
      action: 'user.create',
      summary: `bootstrap instance admin ${created.email} created`,
      data: { user_id: created.id, is_admin: true, bootstrap: true },
    })
    return { created: true, userId: created.id, email: created.email }
  })
}
