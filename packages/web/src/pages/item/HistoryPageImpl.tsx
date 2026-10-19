/**
 * Revision history `…/i/:ref/history?rev=&base=` (web-ui.md §6): the revision list (newest first, "Load
 * more"); selecting one sets `?rev=`, `?base=` defaults to the previous revision and can be any older one.
 * The diff shows title and status inline, the frontmatter by key, and the body as a folded line diff.
 * "Restore this version" opens the editor with that snapshot on top of the current revision (no server-side
 * revert).
 */
import { RotateCcw } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router'
import { ApiError } from '../../api/client'
import { flattenPages, useItem, useRevision, useRevisions } from '../../api/hooks'
import type { ItemJson, RevisionSnapshot, RevisionSummary } from '../../api/types'
import { useCan } from '../../components/RequireRole'
import { dateTime } from '../../lib/format'
import { itemPath, projectPath, useProjectSlug } from '../../lib/paths'
import { useSearchParamsState } from '../../lib/useSearchParamsState'
import {
  Badge,
  Button,
  cx,
  DiffView,
  EmptyState,
  ErrorState,
  NotFound,
  PageHeader,
  Select,
  Skeleton,
  SkeletonRows,
} from '../../ui'
import { When } from './common'
import type { RestoreState } from './EditorPageImpl'
import { type FmChange, fmText, frontmatterDiff } from './frontmatterDiff'

const posInt = (s: string | null): number | null => {
  const n = Number(s)
  return s && Number.isSafeInteger(n) && n > 0 ? n : null
}

export function HistoryPageImpl() {
  const slug = useProjectSlug()
  const { ref = '' } = useParams()
  const item = useItem(slug, ref)
  if (item.isPending) return <SkeletonRows rows={6} />
  if (item.error instanceof ApiError && item.error.status === 404)
    return <NotFound backTo={projectPath(slug)} backLabel="Back to the project" />
  if (item.isError) return <ErrorState error={item.error} onRetry={() => item.refetch()} />
  return <History slug={slug} item={item.data} />
}

function History({ slug, item }: { slug: string; item: ItemJson }) {
  const [params, updateParams] = useSearchParamsState()
  const revisions = useRevisions(slug, item.handle)
  const list = flattenPages(revisions.data)
  const rev = posInt(params.get('rev')) ?? list[0]?.revision ?? item.revision
  const baseParam = params.get('base')
  const base = baseParam === 'none' ? null : (posInt(baseParam) ?? (rev > 1 ? rev - 1 : null))

  const select = (next: { rev?: number; base?: number | null }) =>
    updateParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next.rev !== undefined) {
        p.set('rev', String(next.rev))
        p.delete('base')
      }
      if (next.base !== undefined) {
        if (next.base === null) p.set('base', 'none')
        else p.set('base', String(next.base))
      }
      return p
    })

  return (
    <section>
      <PageHeader
        title={`History of ${item.handle}`}
        description={
          <Link to={itemPath(slug, item.handle)} className="text-accent underline">
            {item.title}
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <nav aria-label="Revisions" className="min-w-0">
          {revisions.isPending ? (
            <SkeletonRows rows={4} label="Loading revisions" />
          ) : revisions.isError ? (
            <ErrorState error={revisions.error} onRetry={() => revisions.refetch()} />
          ) : list.length === 0 ? (
            <EmptyState>No revisions.</EmptyState>
          ) : (
            <>
              <ol className="divide-y divide-border rounded-md border border-border">
                {list.map((r) => (
                  <li key={r.revision}>
                    <RevisionEntry
                      r={r}
                      selected={r.revision === rev}
                      onSelect={() => select({ rev: r.revision })}
                    />
                  </li>
                ))}
              </ol>
              {revisions.hasNextPage && (
                <Button
                  size="sm"
                  className="mt-2 w-full"
                  loading={revisions.isFetchingNextPage}
                  onClick={() => revisions.fetchNextPage()}
                >
                  Load more
                </Button>
              )}
            </>
          )}
        </nav>
        <div className="min-w-0">
          <Compare
            slug={slug}
            item={item}
            rev={rev}
            base={base}
            list={list}
            onBase={(b) => select({ base: b })}
          />
        </div>
      </div>
    </section>
  )
}

