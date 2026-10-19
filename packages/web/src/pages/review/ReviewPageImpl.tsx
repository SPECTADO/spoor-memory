/**
 * `/projects/:slug/review?section=` (web-ui.md §7, cleanup-and-jobs.md §6): the five sections of the queue
 * with per-row actions and a bulk Verify / Archive, plus the read-only "Undrafted decisions" tab (decision
 * memories no ADR was drafted from yet). Viewers see the queue without action controls. Every action removes its
 * row optimistically (`useReviewAction`) and rolls back with an error toast on failure.
 */
import type {
  ConflictReviewRow,
  ExpiringReviewRow,
  ItemSummary,
  PushConflictReviewRow,
  ReviewSection,
  StaleReviewRow,
  UndraftedDecision,
} from '@spoor/shared'
import { type ReactNode, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import * as E from '../../api/endpoints'
import {
  flattenPages,
  reviewRowKey,
  useProject,
  useReviewAction,
  useReviewBulk,
  useReviewCounts,
  useReviewSection,
  useUndraftedDecisions,
} from '../../api/hooks'
import { useCan } from '../../components/RequireRole'
import { dateTime, fromNow, plural, relativeSeconds } from '../../lib/format'
import { itemPath, useProjectSlug } from '../../lib/paths'
import {
  Badge,
  Button,
  ButtonLink,
  ConfirmDialog,
  cx,
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
import { PromoteRestoreDialog, SupersedeDialog } from './dialogs'

const SECTIONS: { key: ReviewSection; label: string }[] = [
  { key: 'stale', label: 'Stale' },
  { key: 'archived', label: 'Recently archived' },
  { key: 'expiring', label: 'Expiring observations' },
  { key: 'conflicts', label: 'Conflicts' },
  { key: 'push_conflicts', label: 'Push conflicts' },
]

const SKIP_REASONS: Record<string, string> = {
  not_found: 'not found',
  ambiguous_id: 'ambiguous id',
  read_only_space: 'shared item, read-only here',
  archived: 'archived (restore it first)',
  already_archived: 'already archived',
}

/** Not a review-queue section of api.md §8: its own endpoint, read-only, no bulk actions. */
const UNDRAFTED = { key: 'undrafted', label: 'Undrafted decisions' } as const
type Tab = ReviewSection | typeof UNDRAFTED.key

export function isReviewSection(s: string | null): s is ReviewSection {
  return SECTIONS.some((x) => x.key === s)
}

export function ReviewPageImpl() {
  const slug = useProjectSlug()
  const counts = useReviewCounts(slug)
  const undrafted = useUndraftedDecisions(slug)
  const [params] = useSearchParams()
  const requested = params.get('section')

  if (counts.isPending && !isReviewSection(requested) && requested !== UNDRAFTED.key) {
    return (
      <section>
        <PageHeader title="Review" />
        <SkeletonRows rows={4} />
      </section>
    )
  }
  const c = counts.data?.counts
  const section: Tab =
    requested === UNDRAFTED.key
      ? UNDRAFTED.key
      : isReviewSection(requested)
        ? requested
        : ((c && SECTIONS.find((s) => c[s.key] > 0)?.key) ?? 'stale')
  const tabs: { key: Tab; label: string; count: number | undefined }[] = [
    ...SECTIONS.map((s) => ({ ...s, count: c?.[s.key] })),
    { ...UNDRAFTED, count: undrafted.data?.items.length },
  ]

  return (
    <section>
      <PageHeader
        title="Review"
        description="Memories and docs that need a human look. Nothing here is deleted automatically."
      />
      <nav aria-label="Review sections" className="mb-4">
        <ul className="flex flex-wrap gap-1 border-b border-border">
          {tabs.map((s) => {
            const active = s.key === section
            return (
              <li key={s.key}>
                <Link
                  to={`?section=${s.key}`}
                  replace
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm hover:bg-surface-2',
                    active ? 'border-accent font-medium text-accent' : 'border-transparent',
                  )}
                >
                  {s.label}
                  {s.count !== undefined && (
                    <Badge tone={s.count > 0 ? 'warning' : 'neutral'}>
                      {s.count}
                      <span className="sr-only"> items</span>
                    </Badge>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
      {section === UNDRAFTED.key ? (
        <UndraftedView slug={slug} query={undrafted} />
      ) : (
        <SectionView key={section} slug={slug} section={section} />
      )}
    </section>
  )
}

// ---- undrafted decisions ---------------------------------------------------------------------------------

function UndraftedView({ slug, query }: { slug: string; query: ReturnType<typeof useUndraftedDecisions> }) {
  if (query.isPending) return <SkeletonRows rows={3} />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  const rows: UndraftedDecision[] = query.data.items
  return (
    <>
      <p className="mb-3 text-sm text-muted">
        Decisions agents recorded with <code className="font-mono">spoor_decide</code> in the last 14 days
        that have no ADR yet. An ADR is drafted on a developer's machine (
        <code className="font-mono">spoor adr draft</code>, or the next Stop of a Claude Code session) and
        arrives in the repo as a <code className="font-mono">proposed</code> file for a human to accept.
      </p>
      {rows.length === 0 ? (
        <EmptyState title="Every recent decision has an ADR." />
      ) : (
        <Table caption="Undrafted decisions">
          <THead>
            <tr>
              <Th>Handle</Th>
              <Th>Decision</Th>
              <Th>Recorded</Th>
              <Th>Tags</Th>
            </tr>
          </THead>
          <TBody>
            {rows.map((r) => (
              <Tr key={r.handle}>
                <Td>
                  <Link to={itemPath(slug, r.handle)} className="font-mono text-accent underline">
                    {r.handle}
                  </Link>
                </Td>
                <Td className="min-w-48 break-words">{r.title}</Td>
                <Td className="whitespace-nowrap" title={dateTime(r.created_at)}>
                  {fromNow(r.created_at)}
                </Td>
                <Td className="text-xs text-muted">{r.tags.join(', ') || '—'}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
    </>
  )
}

// ---- one section --------------------------------------------------------------------------------------

function SectionView({ slug, section }: { slug: string; section: ReviewSection }) {
  const query = useReviewSection(slug, section)
  const project = useProject(slug)
  const editor = useCan('editor').allowed
  const admin = useCan('admin').allowed
  if (query.isPending) return <SkeletonRows rows={5} />
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  const rows = flattenPages(query.data) as unknown[]
  const cleanup = project.data?.settings.cleanup
  const loadMore = query.hasNextPage && (
    <div className="mt-3 flex justify-center">
      <Button onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>
        Load more
      </Button>
    </div>
  )
  if (rows.length === 0) {
    return (
      <EmptyState title="Nothing needs review.">
        {cleanup && (
          <span className="text-xs">
            Memories go stale after {plural(cleanup.stale_days, 'day')} without verification and are archived
            after {plural(cleanup.archive_days, 'day')}.
          </span>
        )}
      </EmptyState>
    )
  }
  const common = { slug, canEdit: editor, canDelete: admin }
  return (
    <>
      {section === 'stale' && <StaleSection {...common} rows={rows as StaleReviewRow[]} />}
      {section === 'archived' && <ArchivedSection {...common} rows={rows as ItemSummary[]} />}
      {section === 'expiring' && <ExpiringSection {...common} rows={rows as ExpiringReviewRow[]} />}
      {section === 'conflicts' && <ConflictsSection {...common} rows={rows as ConflictReviewRow[]} />}
      {section === 'push_conflicts' && <PushSection slug={slug} rows={rows as PushConflictReviewRow[]} />}
      {loadMore}
    </>
  )
}

interface SectionProps<R> {
  slug: string
  rows: R[]
  canEdit: boolean
  canDelete: boolean
}

type Run = (rowKeys: string[], fn: () => Promise<unknown>, done?: string) => void

/** Runs a row action with optimistic removal; errors surface as a toast and the row comes back. */
function useRunner(slug: string, section: ReviewSection): Run {
  const toast = useToast()
  const m = useReviewAction(
    slug,
    section,
    (v: { rowKeys: string[]; fn: () => Promise<unknown>; done?: string }) => v.fn(),
    // on the mutation, not on mutate(): removing the last row unmounts this section before the reply
    { onSuccess: (_r, v) => v.done && toast.success(v.done), onError: (e) => toast.error(e) },
  )
  return (rowKeys, fn, done) => m.mutate({ rowKeys, fn, done })
}

function HandleLink({ slug, row }: { slug: string; row: ItemSummary }) {
  return (
    <Link to={itemPath(slug, row.handle)} className="font-mono text-accent underline">
      {row.handle}
    </Link>
  )
}

function TitleCell({ slug, row }: { slug: string; row: ItemSummary }) {
  return (
    <Link to={itemPath(slug, row.handle)} className="hover:underline">
      {row.title}
    </Link>
  )
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-1.5">{children}</div>
}

// ---- selection and bulk -------------------------------------------------------------------------------

function useSelection(rows: ItemSummary[]) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const handles = new Set(rows.map((r) => r.handle))
  const selected = [...picked].filter((h) => handles.has(h))
  return {
    selected,
    has: (h: string) => picked.has(h),
    toggle: (h: string) =>
      setPicked((s) => {
        const n = new Set(s)
        if (!n.delete(h)) n.add(h)
        return n
      }),
    all: rows.length > 0 && selected.length === rows.length,
    toggleAll: () =>
      setPicked(selected.length === rows.length ? new Set() : new Set(rows.map((r) => r.handle))),
    clear: () => setPicked(new Set()),
  }
}

function BulkBar({
  slug,
  section,
  selected,
  onDone,
}: {
  slug: string
  section: ReviewSection
  selected: string[]
  onDone: () => void
}) {
  const toast = useToast()
  // toasts on the mutation itself: archiving every row unmounts this bar before the reply
  const bulk = useReviewBulk(slug, section, {
    onSuccess: (res, { action }) => {
      const verb = action === 'verify' ? 'Verified' : 'Archived'
      toast.show({
        kind: res.skipped.length ? 'info' : 'success',
        message: `${verb} ${plural(res.done.length, 'item')}.`,
        detail: res.skipped.length
          ? `Skipped: ${res.skipped.map((s) => `${s.handle} (${SKIP_REASONS[s.reason] ?? s.reason})`).join(', ')}`
          : undefined,
      })
    },
    onError: (e) => toast.error(e),
  })
  if (selected.length === 0) return null
  const go = (action: 'verify' | 'archive') =>
    bulk.mutate({ action, refs: selected, rowKeys: selected }, { onSuccess: onDone })
  return (
    <section
      aria-label="Bulk actions"
      className="sticky bottom-0 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border-strong bg-surface px-3 py-2 shadow"
    >
      <span className="text-sm">{selected.length} selected</span>
      <Button size="sm" variant="primary" onClick={() => go('verify')} loading={bulk.isPending}>
        Verify
      </Button>
      <Button size="sm" onClick={() => go('archive')} loading={bulk.isPending}>
        Archive now
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone}>
        Clear
      </Button>
    </section>
  )
}

function SelectBox({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      className="size-4 accent-[var(--c-accent)]"
    />
  )
}

// ---- stale ---------------------------------------------------------------------------------------------

function StaleSection({ slug, rows, canEdit, canDelete }: SectionProps<StaleReviewRow>) {
  const run = useRunner(slug, 'stale')
  const sel = useSelection(rows)
  const [superseding, setSuperseding] = useState<StaleReviewRow | null>(null)
  const [deleting, setDeleting] = useState<StaleReviewRow | null>(null)
  return (
    <>
      <Table caption="Stale memories">
        <THead>
          <tr>
            {canEdit && (
              <Th className="w-8">
                <SelectBox checked={sel.all} onChange={sel.toggleAll} label="Select all" />
              </Th>
            )}
            <Th>Handle</Th>
            <Th>Type</Th>
            <Th>Title</Th>
            <Th>Stale since</Th>
            <Th>Last verified</Th>
            <Th>Last used</Th>
            <Th>Auto-archive</Th>
            {canEdit && <Th>Actions</Th>}
          </tr>
        </THead>
        <TBody>
          {rows.map((r) => (
            <Tr key={r.handle}>
              {canEdit && (
                <Td>
                  <SelectBox
                    checked={sel.has(r.handle)}
                    onChange={() => sel.toggle(r.handle)}
                    label={`Select ${r.handle}`}
                  />
                </Td>
              )}
              <Td>
                <HandleLink slug={slug} row={r} />
              </Td>
              <Td>{r.type ?? r.space}</Td>
              <Td className="min-w-48">
                <TitleCell slug={slug} row={r} />
              </Td>
              <Td className="whitespace-nowrap">{fromNow(r.stale_since)}</Td>
              <Td className="whitespace-nowrap">{fromNow(r.last_verified_at)}</Td>
              <Td className="whitespace-nowrap">
                {fromNow(r.last_used_at)}
                {r.used_since_stale && (
                  <>
                    {' '}
                    <Badge tone="accent">used since stale</Badge>
                  </>
                )}
              </Td>
              <Td className="whitespace-nowrap">
                {r.days_to_archive === null ? '—' : plural(r.days_to_archive, 'day')}
              </Td>
              {canEdit && (
                <Td>
                  <Actions>
                    <Button
                      size="sm"
                      onClick={() =>
                        run([r.handle], () => E.itemAction(slug, r.handle, 'verify'), `Verified ${r.handle}.`)
                      }
                    >
                      Verify
                    </Button>
                    <ButtonLink size="sm" to={itemPath(slug, r.handle, 'edit')}>
                      Edit
                    </ButtonLink>
                    {r.space === 'memories' && (
                      <Button size="sm" onClick={() => setSuperseding(r)}>
                        Supersede
                      </Button>
                    )}
                    <Button
                      size="sm"
                      onClick={() =>
                        run(
                          [r.handle],
                          () => E.itemAction(slug, r.handle, 'archive'),
                          `Archived ${r.handle}.`,
                        )
                      }
                    >
                      Archive now
                    </Button>
                    {canDelete && (
                      <Button size="sm" variant="danger" onClick={() => setDeleting(r)}>
                        Delete
                      </Button>
                    )}
                  </Actions>
                </Td>
              )}
            </Tr>
          ))}
        </TBody>
      </Table>
      {canEdit && <BulkBar slug={slug} section="stale" selected={sel.selected} onDone={sel.clear} />}
      <SupersedeDialog
        open={superseding !== null}
        handle={superseding?.handle ?? ''}
        onClose={() => setSuperseding(null)}
        onSubmit={(v) => {
          const r = superseding
          if (!r) return
          setSuperseding(null)
          run(
            [r.handle],
            () =>
              E.supersedeItem(
                slug,
                r.handle,
                'newId' in v
                  ? { new_id: v.newId, revision: r.revision }
                  : { new: { title: v.title, body: v.body }, revision: r.revision },
              ),
            `Superseded ${r.handle}.`,
          )
        }}
      />
      <DeleteDialog
        slug={slug}
        row={deleting}
        onClose={() => setDeleting(null)}
        onConfirm={(r) => {
          setDeleting(null)
          run([r.handle], () => E.deleteItem(slug, r.handle), `Deleted ${r.handle}.`)
        }}
      />
    </>
  )
}

function DeleteDialog({
  row,
  onClose,
  onConfirm,
}: {
  slug: string
  row: ItemSummary | null
  onClose: () => void
  onConfirm: (row: ItemSummary) => void
}) {
  return (
    <ConfirmDialog
      open={row !== null}
      onClose={onClose}
      onConfirm={() => row && onConfirm(row)}
      title={`Delete ${row?.handle ?? ''}?`}
      typeToConfirm={row?.handle ?? ''}
      confirmLabel="Delete"
      danger
    >
      This permanently deletes <strong>{row?.title}</strong> with its history. It cannot be undone.
    </ConfirmDialog>
  )
}

// ---- archived ------------------------------------------------------------------------------------------

function ArchivedSection({ slug, rows, canEdit, canDelete }: SectionProps<ItemSummary>) {
  const run = useRunner(slug, 'archived')
  const [promoting, setPromoting] = useState<ItemSummary | null>(null)
  const [deleting, setDeleting] = useState<ItemSummary | null>(null)
  return (
    <>
      <Table caption="Recently archived">
        <THead>
          <tr>
            <Th>Handle</Th>
            <Th>Title</Th>
            <Th>Reason</Th>
            <Th>Archived</Th>
            {canEdit && <Th>Actions</Th>}
          </tr>
        </THead>
        <TBody>
          {rows.map((r) => (
            <Tr key={r.handle}>
              <Td>
                <HandleLink slug={slug} row={r} />
              </Td>
              <Td className="min-w-48">
                <TitleCell slug={slug} row={r} />
              </Td>
              <Td>
                <Badge tone={r.archive_reason === 'manual' ? 'neutral' : 'warning'}>
                  {r.archive_reason ?? 'unknown'}
                </Badge>
              </Td>
              <Td className="whitespace-nowrap" title={dateTime(r.archived_at)}>
                {fromNow(r.archived_at)}
              </Td>
              {canEdit && (
                <Td>
                  <Actions>
                    <Button
                      size="sm"
                      onClick={() =>
                        r.archive_reason === 'expired'
                          ? setPromoting(r)
                          : run([r.handle], () => E.restoreItem(slug, r.handle), `Restored ${r.handle}.`)
                      }
                    >
                      Restore
                    </Button>
                    {canDelete && (
                      <Button size="sm" variant="danger" onClick={() => setDeleting(r)}>
                        Delete
                      </Button>
                    )}
                  </Actions>
                </Td>
              )}
            </Tr>
          ))}
        </TBody>
      </Table>
      <PromoteRestoreDialog
        open={promoting !== null}
        handle={promoting?.handle ?? ''}
        onClose={() => setPromoting(null)}
        onConfirm={() => {
          const r = promoting
          if (!r) return
          setPromoting(null)
          run(
            [r.handle],
            () => E.restoreItem(slug, r.handle, { promote_to_fact: true, revision: r.revision }),
            `Promoted and restored ${r.handle}.`,
          )
        }}
      />
      <DeleteDialog
        slug={slug}
        row={deleting}
        onClose={() => setDeleting(null)}
        onConfirm={(r) => {
          setDeleting(null)
          run([r.handle], () => E.deleteItem(slug, r.handle), `Deleted ${r.handle}.`)
        }}
      />
    </>
  )
}

// ---- expiring ------------------------------------------------------------------------------------------

function ExpiringSection({ slug, rows, canEdit }: SectionProps<ExpiringReviewRow>) {
  const run = useRunner(slug, 'expiring')
  const sel = useSelection(rows)
  return (
    <>
      <Table caption="Observations expiring within 48 hours">
        <THead>
          <tr>
            {canEdit && (
              <Th className="w-8">
                <SelectBox checked={sel.all} onChange={sel.toggleAll} label="Select all" />
              </Th>
            )}
            <Th>Handle</Th>
            <Th>Title</Th>
            <Th>Expires</Th>
            {canEdit && <Th>Actions</Th>}
          </tr>
        </THead>
        <TBody>
          {rows.map((r) => (
            <Tr key={r.handle}>
              {canEdit && (
                <Td>
                  <SelectBox
                    checked={sel.has(r.handle)}
                    onChange={() => sel.toggle(r.handle)}
                    label={`Select ${r.handle}`}
                  />
                </Td>
              )}
              <Td>
                <HandleLink slug={slug} row={r} />
              </Td>
              <Td className="min-w-48">
                <TitleCell slug={slug} row={r} />
              </Td>
              <Td className="whitespace-nowrap">
                {r.expires_in_s === null ? '—' : relativeSeconds(r.expires_in_s)}
              </Td>
              {canEdit && (
                <Td>
                  <Actions>
                    <Button
                      size="sm"
                      onClick={() =>
                        run(
                          [r.handle],
                          () => E.patchItem(slug, r.handle, { revision: r.revision, type: 'fact' }),
                          `Promoted ${r.handle} to a fact.`,
                        )
                      }
                    >
                      Promote to fact
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        run(
                          [r.handle],
                          () => E.itemAction(slug, r.handle, 'archive'),
                          `Archived ${r.handle}.`,
                        )
                      }
                    >
                      Archive now
                    </Button>
                  </Actions>
                </Td>
              )}
            </Tr>
          ))}
        </TBody>
      </Table>
      {canEdit && <BulkBar slug={slug} section="expiring" selected={sel.selected} onDone={sel.clear} />}
    </>
  )
}

// ---- conflicts -----------------------------------------------------------------------------------------

function ConflictsSection({ slug, rows, canEdit }: SectionProps<ConflictReviewRow>) {
  const run = useRunner(slug, 'conflicts')
  // supersede is for two memories of this very project (no `S:` ends)
  const local = (i: ItemSummary) => i.project === slug && i.space === 'memories' && !i.handle.startsWith('S:')
  return (
    <ul className="space-y-3">
      {rows.map((r) => {
        const key = reviewRowKey(r)
        const both = local(r.a) && local(r.b)
        return (
          <li key={key} className="rounded-md border border-border p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <ConflictSide slug={slug} label="A" item={r.a} />
              <ConflictSide slug={slug} label="B" item={r.b} />
            </div>
            {canEdit && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {both && (
                  <>
                    <Button
                      size="sm"
                      onClick={() =>
                        run(
                          [key],
                          () => E.supersedeItem(slug, r.b.handle, { new_id: r.a.handle }),
                          `Kept ${r.a.handle}; ${r.b.handle} is superseded.`,
                        )
                      }
                    >
                      Keep A
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        run(
                          [key],
                          () => E.supersedeItem(slug, r.a.handle, { new_id: r.b.handle }),
                          `Kept ${r.b.handle}; ${r.a.handle} is superseded.`,
                        )
                      }
                    >
                      Keep B
                    </Button>
                  </>
                )}
                <Button
                  size="sm"
                  onClick={() => run([key], () => E.removeEdge(slug, r.edge_id), 'Relation removed.')}
                >
                  Remove relation
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    run(
                      [key],
                      () => E.reviewBulk(slug, { action: 'verify', refs: [r.a.handle, r.b.handle] }),
                      'Verified both.',
                    )
                  }
                >
                  Verify both
                </Button>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function ConflictSide({ slug, label, item }: { slug: string; label: string; item: ItemSummary }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold text-muted uppercase">Side {label}</p>
      <p className="mt-0.5 break-words">
        <HandleLink slug={slug} row={item} /> <span className="font-medium">{item.title}</span>
      </p>
      <p className="mt-1 text-xs text-muted">
        {item.type ?? item.space}
        {item.confidence ? `, confidence ${item.confidence}` : ''}, verified {fromNow(item.last_verified_at)}
      </p>
    </div>
  )
}

// ---- push conflicts ------------------------------------------------------------------------------------

function PushSection({ slug, rows }: { slug: string; rows: PushConflictReviewRow[] }) {
  return (
    <>
      <p className="mb-3 text-sm text-muted">
        A repo push was refused because the item was edited in Spoor. A human resolves it from a terminal:{' '}
        <code className="font-mono">spoor adr push --force &lt;file&gt;</code> (or{' '}
        <code className="font-mono">spoor docs push --force &lt;file&gt;</code>), or bring the file in line
        and push again.
      </p>
      <Table caption="Push conflicts">
        <THead>
          <tr>
            <Th>Handle</Th>
            <Th>Title</Th>
            <Th>Source path</Th>
            <Th>Edited in Spoor by</Th>
            <Th>Refused</Th>
            <Th>Compare</Th>
          </tr>
        </THead>
        <TBody>
          {rows.map((r) => (
            <Tr key={r.handle}>
              <Td>
                <HandleLink slug={slug} row={r} />
              </Td>
              <Td className="min-w-48">
                <TitleCell slug={slug} row={r} />
              </Td>
              <Td className="font-mono text-xs break-all">{r.source_path ?? '—'}</Td>
              <Td>
                {r.edited_by.label}
                {r.edited_by.via ? <span className="text-muted"> via {r.edited_by.via}</span> : null}
              </Td>
              <Td className="whitespace-nowrap" title={dateTime(r.push_conflict_at)}>
                {fromNow(r.push_conflict_at)}
              </Td>
              <Td>
                <Link to={itemPath(slug, r.handle, 'history')} className="text-accent underline">
                  History
                </Link>
              </Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </>
  )
}
