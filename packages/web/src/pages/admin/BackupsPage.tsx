/**
 * `/admin/backups` (instance admin; ADR-0038 to ADR-0040): status of the backup directory and pg tools, the
 * schedule form, and the list of bundles with pin, verify, delete, full restore and per-project actions.
 * There is no download of the database dump (it holds password and token hashes): operators copy the bundle
 * from the volume.
 */
import { useState } from 'react'
import { useBackups, useDeleteBackup, usePinBackup, useStartBackup, useVerifyBackup } from '../../api/hooks'
import type { BackupItemJson, BackupKind, BackupStatusJson } from '../../api/types'
import { bytes, dateTime, fromNow } from '../../lib/format'
import {
  Alert,
  Badge,
  type BadgeTone,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageHeader,
  SkeletonRows,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
  useToast,
} from '../../ui'
import { BackupScheduleForm } from './BackupScheduleForm'
import { ProjectsInBackupDialog } from './ProjectsInBackupDialog'
import { RestoreDialog } from './RestoreDialog'

const KIND_TONE: Record<BackupKind, BadgeTone> = {
  auto: 'neutral',
  manual: 'accent',
  'pre-restore': 'warning',
}

const UNAVAILABLE: Record<string, string> = {
  no_backup_dir: 'SPOOR_BACKUP_DIR is not set.',
  dir_not_writable: 'The backup directory is missing or not writable by the app.',
  pg_tools_missing: 'pg_dump, pg_restore or psql was not found (SPOOR_PG_BIN_DIR, PATH).',
  pg_version_mismatch: 'The database server is newer than the installed PostgreSQL client tools.',
}

export const unavailableText = (s: BackupStatusJson): string =>
  s.reason_message ?? (s.reason ? UNAVAILABLE[s.reason] : undefined) ?? 'Backups are not available.'

/** After "Back up now" the list is polled every 3 s for this long, whatever `status.running` says. */
const FAST_POLL_MS = 60_000

export function BackupsPage() {
  const [fast, setFast] = useState(false)
  // here, not in the table: the list answers 503 `maintenance` during a full restore, and the dialog (with its
  // restore-status polling) must stay while the list shows an error
  const [restore, setRestore] = useState<BackupItemJson | null>(null)
  const q = useBackups(fast)
  const start = useStartBackup()
  const toast = useToast()

  const running = q.data?.status.running ?? null
  const startNow = () =>
    start.mutate(undefined, {
      onSuccess: () => {
        setFast(true)
        setTimeout(() => setFast(false), FAST_POLL_MS)
        toast.success('Backup started.', 'It appears in the list when it is finished.')
      },
      onError: (e) => toast.error(e),
    })

  return (
    <section>
      <PageHeader
        title="Backups"
        description="Database dumps and a zip per project, kept on the server's backup volume."
        actions={
          <Button
            variant="primary"
            onClick={startNow}
            loading={start.isPending || running?.operation === 'backup'}
            disabled={!q.data?.status.available || running !== null}
          >
            Back up now
          </Button>
        }
      />
      {q.isPending ? (
        <SkeletonRows rows={6} />
      ) : !q.data ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="space-y-8">
          <StatusCard status={q.data.status} enabled={q.data.settings.enabled} />
          <section aria-label="Schedule" className="max-w-xl">
            <h2 className="text-base font-semibold">Schedule</h2>
            <div className="mt-3">
              <BackupScheduleForm key={JSON.stringify(q.data.settings)} settings={q.data.settings} />
            </div>
          </section>
          <BackupTable items={q.data.items} status={q.data.status} onRestore={setRestore} />
        </div>
      )}
      <RestoreDialog backup={restore} onClose={() => setRestore(null)} />
    </section>
  )
}

function StatusCard({ status, enabled }: { status: BackupStatusJson; enabled: boolean }) {
  return (
    <section aria-label="Backup status" className="rounded-lg border border-border bg-bg p-4">
      <h2 className="mb-3 text-sm font-semibold">Status</h2>
      <div className="space-y-3">
        {!status.available && (
          <Alert tone="warning" title="Backups are not available">
            {unavailableText(status)}
          </Alert>
        )}
        {status.overdue && (
          <Alert tone="warning" title="The last good backup is overdue">
            Scheduled backups are on, but the newest good one is older than twice the interval.
          </Alert>
        )}
        {status.running && (
          <Alert tone="info" title={`A ${status.running.operation} is running`}>
            {status.running.backup_id}, since {fromNow(status.running.started_at)}.
          </Alert>
        )}
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted">Directory</dt>
          <dd className="font-mono break-all">{status.dir ?? 'not set'}</dd>
          <dt className="text-muted">Free space</dt>
          <dd>{bytes(status.free_bytes)}</dd>
          <dt className="text-muted">Last good backup</dt>
          <dd>
            {status.last_good_at
              ? `${dateTime(status.last_good_at)} (${fromNow(status.last_good_at)})`
              : 'none yet'}
          </dd>
          <dt className="text-muted">Next scheduled</dt>
          <dd>
            {enabled
              ? status.next_due_at
                ? dateTime(status.next_due_at)
                : '—'
              : 'scheduled backups are off'}
          </dd>
          <dt className="text-muted">PostgreSQL</dt>
          <dd>
            server {status.server_version ?? '—'}, {status.pg_dump_version ?? 'pg_dump not found'}
          </dd>
        </dl>
      </div>
    </section>
  )
}