function RevisionEntry({
  r,
  selected,
  onSelect,
}: {
  r: RevisionSummary
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cx(
        'block w-full px-3 py-2 text-left text-sm hover:bg-surface-2',
        selected && 'bg-accent-soft hover:bg-accent-soft',
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-medium">r{r.revision}</span>
        <Badge>{r.change}</Badge>
      </span>
      <span className="mt-0.5 block truncate text-xs text-muted">
        {r.actor.label} via {r.actor.via}
        {r.actor.client_name && ` (${r.actor.client_name})`}
      </span>
      <span className="block text-xs text-muted">
        <When iso={r.created_at} />
      </span>
    </button>
  )
}

function Compare({
  slug,
  item,
  rev,
  base,
  list,
  onBase,
}: {
  slug: string
  item: ItemJson
  rev: number
  base: number | null
  list: RevisionSummary[]
  onBase: (b: number | null) => void
}) {
  const navigate = useNavigate()
  const canWrite = useCan('editor').allowed
  const next = useRevision(slug, item.handle, rev)
  const prev = useRevision(slug, item.handle, base)
  const older = list.filter((r) => r.revision < rev)
  // the base select must also offer the current base when it is not loaded in the list yet
  const options = [
    ...older.map((r) => ({ value: String(r.revision), label: `r${r.revision} (${r.change})` })),
    ...(base !== null && !older.some((r) => r.revision === base) && base < rev
      ? [{ value: String(base), label: `r${base}` }]
      : []),
    { value: 'none', label: 'nothing (show it whole)' },
  ]

  const restore = (s: RevisionSnapshot) => {
    const fm = s.frontmatter ?? {}
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    const state: RestoreState = {
      revision: s.revision,
      title: s.title,
      body: s.body,
      tags: list(fm.tags),
      anchors: list(fm.anchors),
    }
    navigate(itemPath(slug, item.handle, 'edit'), { state: { restore: state } })
  }

  if (next.isPending) return <Skeleton className="h-64 w-full" />
  if (next.isError) return <ErrorState error={next.error} onRetry={() => next.refetch()} />
  const s = next.data
  const p = base === null ? null : prev.data
  const fm: FmChange[] = p ? frontmatterDiff(p.frontmatter, s.frontmatter) : []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">
            r{s.revision}
            {s.revision === item.revision && <span className="font-normal text-muted"> (current)</span>}
          </h2>
          <p className="text-xs text-muted">
            {s.change} by {s.actor.label} via {s.actor.via}
            {s.actor.client_name && ` (${s.actor.client_name})`}, {dateTime(s.created_at)}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {rev > 1 && (
            <Select
              label="Compare with"
              value={base === null ? 'none' : String(base)}
              options={options}
              onChange={(e) => onBase(e.target.value === 'none' ? null : Number(e.target.value))}
              inputClassName="w-48"
            />
          )}
          {canWrite && s.revision !== item.revision && (
            <Button icon={<RotateCcw className="size-4" aria-hidden="true" />} onClick={() => restore(s)}>
              Restore this version
            </Button>
          )}
        </div>
      </div>

      {base !== null && prev.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : base !== null && prev.isError ? (
        <ErrorState error={prev.error} onRetry={() => prev.refetch()} />
      ) : (
        <>
          <dl className="space-y-1 text-sm">
            <div className="flex flex-wrap gap-2">
              <dt className="text-muted">Title</dt>
              <dd className="min-w-0 break-words">
                {p && p.title !== s.title ? (
                  <>
                    <del className="bg-diff-del">{p.title}</del> →{' '}
                    <ins className="bg-diff-add no-underline">{s.title}</ins>
                  </>
                ) : (
                  s.title
                )}
              </dd>
            </div>
            <div className="flex flex-wrap gap-2">
              <dt className="text-muted">Status</dt>
              <dd>
                {p && p.status !== s.status ? (
                  <>
                    <del className="bg-diff-del">{p.status}</del> →{' '}
                    <ins className="bg-diff-add no-underline">{s.status}</ins>
                  </>
                ) : (
                  s.status
                )}
              </dd>
            </div>
          </dl>

          {p && (
            <section aria-labelledby="fm-heading">
              <h3 id="fm-heading" className="text-sm font-semibold">
                Metadata
              </h3>
              {fm.length === 0 ? (
                <p className="text-sm text-muted">No metadata changes.</p>
              ) : (
                <ul className="mt-1 space-y-1 text-sm">
                  {fm.map((c) => (
                    <li key={c.key} className="break-words">
                      <code className="font-mono text-xs">{c.key}</code>:{' '}
                      {c.kind === 'added' ? (
                        <>
                          added <ins className="bg-diff-add no-underline">{fmText(c.value)}</ins>
                        </>
                      ) : c.kind === 'removed' ? (
                        <>
                          removed <del className="bg-diff-del">{fmText(c.value)}</del>
                        </>
                      ) : c.kind === 'changed' ? (
                        <>
                          <del className="bg-diff-del">{fmText(c.from)}</del> →{' '}
                          <ins className="bg-diff-add no-underline">{fmText(c.to)}</ins>
                        </>
                      ) : (
                        <>
                          {c.added.map((x) => (
                            <ins key={`+${x}`} className="mr-1 bg-diff-add no-underline">
                              +{x}
                            </ins>
                          ))}
                          {c.removed.map((x) => (
                            <del key={`-${x}`} className="mr-1 bg-diff-del">
                              −{x}
                            </del>
                          ))}
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section aria-labelledby="body-heading">
            <h3 id="body-heading" className="mb-1 text-sm font-semibold">
              Body
            </h3>
            <DiffView
              oldText={p ? p.body : null}
              newText={s.body}
              oldLabel={p ? `r${p.revision}` : undefined}
              newLabel={`r${s.revision}`}
            />
          </section>
        </>
      )}
    </div>
  )
}
