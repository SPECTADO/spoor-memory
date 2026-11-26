/**
 * "Prepare Markdown zip" (ADR-0041): queues a background task that writes the project as flat Markdown files
 * (re-importable, with a README index). The list polls every 5 s while a task is queued or running; a ready one is
 * a plain `<a download>` link and is deleted by the server after 24 hours.
 */
import { useCreateProjectExport, useDeleteExportTask, useProjectExports } from '../../api/hooks'
import { isOpenExportTask } from '../../api/types'
import { ExportTaskStatus } from '../../components/ExportTaskStatus'
import { dateTime, fromNow } from '../../lib/format'
import { Alert, Button, Skeleton, Table, TBody, Td, THead, Th, Tr, useToast } from '../../ui'

export function MarkdownZipSection({ slug }: { slug: string }) {
  const list = useProjectExports(slug)
  const create = useCreateProjectExport(slug)
  const del = useDeleteExportTask(slug)
  const toast = useToast()
  const items = list.data?.items ?? []
  const open = items.filter((t) => isOpenExportTask(t.status)).length

  return (
    <section aria-label="Markdown zip">
      <h2 className="text-base font-semibold">Markdown zip</h2>
      <p className="mt-0.5 text-sm text-muted">
        Every item as a Markdown file in a zip (memories, decisions, docs, library) with an index. It is built
        in the background and the file stays for 24 hours. The zip can be imported again, but unlike the
        export above it has no revisions or audit log.
      </p>
      <div className="mt-4 space-y-3">
        <Button
          variant="primary"
          loading={create.isPending}
          onClick={() =>
            create.mutate(undefined, {
              onSuccess: () => toast.success('Markdown zip queued.'),
              onError: (e) => toast.error(e),
            })
          }
        >
          Prepare Markdown zip
        </Button>
        {open > 0 && (
          <p className="text-sm text-muted">{open} in progress. This list refreshes every 5 seconds.</p>
        )}
        {list.isPending ? (
          <Skeleton className="h-12" />
        ) : list.isError ? (
          <Alert tone="warning" title="Could not load the list of zips.">
            {list.error.message}
          </Alert>
        ) : (
          items.length > 0 && (
            <Table caption="Markdown zips of this project">
              <THead>
                <tr>
                  <Th>Requested</Th>
                  <Th>By</Th>
                  <Th>Status</Th>
                  <Th>Expires</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </THead>
              <TBody>
                {items.map((t) => (
                  <Tr key={t.id}>
                    <Td>{dateTime(t.created_at)}</Td>
                    <Td>{t.requested_by.label}</Td>
                    <Td>
                      <ExportTaskStatus task={t} />
                    </Td>
                    <Td>{t.status === 'ready' ? fromNow(t.expires_at) : '—'}</Td>
                    <Td>
                      <Button
                        size="sm"
                        loading={del.isPending && del.variables === t.id}
                        onClick={() => del.mutate(t.id, { onError: (e) => toast.error(e) })}
                      >
                        {isOpenExportTask(t.status) ? 'Cancel' : 'Delete'}
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )
        )}
      </div>
    </section>
  )
}
