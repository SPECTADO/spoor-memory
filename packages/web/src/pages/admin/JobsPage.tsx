/** `/admin/jobs` (instance admin): job status and the last runs, with "Run now" for the runnable jobs. */
import { useState } from 'react'
import { useInstanceJobs, useRunJob } from '../../api/hooks'
import type { JobRunJson } from '../../api/types'
import { dateTime, fromNow } from '../../lib/format'
import {
  Alert,
  Badge,
  type BadgeTone,
  Button,
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

/** The jobs `POST /jobs/:name/run` accepts (api.md §10). */
export const RUNNABLE_JOBS = ['cleanup', 'embed-pending', 'reembed', 'purge-ephemeral']

const REASONS: Record<string, string> = {
  disabled: 'the scheduler is disabled on this instance',
  running: 'it is already running',
  stopped: 'the server is stopping',
}

function statusTone(status: string | null): BadgeTone {
  if (status === 'ok' || status === 'success' || status === 'done') return 'success'
  if (status === 'error' || status === 'failed') return 'danger'
  if (status === 'running') return 'accent'
  return 'neutral'
}

function every(s: number | null): string {
  if (s === null) return 'on demand'
  if (s % 86_400 === 0) return `every ${s / 86_400} d`
  if (s % 3_600 === 0) return `every ${s / 3_600} h`
  if (s % 60 === 0) return `every ${s / 60} min`
  return `every ${s} s`
}

export function JobsPage() {
  const jobs = useInstanceJobs()
  const run = useRunJob()
  const toast = useToast()
  const [running, setRunning] = useState<string | null>(null)

  const go = (name: string) => {
    setRunning(name)
    run.mutate(name, {
      onSuccess: (r) =>
        r.started
          ? toast.success(`${name} started.`)
          : toast.show({
              kind: 'info',
              message: `${name} did not start: ${REASONS[r.reason ?? ''] ?? r.reason ?? 'unknown reason'}.`,
            }),
      onError: (e) => toast.error(e),
      onSettled: () => setRunning(null),
    })
  }

  return (
    <section>
      <PageHeader
        title="Jobs"
        description="Background jobs of this instance."
        actions={
          <Button onClick={() => jobs.refetch()} loading={jobs.isFetching && !jobs.isPending}>
            Refresh
          </Button>
        }
      />
      {jobs.isPending ? (
        <SkeletonRows rows={5} />
      ) : jobs.isError ? (
        <ErrorState error={jobs.error} onRetry={() => jobs.refetch()} />
      ) : (
        <div className="space-y-8">
          {!jobs.data.scheduler.enabled && (
            <Alert tone="warning">
              The scheduler is disabled on this instance, so jobs do not run by themselves.
            </Alert>
          )}
          <Table caption="Jobs">
            <THead>
              <tr>
                <Th>Job</Th>
                <Th>Cadence</Th>
                <Th>Last run</Th>
                <Th>Status</Th>
                <Th>Last error</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </THead>
            <TBody>
              {jobs.data.jobs.map((j) => (
                <Tr key={j.name}>
                  <Td className="font-mono">{j.name}</Td>
                  <Td className="whitespace-nowrap">{every(j.every_s)}</Td>
                  <Td className="whitespace-nowrap" title={dateTime(j.last_run_at)}>
                    {fromNow(j.last_run_at)}
                  </Td>
                  <Td>
                    {j.running_here ? (
                      <Badge tone="accent">running</Badge>
                    ) : j.last_status ? (
                      <Badge tone={statusTone(j.last_status)}>{j.last_status}</Badge>
                    ) : (
                      <span className="text-muted">never run</span>
                    )}
                    {j.locked_until && !j.running_here && (
                      <div className="mt-0.5 text-xs text-muted">
                        locked by {j.locked_by ?? 'another node'}
                      </div>
                    )}
                  </Td>
                  <Td className="max-w-xs text-xs break-words">{j.last_error ?? ''}</Td>
                  <Td>
                    {RUNNABLE_JOBS.includes(j.name) && (
                      <Button
                        size="sm"
                        onClick={() => go(j.name)}
                        loading={running === j.name}
                        aria-label={`Run ${j.name} now`}
                      >
                        Run now
                      </Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <div>
            <h2 className="mb-2 text-base font-semibold">Recent runs</h2>
            {jobs.data.recent.length === 0 ? (
              <EmptyState title="No runs yet." />
            ) : (
              <RunsTable runs={jobs.data.recent} />
            )}
          </div>
        </div>
      )}
    </section>
  )
}

function RunsTable({ runs }: { runs: JobRunJson[] }) {
  return (
    <Table caption="Recent job runs">
      <THead>
        <tr>
          <Th>Job</Th>
          <Th>Started</Th>
          <Th>Finished</Th>
          <Th>Status</Th>
          <Th>Detail</Th>
        </tr>
      </THead>
      <TBody>
        {runs.map((r) => (
          <Tr key={r.id}>
            <Td className="font-mono">{r.name}</Td>
            <Td className="whitespace-nowrap">{dateTime(r.started_at)}</Td>
            <Td className="whitespace-nowrap">{r.finished_at ? dateTime(r.finished_at) : '—'}</Td>
            <Td>
              <Badge tone={statusTone(r.status)}>{r.status}</Badge>
            </Td>
            <Td className="max-w-sm text-xs break-words">
              {r.error ?? (Object.keys(r.stats).length ? JSON.stringify(r.stats) : '')}
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  )
}
