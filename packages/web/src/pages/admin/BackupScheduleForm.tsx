/**
 * Schedule and retention of automatic backups (ADR-0040): the enable switch, the UTC time, 1 to 3 tier rows
 * (every + keep) and the per-project archives option, with a "keeps up to N backups" preview. Saving sends the
 * whole settings object (`PUT /backups/settings`); the validation mirrors the shared schema.
 */
import { backupSettingsSchema, maxKeptAutoBackups } from '@spoor/shared'
import { type FormEvent, useRef, useState } from 'react'
import { isApiError } from '../../api/client'
import { usePutBackupSettings } from '../../api/hooks'
import {
  BACKUP_TIER_EVERY,
  BACKUP_TIER_KEEP_MAX,
  BACKUP_TIERS_MAX,
  type BackupSettings,
  type BackupTierEvery,
} from '../../api/types'
import { Alert, Button, Checkbox, Input, issuesByField, Select, useToast } from '../../ui'

const EVERY_LABELS: Record<BackupTierEvery, string> = {
  '24h': 'Every day (24 h)',
  '48h': 'Every 2 days (48 h)',
  '7d': 'Every week (7 d)',
}

interface TierRow {
  /** Local key only, so a changed interval does not remount the row. */
  id: number
  every: BackupTierEvery
  keep: string
}

export function BackupScheduleForm({ settings }: { settings: BackupSettings }) {
  // a saved value remounts the form with the server's answer (the parent keys it on the settings)
  const [enabled, setEnabled] = useState(settings.enabled)
  const [time, setTime] = useState(settings.time_utc)
  const nextId = useRef(settings.tiers.length)
  const [rows, setRows] = useState<TierRow[]>(() =>
    settings.tiers.map((t, id) => ({ id, every: t.every, keep: String(t.keep) })),
  )
  const [archives, setArchives] = useState(settings.project_archives)
  const save = usePutBackupSettings()
  const toast = useToast()

  const candidate = {
    enabled,
    time_utc: time,
    tiers: rows.map((r) => ({ every: r.every, keep: r.keep === '' ? Number.NaN : Number(r.keep) })),
    project_archives: archives,
  }
  const parsed = backupSettingsSchema.safeParse(candidate)
  const problems = issuesByField(
    parsed.success ? [] : parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  )
  const serverIssues = isApiError(save.error) ? issuesByField(save.error.issues) : {}
  const fieldError = (path: string) => problems[path] ?? serverIssues[path]
  const kept = parsed.success ? maxKeptAutoBackups(parsed.data.tiers) : null

  const setRow = (i: number, patch: Partial<TierRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const unused = BACKUP_TIER_EVERY.find((e) => !rows.some((r) => r.every === e))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!parsed.success) return
    save.mutate(parsed.data, { onSuccess: () => toast.success('Backup schedule saved.') })
  }

  return (
    <form onSubmit={submit} aria-label="Backup schedule" className="space-y-4">
      <Checkbox
        role="switch"
        label="Back up automatically"
        hint="Off until you turn it on. Manual backups are always possible."
        checked={enabled}
        onChange={(e) => setEnabled(e.target.checked)}
      />
      <Input
        label="Time (UTC)"
        type="time"
        value={time}
        onChange={(e) => setTime(e.target.value)}
        error={fieldError('time_utc')}
        hint="The first run after this time each day; checked every 15 minutes."
        className="max-w-40"
      />
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Retention</legend>
        <p className="text-xs text-muted">
          Per tier, the newest scheduled backup of each day, 2-day period or week is kept, for that many
          periods.
        </p>
        {rows.map((r, i) => (
          <div key={r.id} className="flex flex-wrap items-end gap-2">
            <Select
              label={`Tier ${i + 1}: every`}
              value={r.every}
              onChange={(e) => setRow(i, { every: e.target.value as BackupTierEvery })}
              options={BACKUP_TIER_EVERY.map((v) => ({
                value: v,
                label: EVERY_LABELS[v],
                disabled: v !== r.every && rows.some((x) => x.every === v),
              }))}
              error={fieldError(`tiers.${i}.every`)}
            />
            <Input
              label={`Tier ${i + 1}: keep`}
              type="number"
              min={1}
              max={BACKUP_TIER_KEEP_MAX}
              step={1}
              value={r.keep}
              onChange={(e) => setRow(i, { keep: e.target.value })}
              error={fieldError(`tiers.${i}.keep`)}
              className="w-28"
            />
            <Button
              size="sm"
              disabled={rows.length <= 1}
              aria-label={`Remove tier ${i + 1}`}
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </div>
        ))}
        {fieldError('tiers') && <p className="text-xs text-danger">{fieldError('tiers')}</p>}
        <Button
          size="sm"
          disabled={rows.length >= BACKUP_TIERS_MAX || !unused}
          onClick={() =>
            unused && setRows((rs) => [...rs, { id: nextId.current++, every: unused, keep: '1' }])
          }
        >
          Add tier
        </Button>
        <p className="text-sm" aria-live="polite">
          {kept === null
            ? 'Fix the highlighted fields to see the retention.'
            : `Keeps up to ${kept} scheduled backup${kept === 1 ? '' : 's'}, plus every manual one, pinned ones, a recent pre-restore backup and the newest verified one.`}
        </p>
      </fieldset>
      <Checkbox
        label="Include a zip per project"
        hint="Lets you restore or download a single project from a backup. Off: the database dump only."
        checked={archives}
        onChange={(e) => setArchives(e.target.checked)}
      />
      {save.error && (
        <Alert tone="danger" title={save.error.message}>
          {isApiError(save.error) && save.error.hint && <p>{save.error.hint}</p>}
        </Alert>
      )}
      <Button type="submit" variant="primary" disabled={!parsed.success} loading={save.isPending}>
        Save schedule
      </Button>
    </form>
  )
}
