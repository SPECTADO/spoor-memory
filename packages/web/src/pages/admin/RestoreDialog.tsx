/**
 * Full restore in three steps (ADR-0039, api.md §13.2): 1 summary and warnings from `restore/prepare`, 2 type the
 * phrase and the admin's password, 3 "Restoring…" while `restore-status` is polled every 2 s. The server answers
 * 503 `maintenance` (or nothing at all) for most of step 3: a failed poll is not an error, the last known phase
 * stays on screen and the poll goes on. When the restore reports `done` with the gate off (or the session ends:
 * 401) the admin goes to the login page, because every session ends with a restore. A failure while the gate is
 * still on (`maintenance: true`) happened after the commit: the database may be replaced and Spoor must be
 * restarted; the server's error text is redacted then, so the dialog says so itself.
 */
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { isApiError } from '../../api/client'
import { usePrepareRestore, useRestoreStatus, useStartRestore } from '../../api/hooks'
import type { BackupItemJson, RestorePrepareResponse, RestoreStatusJson } from '../../api/types'
import { dateTime } from '../../lib/format'
import { Alert, Button, Dialog, Input, SkeletonRows } from '../../ui'

const PHASES: Record<NonNullable<RestoreStatusJson['phase']>, string> = {
  pre_restore_backup: 'Making a backup of the current database first',
  maintenance: 'Switching to maintenance mode',
  draining: 'Waiting for running requests to finish',
  restoring: 'Restoring the database',
  startup: 'Starting up again',
  done: 'Done',
}

export interface RestoreDialogProps {
  /** The backup to restore; null = closed. */
  backup: BackupItemJson | null
  onClose: () => void
  /** Where to go once the restore is done; default: the login page (a full page load). */
  onDone?: () => void
  /** Poll interval of `restore-status` in ms (tests); default 2000. */
  pollMs?: number
}

export function RestoreDialog({ backup, onClose, onDone, pollMs }: RestoreDialogProps) {
  // once the restore runs the dialog cannot be dismissed (Esc, X), only closed after a failure
  const [locked, setLocked] = useState(false)
  const close = () => {
    setLocked(false)
    onClose()
  }
  return (
    <Dialog
      open={backup !== null}
      onClose={close}
      title="Restore the whole instance"
      description={backup ? `From the backup of ${dateTime(backup.created_at)} (${backup.kind}).` : undefined}
      size="md"
      dismissible={!locked}
    >
      {backup && (
        <RestoreSteps backup={backup} onClose={close} onDone={onDone} onLock={setLocked} pollMs={pollMs} />
      )}
    </Dialog>
  )
}

type Step = 'summary' | 'confirm' | 'restoring'

