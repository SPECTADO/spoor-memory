import { describe, expect, it } from 'vitest'
import {
  backupCadenceHours,
  backupIdFor,
  backupManifestSchema,
  backupSettingsSchema,
  DEFAULT_BACKUP_SETTINGS,
  isBackupId,
  markdownZipFileName,
  maxKeptAutoBackups,
  parseBackupId,
  projectRestoreRequest,
  resolveBackupSettings,
  restoredCopyName,
  restoredCopySlug,
  restorePhrase,
} from './backups.js'

const at = new Date('2026-11-20T03:00:07.123Z')

describe('backup ids', () => {
  it('round-trips the start time (seconds) and the kind', () => {
    const id = backupIdFor(at, 'auto')
    expect(id).toBe('20261120T030007Z-auto')
    expect(parseBackupId(id)).toEqual({ at: new Date('2026-11-20T03:00:07Z'), kind: 'auto' })
    expect(parseBackupId(backupIdFor(at, 'pre-restore'))?.kind).toBe('pre-restore')
  })

  it('rejects traversal, other kinds and impossible dates', () => {
    for (const bad of [
      '../20261120T030007Z-auto',
      '20261120T030007Z-auto/..',
      '20261120T030007Z-other',
      '20261120T030007Z',
      '20261120T030007Z-auto ',
      '',
    ]) {
      expect(isBackupId(bad), bad).toBe(false)
      expect(parseBackupId(bad), bad).toBeNull()
    }
    expect(isBackupId('20261340T030007Z-auto')).toBe(true) // shape only
    expect(parseBackupId('20261340T030007Z-auto')).toBeNull()
    expect(parseBackupId('20261120T250007Z-auto')).toBeNull()
  })
})

describe('backup settings', () => {
  it('defaults: off, 03:00 UTC, 3 x 24h + 2 x 7d, project archives on', () => {
    expect(DEFAULT_BACKUP_SETTINGS).toEqual({
      enabled: false,
      time_utc: '03:00',
      tiers: [
        { every: '24h', keep: 3 },
        { every: '7d', keep: 2 },
      ],
      project_archives: true,
    })
    // the default tiers are a fresh array each time
    const a = backupSettingsSchema.parse({})
    a.tiers.push({ every: '48h', keep: 1 })
    expect(backupSettingsSchema.parse({}).tiers).toHaveLength(2)
  })

  it('validates time, tier count, unique intervals and keep range; rejects unknown fields', () => {
    const ok = (v: unknown) => backupSettingsSchema.safeParse(v).success
    expect(ok({ time_utc: '23:59' })).toBe(true)
    expect(ok({ time_utc: '24:00' })).toBe(false)
    expect(ok({ time_utc: '3:00' })).toBe(false)
    expect(ok({ tiers: [] })).toBe(false)
    expect(
      ok({
        tiers: [
          { every: '24h', keep: 1 },
          { every: '48h', keep: 1 },
          { every: '7d', keep: 1 },
        ],
      }),
    ).toBe(true)
    expect(
      ok({
        tiers: [
          { every: '24h', keep: 1 },
          { every: '24h', keep: 2 },
        ],
      }),
    ).toBe(false)
    expect(ok({ tiers: [{ every: '24h', keep: 0 }] })).toBe(false)
    expect(ok({ tiers: [{ every: '24h', keep: 91 }] })).toBe(false)
    expect(ok({ tiers: [{ every: '12h', keep: 1 }] })).toBe(false)
    expect(ok({ enabled: true, extra: 1 })).toBe(false)
  })

  it('resolves a bad stored value field by field', () => {
    expect(resolveBackupSettings(null)).toEqual(DEFAULT_BACKUP_SETTINGS)
    expect(resolveBackupSettings({ enabled: true, time_utc: 'nope', tiers: 'x' })).toEqual({
      ...DEFAULT_BACKUP_SETTINGS,
      enabled: true,
    })
  })

  it('cadence is the smallest interval; the preview sums keep', () => {
    expect(backupCadenceHours(DEFAULT_BACKUP_SETTINGS.tiers)).toBe(24)
    expect(backupCadenceHours([{ every: '7d', keep: 1 }])).toBe(168)
    expect(
      backupCadenceHours([
        { every: '48h', keep: 2 },
        { every: '7d', keep: 1 },
      ]),
    ).toBe(48)
    expect(maxKeptAutoBackups(DEFAULT_BACKUP_SETTINGS.tiers)).toBe(5)
  })
})

