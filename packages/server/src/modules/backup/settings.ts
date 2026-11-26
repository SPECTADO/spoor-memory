/**
 * `instance_settings` key `backup` (ADR-0040). Read leniently (`resolveBackupSettings`: a bad or older row falls
 * back to the defaults field by field), written whole. A full restore writes the live value back afterwards
 * (the restore must not turn the schedule off or on), so the restore code uses these two functions too.
 */
import { type BackupSettings, resolveBackupSettings } from '@spoor/shared'
import { eq } from 'drizzle-orm'
import { instanceSettings } from '../../db/schema.js'
import type { DbOrTx } from '../../lib/db.js'

export const BACKUP_SETTINGS_KEY = 'backup'

export interface StoredBackupSettings {
  settings: BackupSettings
  /** The stored row's value as it is (null = no row); the restore writes exactly this back. */
  raw: Record<string, unknown> | null
  updatedAt: Date | null
}

export async function readBackupSettings(db: DbOrTx): Promise<StoredBackupSettings> {
  const rows = await db
    .select({ value: instanceSettings.value, updatedAt: instanceSettings.updatedAt })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, BACKUP_SETTINGS_KEY))
  const row = rows[0]
  return {
    settings: resolveBackupSettings(row?.value ?? null),
    raw: row?.value ?? null,
    updatedAt: row?.updatedAt ?? null,
  }
}

/** Upsert the row (`updated_by` = the acting user, null for the system). Returns the new `updated_at`. */
export async function writeBackupSettings(
  db: DbOrTx,
  value: BackupSettings | Record<string, unknown>,
  userId: string | null,
): Promise<Date> {
  const now = new Date()
  const v = value as Record<string, unknown>
  await db
    .insert(instanceSettings)
    .values({ key: BACKUP_SETTINGS_KEY, value: v, updatedAt: now, updatedBy: userId })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: v, updatedAt: now, updatedBy: userId },
    })
  return now
}
