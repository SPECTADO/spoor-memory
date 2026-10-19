/**
 * Project administration (web-ui.md §8): `/settings` with tabs (General, Members, Tokens, Export and
 * import, Audit, Danger zone), plus the standalone `/members`, `/tokens` and `/audit` routes that render the
 * same panels. The shared space has no members, tokens or delete.
 */
import type { ProjectJson } from '@spoor/shared'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useDeleteProject, useMe, useProject } from '../../api/hooks'
import { RequireRole } from '../../components/RequireRole'
import { isShared, useProjectSlug } from '../../lib/paths'
import { Button, ConfirmDialog, cx, ErrorState, NotFound, PageHeader, SkeletonRows, useToast } from '../../ui'
import { AuditPanel } from './AuditPanel'
import { EmbeddingPanel } from './EmbeddingPanel'
import { ExportImportPanel } from './ExportImportPanel'
import { MembersPanel } from './MembersPanel'
import { SettingsForm } from './SettingsForm'
import { TokensPanel } from './TokensPanel'

type Tab = 'general' | 'members' | 'tokens' | 'data' | 'audit' | 'danger'

export function SettingsPageImpl() {
  return (
    <RequireRole gate="admin">
      <SettingsBody />
    </RequireRole>
  )
}

function SettingsBody() {
  const slug = useProjectSlug()
  const shared = isShared(slug)
  const me = useMe()
  const project = useProject(slug)
  const [params] = useSearchParams()

  if (project.isPending) return <SkeletonRows rows={4} />
  if (project.isError || !project.data)
    return <ErrorState error={project.error} onRetry={() => project.refetch()} />

  const isIa = me.data?.user.is_admin === true
  const tabs: { key: Tab; label: string }[] = [
    { key: 'general', label: 'General' },
    ...(shared
      ? []
      : ([
          { key: 'members', label: 'Members' },
          { key: 'tokens', label: 'Tokens' },
        ] as const)),
    { key: 'data', label: 'Export and import' },
    { key: 'audit', label: 'Audit log' },
    ...(isIa && !shared ? [{ key: 'danger' as const, label: 'Danger zone' }] : []),
  ]
  const asked = params.get('tab')
  const tab = tabs.find((t) => t.key === asked)?.key ?? 'general'

  return (
    <section>
      <PageHeader title={`${project.data.name} settings`} />
      <nav aria-label="Settings sections" className="mb-6">
        <ul className="flex flex-wrap gap-1 border-b border-border">
          {tabs.map((t) => (
            <li key={t.key}>
              <Link
                to={`?tab=${t.key}`}
                replace
                aria-current={t.key === tab ? 'page' : undefined}
                className={cx(
                  '-mb-px block border-b-2 px-3 py-2 text-sm hover:bg-surface-2',
                  t.key === tab ? 'border-accent font-medium text-accent' : 'border-transparent',
                )}
              >
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {tab === 'general' && (
        <div className="space-y-10">
          <SettingsForm project={project.data} />
          <EmbeddingPanel project={project.data} />
        </div>
      )}
      {tab === 'members' && <MembersPanel slug={slug} />}
      {tab === 'tokens' && <TokensPanel slug={slug} />}
      {tab === 'data' && <ExportImportPanel slug={slug} />}
      {tab === 'audit' && <AuditPanel slug={slug} />}
      {tab === 'danger' && <DangerZone project={project.data} />}
    </section>
  )
}

function DangerZone({ project }: { project: ProjectJson }) {
  const del = useDeleteProject()
  const navigate = useNavigate()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  return (
    <section aria-label="Danger zone" className="max-w-xl">
      <h2 className="text-base font-semibold text-danger">Danger zone</h2>
      <div className="mt-4 rounded-md border border-danger/40 p-4">
        <p className="font-medium">Delete this project</p>
        <p className="mt-1 text-sm text-muted">
          Removes every item, revision, edge, token and audit row of {project.name}. Export it first if you
          might need it. This cannot be undone.
        </p>
        <Button className="mt-3" variant="danger" onClick={() => setOpen(true)}>
          Delete project
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Delete ${project.name}?`}
        typeToConfirm={project.slug}
        confirmLabel="Delete project"
        danger
        pending={del.isPending}
        error={del.error?.message}
        onConfirm={() =>
          del.mutate(project.slug, {
            onSuccess: () => {
              toast.success(`Project ${project.name} deleted.`)
              navigate('/projects', { replace: true })
            },
          })
        }
      >
        All data of this project is deleted permanently.
      </ConfirmDialog>
    </section>
  )
}

// ---- standalone routes -----------------------------------------------------------------------------------

export function MembersPageImpl() {
  const slug = useProjectSlug()
  if (isShared(slug)) return <NotFound backTo="/shared" backLabel="Back to shared knowledge" />
  return (
    <section>
      <PageHeader title="Members" description="People with access to this project, and their roles." />
      <MembersPanel slug={slug} />
    </section>
  )
}

export function TokensPageImpl() {
  const slug = useProjectSlug()
  if (isShared(slug)) return <NotFound backTo="/shared" backLabel="Back to shared knowledge" />
  return (
    <section>
      <PageHeader title="Tokens" />
      <TokensPanel slug={slug} />
    </section>
  )
}

export function AuditPageImpl() {
  const slug = useProjectSlug()
  return (
    <section>
      <PageHeader title="Audit log" />
      <AuditPanel slug={slug} />
    </section>
  )
}
