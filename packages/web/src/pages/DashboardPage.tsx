/**
 * `/projects/:slug` and `/shared`: counts per space, the review queue summary, the last 15 changes from the
 * audit log, the digest preview, and for project admins the install hint (api.md §4.1, §7.1, §11.1).
 */
import { REVIEW_SECTIONS, type ReviewSection } from '@spoor/shared'
import { Link } from 'react-router'
import { useDashboard, useProject } from '../api/hooks'
import type { DashboardJson, Space } from '../api/types'
import { useCan } from '../components/RequireRole'
import { fromNow } from '../lib/format'
import { isShared, itemPath, projectPath, useProjectSlug } from '../lib/paths'
import { Badge, type BadgeTone, ButtonLink, EmptyState, ErrorState, PageHeader, Skeleton } from '../ui'
import { DigestPreviewButton } from './DigestPreview'

const SPACES: { space: Space; label: string }[] = [
  { space: 'memories', label: 'Memories' },
  { space: 'decisions', label: 'Decisions' },
  { space: 'docs', label: 'Docs' },
  { space: 'library', label: 'Library' },
]

export const REVIEW_LABEL: Record<ReviewSection, string> = {
  stale: 'Stale',
  archived: 'Recently archived',
  expiring: 'Observations expiring',
  conflicts: 'Conflicts',
  push_conflicts: 'Push conflicts',
}

/** What a `recent` row reports (shared `DASHBOARD_CHANGES`). */
export const CHANGE_LABEL: Record<string, { label: string; tone: BadgeTone }> = {
  create: { label: 'created', tone: 'success' },
  update: { label: 'updated', tone: 'neutral' },
  supersede: { label: 'superseded', tone: 'neutral' },
  push: { label: 'pushed', tone: 'accent' },
  stale: { label: 'went stale', tone: 'warning' },
  archive: { label: 'archived', tone: 'neutral' },
  expire: { label: 'expired', tone: 'warning' },
  restore: { label: 'restored', tone: 'success' },
}

/** Review counts keyed by section; a server that predates `push_conflicts` reads as 0. */
export function reviewCounts(review: Partial<Record<ReviewSection, number>>): Record<ReviewSection, number> {
  return Object.fromEntries(REVIEW_SECTIONS.map((s) => [s, review[s] ?? 0])) as Record<ReviewSection, number>
}

export function DashboardPage() {
  const slug = useProjectSlug()
  const project = useProject(slug)
  const dash = useDashboard(slug)
  const isAdmin = useCan('admin').allowed
  const shared = isShared(slug)

  return (
    <section>
      <PageHeader
        title={shared ? 'Shared knowledge' : (project.data?.name ?? slug)}
        description={project.data?.description || undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            <DigestPreviewButton slug={slug} />
            <ButtonLink to={projectPath(slug, 'search')} variant="secondary">
              Search
            </ButtonLink>
          </div>
        }
      />
      {dash.isPending ? (
        <div className="grid gap-4 md:grid-cols-4" role="status">
          <span className="sr-only">Loading dashboard</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : dash.isError ? (
        <ErrorState error={dash.error} onRetry={() => dash.refetch()} />
      ) : (
        <div className="space-y-8">
          <Counts slug={slug} counts={dash.data.counts} />
          <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
            <Recent slug={slug} recent={dash.data.recent} />
            <div className="space-y-8">
              <ReviewSummary slug={slug} review={reviewCounts(dash.data.review)} />
              {isAdmin && !shared && <InstallHint slug={slug} />}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function Counts({ slug, counts }: { slug: string; counts: DashboardJson['counts'] }) {
  return (
    <section aria-labelledby="counts-h">
      <h2 id="counts-h" className="sr-only">
        Items per space
      </h2>
      <ul className="grid gap-4 md:grid-cols-3">
        {SPACES.map(({ space, label }) => {
          const c = counts[space]
          return (
            <li key={space} className="rounded-md border border-border bg-surface p-4">
              <Link to={projectPath(slug, space)} className="font-medium text-accent hover:underline">
                {label}
              </Link>
              <p className="mt-1 text-3xl font-semibold tabular-nums">
                {c.active}
                <span className="ml-1 text-sm font-normal text-muted">active</span>
              </p>
              <p className="mt-1 flex gap-3 text-sm text-muted">
                <span>{space === 'library' ? 'never stale' : `${c.stale} stale`}</span>
                <span>{c.archived} archived</span>
              </p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function Recent({ slug, recent }: { slug: string; recent: DashboardJson['recent'] }) {
  return (
    <section aria-labelledby="recent-h">
      <h2 id="recent-h" className="mb-2 text-base font-semibold">
        Recent changes
      </h2>
      {recent.length === 0 ? (
        <EmptyState>Nothing has changed yet.</EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {recent.map((r) => {
            const c = CHANGE_LABEL[r.change] ?? { label: r.change, tone: 'neutral' as const }
            return (
              <li
                key={`${r.item.id}-${r.change}-${r.at}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
              >
                <Badge tone={c.tone}>{c.label}</Badge>
                <span className="font-mono text-sm text-muted">{r.item.handle}</span>
                <Link
                  to={itemPath(slug, r.item.handle)}
                  className="min-w-0 flex-1 text-accent hover:underline"
                >
                  {r.item.title}
                </Link>
                <span className="text-sm text-muted">
                  {r.actor.label}
                  {r.actor.via !== 'web' && ` via ${r.actor.client_name ?? r.actor.via}`}
                  {' · '}
                  <time dateTime={r.at} title={r.at}>
                    {fromNow(r.at)}
                  </time>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function ReviewSummary({ slug, review }: { slug: string; review: Record<ReviewSection, number> }) {
  const total = REVIEW_SECTIONS.reduce((n, s) => n + review[s], 0)
  return (
    <section aria-labelledby="review-h">
      <h2 id="review-h" className="mb-2 text-base font-semibold">
        Review queue
      </h2>
      {total === 0 ? (
        <EmptyState>Nothing needs review.</EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {REVIEW_SECTIONS.map((s) => (
            <li key={s} className="flex items-center justify-between px-3 py-2">
              <Link to={projectPath(slug, `review?section=${s}`)} className="text-accent hover:underline">
                {REVIEW_LABEL[s]}
              </Link>
              <Badge tone={review[s] > 0 && s !== 'archived' ? 'warning' : 'neutral'}>{review[s]}</Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function InstallHint({ slug }: { slug: string }) {
  const installPath = `/p/${encodeURIComponent(slug)}/install.md`
  return (
    <section aria-labelledby="install-h" className="rounded-md border border-border bg-surface p-4">
      <h2 id="install-h" className="text-base font-semibold">
        Connect a repository
      </h2>
      <p className="mt-1 text-sm text-muted">
        Point a coding agent at the install guide, and create a token for it to sign in with.
      </p>
      <p className="mt-3 flex flex-wrap gap-2">
        <a
          className="text-sm text-accent underline"
          href={installPath}
          target="_blank"
          rel="noreferrer noopener"
        >
          Install guide (install.md)
        </a>
        <Link className="text-sm text-accent underline" to={projectPath(slug, 'tokens')}>
          Create a token
        </Link>
      </p>
    </section>
  )
}
