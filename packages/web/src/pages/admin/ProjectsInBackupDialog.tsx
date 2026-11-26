/**
 * The projects inside one backup (api.md §13.3): download one as a Markdown zip, restore it as a new copy to look
 * at, or overwrite the live project (password and the typed slug). Reads the per-project archives only; a project
 * without one ("skipped" at backup time) can be restored by a full restore only.
 */
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router'
import { isApiError } from '../../api/client'
import {
  useBackupProjects,
  useCreateBackupExport,
  useExportTask,
  useRestoreBackupProject,
} from '../../api/hooks'
import type { BackupItemJson, BackupProjectJson, ProjectRestoreResponse } from '../../api/types'
import { ExportTaskStatus } from '../../components/ExportTaskStatus'
import { dateTime } from '../../lib/format'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  issuesByField,
  SkeletonRows,
  useToast,
} from '../../ui'

export function ProjectsInBackupDialog({
  backup,
  onClose,
}: {
  /** The backup to look into; null = closed. */
  backup: BackupItemJson | null
  onClose: () => void
}) {
  return (
    <Dialog
      open={backup !== null}
      onClose={onClose}
      title="Projects in this backup"
      description={backup ? `Backup of ${dateTime(backup.created_at)} (${backup.kind}).` : undefined}
      size="lg"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {backup && <ProjectList backup={backup} />}
    </Dialog>
  )
}

type Mode = { projectId: string; kind: 'copy' | 'overwrite' }