function RestoreSteps({
  backup,
  onClose,
  onDone,
  onLock,
  pollMs,
}: {
  backup: BackupItemJson
  onClose: () => void
  onDone?: () => void
  onLock: (locked: boolean) => void
  pollMs?: number
}) {
  const prepare = usePrepareRestore()
  const [step, setStep] = useState<Step>('summary')
  const asked = useRef(false)
  const { mutate } = prepare

  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opened dialog (StrictMode runs effects twice)
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    mutate(backup.id)
  }, [])

  const [startedAt, setStartedAt] = useState<string | null>(null)
  if (step === 'restoring')
    return <Restoring startedAt={startedAt} onClose={onClose} onDone={onDone} pollMs={pollMs} />

  const restart = () => {
    setStep('summary')
    mutate(backup.id)
  }

  if (prepare.isPending || prepare.isIdle) return <SkeletonRows rows={4} />
  if (prepare.isError) {
    const e = prepare.error
    return (
      <div className="space-y-4">
        <Alert tone="danger" title={e.message}>
          {isApiError(e) && e.hint && <p>{e.hint}</p>}
          {isApiError(e) && Array.isArray(e.details?.problems) && (
            <ul className="mt-1 list-disc pl-5">
              {(e.details.problems as string[]).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </Alert>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Close</Button>
          <Button onClick={restart}>Try again</Button>
        </div>
      </div>
    )
  }
  const p = prepare.data
  return step === 'summary' ? (
    <SummaryStep p={p} onCancel={onClose} onNext={() => setStep('confirm')} />
  ) : (
    <ConfirmStep
      backupId={backup.id}
      p={p}
      onCancel={onClose}
      onStarted={(s) => {
        setStartedAt(s)
        setStep('restoring')
        onLock(true)
      }}
      onRestart={restart}
    />
  )
}

function SummaryStep({
  p,
  onCancel,
  onNext,
}: {
  p: RestorePrepareResponse
  onCancel: () => void
  onNext: () => void
}) {
  const s = p.summary
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Backup made</dt>
        <dd>{dateTime(s.created_at)}</dd>
        <dt className="text-muted">Spoor version</dt>
        <dd>{s.spoor_version}</dd>
        <dt className="text-muted">Schema</dt>
        <dd>
          {s.migration.backup.count} migrations in the backup, {s.migration.current.count} here
          {s.migration.to_apply > 0 ? ` (${s.migration.to_apply} will be applied after the restore)` : ''}
        </dd>
        <dt className="text-muted">Contents</dt>
        <dd>
          {s.projects} projects, {s.items} items
        </dd>
      </dl>
      <p className="text-sm">
        A backup of the current database is made first; if it fails, nothing is restored.
      </p>
      {p.warnings.length > 0 && (
        <Alert tone="warning" title="Before you continue">
          <ul className="list-disc pl-5">
            {p.warnings.map((w) => (
              <li key={w.code}>{w.message}</li>
            ))}
          </ul>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={onNext}>
          Continue
        </Button>
      </div>
    </div>
  )
}

function ConfirmStep({
  backupId,
  p,
  onCancel,
  onStarted,
  onRestart,
}: {
  backupId: string
  p: RestorePrepareResponse
  onCancel: () => void
  onStarted: (startedAt: string | null) => void
  onRestart: () => void
}) {
  const start = useStartRestore()
  const [phrase, setPhrase] = useState('')
  const [password, setPassword] = useState('')
  const ok = phrase === p.phrase && password !== ''
  const err = start.error
  // the token is used up by any server answer to the confirmation (403, 404, 409, 503 busy, 500): the admin has
  // to prepare again. Only a network error (the request may not have arrived) keeps the button.
  const tokenGone = isApiError(err)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!ok || start.isPending) return
    start.mutate(
      { id: backupId, token: p.token, password, phrase },
      { onSuccess: (r) => onStarted(r.restore.started_at) },
    )
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      <Alert tone="danger" title="This replaces the whole database">
        Everything written after {dateTime(p.summary.created_at)} is lost and everyone is logged out.
      </Alert>
      <Input
        label={
          <>
            Type <code className="font-mono">{p.phrase}</code> to confirm
          </>
        }
        value={phrase}
        onChange={(e) => setPhrase(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        autoFocus
      />
      <Input
        label="Your password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
      />
      {err && (
        <Alert tone="danger" title={err.message}>
          {isApiError(err) && err.hint && <p>{err.hint}</p>}
          {tokenGone && <p>The confirmation is used up: prepare the restore again.</p>}
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        {tokenGone && <Button onClick={onRestart}>Prepare again</Button>}
        {!tokenGone && (
          <Button type="submit" variant="danger" disabled={!ok} loading={start.isPending}>
            Restore database
          </Button>
        )}
      </div>
    </form>
  )
}

function Restoring({
  startedAt,
  onClose,
  onDone,
  pollMs,
}: {
  startedAt: string | null
  onClose: () => void
  onDone?: () => void
  pollMs?: number
}) {
  const status = useRestoreStatus(true, pollMs)
  const fired = useRef(false)
  const s = status.data
  // an answer about an older restore (a different start time) is not ours
  const mine = s !== undefined && (startedAt === null || s.started_at === null || s.started_at === startedAt)
  const sessionEnded = isApiError(status.error) && status.error.status === 401
  // `done` while the gate is still on: the page load would hit the maintenance page; wait for the gate to open
  // (then restore-status answers 401, the session having ended)
  const done = (mine && s?.state === 'done' && !s.maintenance) || sessionEnded
  const finish = onDone ?? (() => window.location.assign('/login'))

  // biome-ignore lint/correctness/useExhaustiveDependencies: fire once when the restore is over
  useEffect(() => {
    if (done && !fired.current) {
      fired.current = true
      finish()
    }
  }, [done])

  if (mine && s && s.state === 'failed' && s.maintenance) {
    // failed with the gate still on: after the commit (or the outcome is unknown); no rollback to promise
    return (
      <div className="space-y-4">
        <Alert tone="danger" title="Spoor could not finish the restore">
          <p>
            The database may already have been restored, but Spoor could not finish starting up, so it stays
            in maintenance mode.
          </p>
          <p className="mt-1">
            Restart the Spoor app container. The next start finishes the restore;{' '}
            <code>restore-state.json</code> in the backup directory and the server log have the details.
          </p>
        </Alert>
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    )
  }

  if (mine && s && (s.state === 'failed' || s.state === 'interrupted')) {
    return (
      <div className="space-y-4">
        <Alert
          tone="danger"
          title={s.state === 'failed' ? 'The restore failed' : 'The restore was interrupted'}
        >
          <p>{s.error ?? 'No details were recorded.'}</p>
          <p className="mt-1">
            A failed restore rolls back: the database is as it was before.
            {s.pre_restore_backup_id ? ` A backup of it (${s.pre_restore_backup_id}) was made first.` : ''}
          </p>
        </Alert>
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    )
  }

  const phase = mine && s?.phase ? PHASES[s.phase] : 'Starting'
  const waiting = status.isError
  return (
    <div className="space-y-4" aria-live="polite">
      <p className="font-medium">Restoring… you will be logged out.</p>
      <p className="text-sm">{done ? 'Done. Taking you to the login page…' : `${phase}…`}</p>
      {waiting && !done && (
        <p className="text-sm text-muted">
          The server is not answering at the moment (maintenance or restarting). Waiting for it…
        </p>
      )}
      <p className="text-sm text-muted">Do not close this page. It can take several minutes.</p>
    </div>
  )
}
