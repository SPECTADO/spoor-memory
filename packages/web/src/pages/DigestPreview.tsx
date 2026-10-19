/**
 * "Preview digest" on the dashboard (web-ui.md §3): what an agent's `spoor_context` call would get, from the
 * cookie twin `GET …/context`, with an optional query and file list. Read-only.
 */
import { type FormEvent, useState } from 'react'
import { useContextPreview } from '../api/hooks'
import type { ContextParams } from '../api/types'
import { Button, Dialog, ErrorState, Input, SkeletonRows, Textarea } from '../ui'

export function DigestPreviewButton({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Preview digest</Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title="Digest preview"
        description="What an agent gets from spoor_context. Reading it changes nothing."
      >
        <DigestPreviewForm slug={slug} />
      </Dialog>
    </>
  )
}

/** Files as typed: one repo path per line, at most 200 (api.md §7.1). */
export function toContextParams(query: string, files: string): ContextParams {
  const file = files
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean)
    .slice(0, 200)
  return { query: query.trim() || undefined, file: file.length ? file : undefined }
}

function DigestPreviewForm({ slug }: { slug: string }) {
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState('')
  const [params, setParams] = useState<ContextParams | null>({})
  const preview = useContextPreview(slug, params)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setParams(toContextParams(query, files))
  }
  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-3">
        <Input
          label="Query (optional)"
          value={query}
          maxLength={500}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
        <Textarea
          label="Changed files (optional)"
          rows={3}
          value={files}
          onChange={(e) => setFiles(e.target.value)}
          hint="One repo path per line; items anchored to them rank higher."
          inputClassName="font-mono"
          spellCheck={false}
        />
        <Button type="submit" variant="primary" loading={preview.isFetching}>
          Show digest
        </Button>
      </form>
      {preview.isPending ? (
        <SkeletonRows rows={4} label="Loading the digest" />
      ) : preview.isError ? (
        <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
      ) : (
        <section aria-label="Digest">
          <p className="mb-2 text-xs text-muted">
            About {preview.data.est_tokens.toLocaleString('en')} of {preview.data.budget.toLocaleString('en')}{' '}
            tokens · {preview.data.items.length} items
            {preview.data.dropped > 0 && ` · ${preview.data.dropped} left out for the budget`}
          </p>
          <pre className="max-h-96 overflow-auto rounded-md border border-border bg-surface p-3 font-mono text-xs whitespace-pre-wrap">
            {preview.data.text}
          </pre>
        </section>
      )}
    </div>
  )
}