function ProjectList({ backup }: { backup: BackupItemJson }) {
  const q = useBackupProjects(backup.id)
  const [mode, setMode] = useState<Mode | null>(null)
  const [done, setDone] = useState<ProjectRestoreResponse | null>(null)

  if (q.isPending) return <SkeletonRows rows={3} />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  if (q.data.projects.length === 0) return <EmptyState title="This backup lists no projects." />
  return (
    <div className="space-y-4">
      {done && <RestoreResult r={done} />}
      <ul className="divide-y divide-border rounded-md border border-border">
        {q.data.projects.map((p) => (
          <li key={p.id} className="space-y-3 p-3">
            <ProjectRow
              backup={backup}
              p={p}
              mode={mode?.projectId === p.id ? mode.kind : null}
              setMode={(kind) => setMode(kind ? { projectId: p.id, kind } : null)}
              onDone={(r) => {
                setDone(r)
                setMode(null)
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  )
}

function RestoreResult({ r }: { r: ProjectRestoreResponse }) {
  return (
    <Alert
      tone="success"
      title={r.mode === 'new' ? 'Restored as a new project' : 'Project overwritten from the backup'}
    >
      <p>
        <Link className="text-accent underline" to={`/projects/${encodeURIComponent(r.project.slug)}`}>
          {r.project.name}
        </Link>{' '}
        ({r.counts.items} items, {r.counts.revisions} revisions, {r.counts.edges} edges).
      </p>
      {r.safety_archive && (
        <p className="mt-1">The project as it was is kept for 14 days: {r.safety_archive}.</p>
      )}
      {r.notes.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </Alert>
  )
}

function ProjectRow({
  backup,
  p,
  mode,
  setMode,
  onDone,
}: {
  backup: BackupItemJson
  p: BackupProjectJson
  mode: Mode['kind'] | null
  setMode: (kind: Mode['kind'] | null) => void
  onDone: (r: ProjectRestoreResponse) => void
}) {
  const exp = useCreateBackupExport(backup.id)
  const toast = useToast()
  const [taskId, setTaskId] = useState<string | null>(null)
  const task = useExportTask(taskId)

  const download = () =>
    exp.mutate(p.id, {
      onSuccess: (r) => setTaskId(r.task.id),
      onError: (e) => toast.error(e),
    })

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            {p.name} <span className="font-mono text-xs text-muted">{p.slug}</span>
          </p>
          <p className="text-xs text-muted">
            {p.items} items{p.history ? ', with history' : ', without history'}
            {p.kind === 'shared' && ' · shared space'}
            {p.live ? ` · exists now as ${p.live.slug}` : ' · no longer exists'}
          </p>
        </div>
        {p.restorable ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={download}
              loading={exp.isPending || (task.data !== undefined && isOpen(task.data.task.status))}
              aria-label={`Download Markdown of ${p.name}`}
            >
              Download Markdown
            </Button>
            <Button
              size="sm"
              onClick={() => setMode(mode === 'copy' ? null : 'copy')}
              aria-label={`Restore ${p.name} as copy`}
            >
              Restore as copy…
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={!p.can_overwrite}
              title={
                p.can_overwrite
                  ? undefined
                  : p.kind === 'shared'
                    ? 'The shared space cannot be overwritten in this version.'
                    : 'The project no longer exists: restore it as a copy instead.'
              }
              onClick={() => setMode(mode === 'overwrite' ? null : 'overwrite')}
              aria-label={`Overwrite ${p.name}`}
            >
              Overwrite…
            </Button>
          </div>
        ) : (
          <Badge tone="warning">Not restorable per project; use full restore</Badge>
        )}
      </div>
      {task.data && <ExportTaskStatus task={task.data.task} />}
      {mode === 'copy' && (
        <CopyForm backupId={backup.id} p={p} onCancel={() => setMode(null)} onDone={onDone} />
      )}
      {mode === 'overwrite' && p.live && (
        <OverwriteForm
          backupId={backup.id}
          p={p}
          liveSlug={p.live.slug}
          onCancel={() => setMode(null)}
          onDone={onDone}
        />
      )}
    </>
  )
}

const isOpen = (s: string) => s === 'queued' || s === 'running'

function CopyForm({
  backupId,
  p,
  onCancel,
  onDone,
}: {
  backupId: string
  p: BackupProjectJson
  onCancel: () => void
  onDone: (r: ProjectRestoreResponse) => void
}) {
  const restore = useRestoreBackupProject(backupId)
  const [slug, setSlug] = useState(p.suggested_slug)
  const [name, setName] = useState(p.suggested_name)
  const issues = isApiError(restore.error) ? issuesByField(restore.error.issues) : {}
  const slugTaken = isApiError(restore.error, 'slug_taken')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    restore.mutate({ projectId: p.id, mode: 'new', slug, name }, { onSuccess: onDone })
  }
  return (
    <form
      onSubmit={submit}
      aria-label={`Restore ${p.name} as copy form`}
      className="space-y-3 rounded-md bg-surface p-3"
    >
      <p className="text-sm">
        Creates a new project with the backup's content, a temporary copy to look at. You are its only member;
        delete it when you are done.
      </p>
      <Input
        label="Slug of the copy"
        value={slug}
        onChange={(e) => setSlug(e.target.value)}
        error={slugTaken ? 'This slug is taken: choose another.' : issues.slug}
        autoComplete="off"
        spellCheck={false}
      />
      <Input
        label="Name of the copy"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={issues.name}
      />
      {restore.error && !slugTaken && <Alert tone="danger" title={restore.error.message} />}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          loading={restore.isPending}
          disabled={slug === '' || name === ''}
        >
          Restore as copy
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

function OverwriteForm({
  backupId,
  p,
  liveSlug,
  onCancel,
  onDone,
}: {
  backupId: string
  p: BackupProjectJson
  liveSlug: string
  onCancel: () => void
  onDone: (r: ProjectRestoreResponse) => void
}) {
  const restore = useRestoreBackupProject(backupId)
  const [typed, setTyped] = useState('')
  const [password, setPassword] = useState('')
  const ok = typed === liveSlug && password !== ''
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!ok) return
    restore.mutate({ projectId: p.id, mode: 'overwrite', password, confirm: typed }, { onSuccess: onDone })
  }
  return (
    <form
      onSubmit={submit}
      aria-label={`Overwrite ${p.name} form`}
      className="space-y-3 rounded-md border border-danger/40 p-3"
    >
      <p className="text-sm">
        Replaces every item of <strong>{liveSlug}</strong> with the backup's. Members, tokens and settings
        stay. The project as it is now is saved first and kept for 14 days.
      </p>
      <Input
        label={
          <>
            Type <code className="font-mono">{liveSlug}</code> to confirm
          </>
        }
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <Input
        label="Your password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
      />
      {restore.error && (
        <Alert tone="danger" title={restore.error.message}>
          {isApiError(restore.error) && restore.error.hint && <p>{restore.error.hint}</p>}
        </Alert>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={!ok} loading={restore.isPending}>
          Overwrite project
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}