function BackupTable({
  items,
  status,
  onRestore,
}: {
  items: BackupItemJson[]
  status: BackupStatusJson
  onRestore: (b: BackupItemJson) => void
}) {
  const [projects, setProjects] = useState<BackupItemJson | null>(null)
  const [del, setDel] = useState<BackupItemJson | null>(null)
  const pin = usePinBackup()
  const verify = useVerifyBackup()
  const remove = useDeleteBackup()
  const toast = useToast()
  const [verifying, setVerifying] = useState<string | null>(null)
  const busy = status.running !== null

  const runVerify = (b: BackupItemJson) => {
    setVerifying(b.id)
    verify.mutate(b.id, {
      onSuccess: (r) =>
        r.ok
          ? toast.success('Backup verified.', b.id)
          : toast.error(new Error(`Verification failed: ${r.problems.join('; ')}`)),
      onError: (e) => toast.error(e),
      onSettled: () => setVerifying(null),
    })
  }

  return (
    <section aria-label="Backup list">
      <h2 className="mb-3 text-base font-semibold">Backups</h2>
      {items.length === 0 ? (
        <EmptyState title="No backups yet.">Use Back up now, or turn on the schedule above.</EmptyState>
      ) : (
        <Table caption="Backups, newest first">
          <THead>
            <tr>
              <Th>Date</Th>
              <Th>Kind</Th>
              <Th className="text-right">Size</Th>
              <Th>Projects</Th>
              <Th>Verified</Th>
              <Th>Actions</Th>
            </tr>
          </THead>
          <TBody>
            {items.map((b) => (
              <Tr key={b.id}>
                <Td>
                  <span title={b.id}>{dateTime(b.created_at)}</span>
                  <span className="block text-xs text-muted">Spoor {b.spoor_version}</span>
                </Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    <Badge tone={KIND_TONE[b.kind]}>{b.kind}</Badge>
                    {b.pinned && <Badge tone="accent">Pinned</Badge>}
                    {!b.restorable && <Badge tone="danger">Newer than this server</Badge>}
                  </span>
                </Td>
                <Td className="text-right tabular-nums">{bytes(b.size_bytes)}</Td>
                <Td>
                  {b.projects}
                  {b.projects_skipped > 0 && (
                    <span className="block text-xs text-warning">{b.projects_skipped} without a zip</span>
                  )}
                </Td>
                <Td>
                  {b.verified_at ? dateTime(b.verified_at) : <span className="text-muted">not verified</span>}
                </Td>
                <Td>
                  <span className="flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      aria-label={`${b.pinned ? 'Unpin' : 'Pin'} backup ${b.id}`}
                      onClick={() =>
                        pin.mutate({ id: b.id, pinned: !b.pinned }, { onError: (e) => toast.error(e) })
                      }
                    >
                      {b.pinned ? 'Unpin' : 'Pin'}
                    </Button>
                    <Button
                      size="sm"
                      loading={verifying === b.id}
                      disabled={busy || !status.available}
                      aria-label={`Verify backup ${b.id}`}
                      onClick={() => runVerify(b)}
                    >
                      Verify
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy || !status.available || !b.restorable}
                      title={
                        b.restorable ? undefined : 'This backup has more migrations than this server knows.'
                      }
                      aria-label={`Restore backup ${b.id}`}
                      onClick={() => onRestore(b)}
                    >
                      Restore…
                    </Button>
                    <Button
                      size="sm"
                      aria-label={`Projects in backup ${b.id}`}
                      onClick={() => setProjects(b)}
                    >
                      Projects…
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      aria-label={`Delete backup ${b.id}`}
                      onClick={() => setDel(b)}
                    >
                      Delete
                    </Button>
                  </span>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      <ProjectsInBackupDialog backup={projects} onClose={() => setProjects(null)} />
      <ConfirmDialog
        open={del !== null}
        onClose={() => setDel(null)}
        title="Delete this backup?"
        confirmLabel="Delete backup"
        danger
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() =>
          del &&
          remove.mutate(del.id, {
            onSuccess: () => {
              toast.success('Backup deleted.')
              setDel(null)
            },
          })
        }
      >
        <p>
          The bundle of {del ? dateTime(del.created_at) : ''} ({del?.kind}) is removed from the volume
          {del?.pinned || del?.kind === 'manual' ? ', although automatic pruning would have kept it' : ''}.
          This cannot be undone.
        </p>
      </ConfirmDialog>
    </section>
  )
}