describe('restore helpers', () => {
  it('phrase uses UTC minutes', () => {
    expect(restorePhrase(at)).toBe('RESTORE 2026-11-20 03:00')
  })

  it('copy slug and name fit their limits', () => {
    expect(restoredCopySlug('acme', at)).toBe('acme-r20261120')
    expect(restoredCopySlug('_shared', at)).toBe('shared-r20261120')
    const long = restoredCopySlug(`${'a'.repeat(29)}-bcdefghij`, at)
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/)
    expect(restoredCopyName('Acme', at)).toBe('Acme (restored 2026-11-20)')
    expect(restoredCopyName('x'.repeat(100), at).length).toBe(100)
    expect(markdownZipFileName('acme', at)).toBe('spoor-acme-markdown-20261120.zip')
  })

  it('project restore: new by default; overwrite needs password and the typed slug', () => {
    expect(projectRestoreRequest.parse({})).toEqual({ mode: 'new' })
    expect(projectRestoreRequest.safeParse({ mode: 'overwrite' }).success).toBe(false)
    expect(
      projectRestoreRequest.safeParse({ mode: 'overwrite', password: 'pw', confirm: 'acme' }).success,
    ).toBe(true)
    expect(
      projectRestoreRequest.safeParse({ mode: 'overwrite', password: 'pw', confirm: 'acme', slug: 'x' })
        .success,
    ).toBe(false)
    expect(projectRestoreRequest.safeParse({ slug: 'Bad Slug' }).success).toBe(false)
  })
})

describe('backup.json', () => {
  const manifest = {
    format: 'spoor-backup/1',
    id: '20261120T030007Z-auto',
    kind: 'auto',
    created_at: '2026-11-20T03:00:07.000Z',
    spoor_version: '0.8.0',
    migration: { count: 11, last_tag: '0010_backups' },
    pg_server_version: '17.6',
    pg_dump_version: 'pg_dump (PostgreSQL) 17.6',
    files: [{ path: 'database.dump', size: 10, sha256: 'a'.repeat(64) }],
    projects: [
      {
        id: '7f9c2c1e-8f43-4b41-9d2b-0a6f5e0c1d22',
        slug: 'acme',
        name: 'Acme',
        kind: 'project',
        items: 3,
        archive: 'projects/acme.zip',
        history: true,
      },
      {
        id: '0c9c2c1e-8f43-4b41-9d2b-0a6f5e0c1d22',
        slug: '_shared',
        name: 'Shared',
        kind: 'shared',
        items: 0,
        archive: null,
        history: false,
        skipped_reason: 'busy',
      },
    ],
    pinned: false,
    verified_at: null,
  }

  it('parses, and tolerates unknown fields', () => {
    expect(backupManifestSchema.parse({ ...manifest, future: 1 }).projects).toHaveLength(2)
  })

  it('rejects paths outside the bundle and another format', () => {
    const bad = (files: unknown) => backupManifestSchema.safeParse({ ...manifest, files }).success
    expect(bad([{ path: '../etc/passwd', size: 1, sha256: 'a'.repeat(64) }])).toBe(false)
    expect(bad([{ path: 'projects/../x.zip', size: 1, sha256: 'a'.repeat(64) }])).toBe(false)
    expect(bad([{ path: '/database.dump', size: 1, sha256: 'a'.repeat(64) }])).toBe(false)
    expect(backupManifestSchema.safeParse({ ...manifest, format: 'spoor-backup/2' }).success).toBe(false)
  })
})
