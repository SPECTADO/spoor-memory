/**
 * Export (a plain download link) and import (multipart upload) of a project (web-ui.md §8, api.md §9).
 * A full Spoor export (with `manifest.json`, lossless) imports only into an empty project; a Markdown-folder archive
 * (no manifest) may also go into a project that already has items, as api.md §9 allows, so the form is always offered
 * and the server decides (409 `project_not_empty` for a full export). The result lists dangling edges and notes.
 */
import { type FormEvent, useState } from 'react'
import { isApiError } from '../../api/client'
import { exportUrl } from '../../api/endpoints'
import { useDashboard, useImportIntoProject } from '../../api/hooks'
import type { ImportResult } from '../../api/types'
import { Alert, Button, buttonClass, Checkbox, Input, Skeleton } from '../../ui'

export function ExportImportPanel({ slug }: { slug: string }) {
  const [withoutHistory, setWithoutHistory] = useState(false)
  return (
    <div className="max-w-xl space-y-10">
      <section aria-label="Export">
        <h2 className="text-base font-semibold">Export</h2>
        <p className="mt-0.5 text-sm text-muted">
          Download every item with its revisions, edges and audit log as a zip.
        </p>
        <div className="mt-4 space-y-3">
          <Checkbox
            label="Without history"
            hint="Leaves out revisions and the audit log; smaller, and the history is not kept."
            checked={withoutHistory}
            onChange={(e) => setWithoutHistory(e.target.checked)}
          />
          <a className={buttonClass('primary')} href={exportUrl(slug, !withoutHistory)} download>
            Download export
          </a>
        </div>
      </section>
      <ImportForm slug={slug} />
    </div>
  )
}

function ImportForm({ slug }: { slug: string }) {
  const dashboard = useDashboard(slug)
  const imp = useImportIntoProject(slug)
  const [file, setFile] = useState<File | null>(null)
  const [remap, setRemap] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)

  const total = dashboard.data
    ? Object.values(dashboard.data.counts).reduce((n, c) => n + c.active + c.stale + c.archived, 0)
    : null
  const empty = total === 0

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!file) return
    setResult(null)
    imp.mutate({ file, remapIds: remap }, { onSuccess: setResult })
  }

  const err = imp.error
  return (
    <section aria-label="Import">
      <h2 className="text-base font-semibold">Import</h2>
      <p className="mt-0.5 text-sm text-muted">
        Restore a Spoor export into this project while it is empty, or add a zip of Markdown files at any
        time.
      </p>
      {dashboard.isPending ? (
        <Skeleton className="mt-4 h-24" />
      ) : (
        <form onSubmit={submit} className="mt-4 space-y-4">
          {!empty && (
            <Alert tone="info">
              This project already has items. You can import a Markdown-folder archive (a zip of .md files
              without manifest.json) into it. A full Spoor export restores losslessly only into an empty
              project: create an empty project first and import it there.
            </Alert>
          )}
          <Input
            label="Archive (.zip)"
            type="file"
            accept=".zip,application/zip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <Checkbox
            label="Re-create ids"
            hint="Give every item a new id. Needed when the ids already exist in another project; repo files carrying the old id no longer match."
            checked={remap}
            onChange={(e) => setRemap(e.target.checked)}
          />
          {err && (
            <Alert tone="danger" title={err.message}>
              {isApiError(err) && err.hint && <p>{err.hint}</p>}
              {isApiError(err, 'id_collision') && <p>Tick "Re-create ids" and try again.</p>}
              {isApiError(err, 'project_not_empty') && (
                <p>This archive is a full Spoor export: import it into an empty project.</p>
              )}
              {isApiError(err) && err.issues.length > 0 && (
                <ul className="mt-1 list-disc pl-5">
                  {err.issues.map((i) => (
                    <li key={`${i.path}:${i.message}`}>
                      {i.path ? `${i.path}: ` : ''}
                      {i.message}
                    </li>
                  ))}
                </ul>
              )}
            </Alert>
          )}
          <Button type="submit" variant="primary" disabled={!file} loading={imp.isPending}>
            Import
          </Button>
        </form>
      )}
      {result && <ImportSummary result={result} />}
    </section>
  )
}

function ImportSummary({ result }: { result: ImportResult }) {
  const c = result.counts
  return (
    <Alert tone="success" title="Import finished" className="mt-4">
      <p>
        {c.items} items, {c.revisions} revisions, {c.edges} edges, {c.audit} audit rows
        {result.remapped ? ' (ids re-created)' : ''}.
      </p>
      {result.appended_revisions.length > 0 && (
        <p className="mt-1">Revisions appended to: {result.appended_revisions.join(', ')}.</p>
      )}
      {result.dangling_edges.length > 0 && (
        <div className="mt-1">
          <p>Dangling edges:</p>
          <ul className="list-disc pl-5">
            {result.dangling_edges.map((d) => (
              <li key={`${d.from}->${d.dst_ref}`}>
                {d.from} to {d.dst_ref}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.notes.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {result.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </Alert>
  )
}
