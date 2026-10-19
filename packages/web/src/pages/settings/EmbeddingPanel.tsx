/**
 * Embedding provider of a project (web-ui.md §8). Picking a remote provider warns that item text leaves the
 * instance. After saving, a re-embed runs in the background: the panel polls the project's jobs until
 * `embedding.target` is null; search keeps using the old model until the switch.
 */
import type { ProjectJson } from '@spoor/shared'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useInstance, usePatchProject, useProject, useProjectJobs } from '../../api/hooks'
import { Alert, Button, ErrorState, Select, Skeleton, useToast } from '../../ui'

export function EmbeddingPanel({ project }: { project: ProjectJson }) {
  const instance = useInstance()
  const patch = usePatchProject(project.slug)
  const projectQuery = useProject(project.slug)
  const toast = useToast()
  const current = project.settings.embedding.provider
  const [choice, setChoice] = useState(current)
  const target = project.embedding.target
  const jobs = useProjectJobs(project.slug, target !== null)
  const live = jobs.data?.embedding ?? project.embedding
  const maxRemaining = useRef(0)
  maxRemaining.current = Math.max(maxRemaining.current, live.remaining)

  // the jobs poll sees the cut-over first; refresh the project so the panel leaves the "running" state
  const refetchProject = projectQuery.refetch
  const switched = target !== null && jobs.data !== undefined && jobs.data.embedding.target === null
  useEffect(() => {
    if (switched) void refetchProject()
  }, [switched, refetchProject])

  if (instance.isPending) return <Skeleton className="h-24 max-w-md" />
  if (instance.isError) return <ErrorState error={instance.error} onRetry={() => instance.refetch()} />

  const providers = instance.data.providers
  const picked = providers.find((p) => p.name === choice)
  const warn = picked?.remote === true && choice !== current
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (choice === current) return
    patch.mutate(
      { settings: { embedding: { provider: choice } } },
      { onSuccess: () => toast.success('Provider saved.', 'Items are re-embedded in the background.') },
    )
  }
  const total = Math.max(maxRemaining.current, 1)
  const done = total - live.remaining

  return (
    <section aria-label="Embedding">
      <h2 className="text-base font-semibold">Embedding</h2>
      <p className="mt-0.5 text-sm text-muted">
        Search uses model <code className="font-mono">{project.embedding.model}</code>.
      </p>
      <form onSubmit={submit} className="mt-4 max-w-md space-y-4">
        <Select
          label="Provider"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          options={providers.map((p) => ({
            value: p.name,
            label: `${p.name}${p.remote ? ' (remote)' : ' (local)'} · ${p.tag}`,
          }))}
        />
        {warn && (
          <Alert tone="warning">
            Item text will be sent to {choice}. Keys stay in the server environment.
          </Alert>
        )}
        {patch.error && <Alert tone="danger">{patch.error.message}</Alert>}
        <Button type="submit" variant="primary" disabled={choice === current} loading={patch.isPending}>
          Save provider
        </Button>
      </form>
      {target !== null && (
        <div className="mt-4 max-w-md" role="status">
          <p className="text-sm">
            Re-embedding to <code className="font-mono">{target}</code>: {live.remaining} item
            {live.remaining === 1 ? '' : 's'} remaining.
          </p>
          <progress
            className="mt-1 h-2 w-full accent-[var(--c-accent)]"
            max={total}
            value={Math.min(done, total)}
            aria-label="Re-embedding progress"
          />
          <p className="mt-1 text-xs text-muted">Search keeps using the old model until the switch.</p>
        </div>
      )}
    </section>
  )
}
