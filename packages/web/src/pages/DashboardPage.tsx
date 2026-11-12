/**
 * `/projects/:slug` and `/shared`: counts per space, the status overview (14-day activity and basic numbers),
 * the review queue summary, the last 15 changes from the audit log, the digest preview, the latest agent
 * activity (the last read and write for everyone, the newest requests for admins), and how to connect a
 * repository, a teammate or a new project (api.md §4.1, §7.1, §11.1, ADR-0018).
 *
 * The dashboard query refetches every minute while the tab is visible (`useDashboard`); each refetch also
 * refreshes the project (name and description in the header). A refetch keeps the page on screen.
 */
import { isReleaseVersion, REVIEW_SECTIONS, type ReviewSection } from '@spoor/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { useDashboard, useInstance, useProject } from '../api/hooks'
import { qk } from '../api/keys'
import type { DashboardJson, DashboardRequestJson, LastRequestJson, Space } from '../api/types'
import { useCan } from '../components/RequireRole'
import { dayLabel, fromNow } from '../lib/format'
import { graphPath, isShared, itemPath, projectPath, useProjectSlug } from '../lib/paths'
import { useNow } from '../lib/useNow'
import {
  Badge,
  type BadgeTone,
  Button,
  ButtonLink,
  CopyField,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  StackedBarChart,
} from '../ui'
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
  duplicates: 'Possible duplicates',
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

/** Review counts keyed by section; a section an older server does not count (`push_conflicts`, `duplicates`) reads as 0. */
export function reviewCounts(review: Partial<Record<ReviewSection, number>>): Record<ReviewSection, number> {
  return Object.fromEntries(REVIEW_SECTIONS.map((s) => [s, review[s] ?? 0])) as Record<ReviewSection, number>
}

export function DashboardPage() {
  const slug = useProjectSlug()
  const project = useProject(slug)
  const dash = useDashboard(slug)
  const isAdmin = useCan('admin').allowed
  const isInstanceAdmin = useCan('ia').allowed
  const shared = isShared(slug)
  useRefreshWithDashboard(slug, dash.dataUpdatedAt)

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
      ) : dash.data === undefined ? (
        <ErrorState error={dash.error} onRetry={() => dash.refetch()} />
      ) : (
        <div className="space-y-8">
          <Freshness
            updatedAt={dash.dataUpdatedAt}
            failed={dash.isError}
            refreshing={dash.isFetching}
            onRetry={() => dash.refetch()}
          />
          <Counts slug={slug} counts={dash.data.counts} links={dash.data.links} />
          <Status shared={shared} data={dash.data} />
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <Recent slug={slug} recent={dash.data.recent} />
            <div className="min-w-0 space-y-8">
              {!shared && (
                <LatestActivity
                  slug={slug}
                  last={dash.data.last_requests ?? { read: null, write: null }}
                  activity={dash.data.activity}
                  canOpenLog={isAdmin}
                />
              )}
              <ReviewSummary slug={slug} review={reviewCounts(dash.data.review)} />
            </div>
          </div>
          {!shared && <Connect slug={slug} isAdmin={isAdmin} isInstanceAdmin={isInstanceAdmin} />}
        </div>
      )}
    </section>
  )
}

/** Each dashboard refetch after the first also refreshes the project (the header's name and description). */
function useRefreshWithDashboard(slug: string, updatedAt: number) {
  const qc = useQueryClient()
  const seen = useRef(0)
  useEffect(() => {
    if (updatedAt === 0) return
    if (seen.current !== 0 && seen.current !== updatedAt)
      void qc.invalidateQueries({ queryKey: qk.project(slug) })
    seen.current = updatedAt
  }, [qc, slug, updatedAt])
}

/** "Updated 2 minutes ago", kept current; a failed background refetch says so and keeps the old numbers. */
function Freshness({
  updatedAt,
  failed,
  refreshing,
  onRetry,
}: {
  updatedAt: number
  failed: boolean
  refreshing: boolean
  onRetry: () => void
}) {
  const now = useNow()
  const at = new Date(updatedAt).toISOString()
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
      <span>
        Updated{' '}
        <time dateTime={at} title={at}>
          {fromNow(at, Math.max(now, updatedAt))}
        </time>
        . Refreshes every minute.
      </span>
      {failed && (
        <>
          <span className="text-danger">Could not refresh.</span>
          <Button size="sm" variant="secondary" onClick={onRetry} loading={refreshing}>
            Try again
          </Button>
        </>
      )}
    </p>
  )
}

function Counts({
  slug,
  counts,
  links,
}: {
  slug: string
  counts: DashboardJson['counts']
  links?: DashboardJson['links']
}) {
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
      {links && (links.unlinked_items > 0 || links.dangling_refs > 0) && (
        <p className="mt-3 text-sm text-muted">
          {links.unlinked_items > 0 && (
            <Link to={graphPath(slug, { unlinked: true })} className="text-accent hover:underline">
              {links.unlinked_items} {links.unlinked_items === 1 ? 'item' : 'items'} without links
            </Link>
          )}
          {links.unlinked_items > 0 && links.dangling_refs > 0 && ' · '}
          {links.dangling_refs > 0 && (
            <Link to={graphPath(slug)} className="text-accent hover:underline">
              {links.dangling_refs} dangling {links.dangling_refs === 1 ? 'reference' : 'references'}
            </Link>
          )}
        </p>
      )}
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

const LAST_LABEL = { read: 'Last read', write: 'Last write' } as const

/**
 * The newest agent read and write (any member) and, when the server sends them (project and instance
 * admins, ADR-0018), the newest requests with a link to the full log.
 */
function LatestActivity({
  slug,
  last,
  activity,
  canOpenLog,
}: {
  slug: string
  last: DashboardJson['last_requests']
  activity: DashboardRequestJson[] | undefined
  canOpenLog: boolean
}) {
  return (
    <section aria-labelledby="last-h">
      <h2 id="last-h" className="mb-2 text-base font-semibold">
        Latest activity
      </h2>
      <dl className="divide-y divide-border rounded-md border border-border">
        {(['read', 'write'] as const).map((k) => (
          <div key={k} className="px-3 py-2">
            <dt className="text-sm font-medium">{LAST_LABEL[k]}</dt>
            <dd className="mt-0.5 text-sm text-muted">
              <LastRequest r={last[k]} />
            </dd>
          </div>
        ))}
      </dl>
      {activity && (
        <>
          <h3 id="latest-h" className="mt-4 mb-2 text-sm font-semibold">
            Latest agent requests
          </h3>
          {activity.length === 0 ? (
            <p className="text-sm text-muted">None in the last 14 days.</p>
          ) : (
            <ul aria-labelledby="latest-h" className="divide-y divide-border rounded-md border border-border">
              {activity.map((r) => (
                <RequestRow key={r.id} r={r} />
              ))}
            </ul>
          )}
        </>
      )}
      {canOpenLog && (
        <p className="mt-2 text-sm">
          <Link to={projectPath(slug, 'requests')} className="text-accent underline">
            Request log (14 days)
          </Link>
        </p>
      )}
    </section>
  )
}

function RequestRow({ r }: { r: DashboardRequestJson }) {
  const agent = [r.actor.token_name, r.actor.client_name].filter(Boolean).join(', ')
  return (
    <li className="px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge tone={r.kind === 'write' ? 'accent' : 'neutral'}>{r.kind}</Badge>
        <span className="min-w-0 break-all font-mono text-xs">{r.operation}</span>
        {r.outcome !== 'ok' && <Badge tone="danger">{r.outcome}</Badge>}
        <time dateTime={r.at} title={r.at} className="ml-auto text-muted">
          {fromNow(r.at)}
        </time>
      </div>
      <p className="mt-0.5 break-all text-muted">
        {r.actor.label}
        {agent && ` via ${agent}`}
      </p>
    </li>
  )
}

function LastRequest({ r }: { r: LastRequestJson | null }) {
  if (!r) return <>None in the last 14 days.</>
  return (
    <>
      <time dateTime={r.at} title={r.at} className="text-fg">
        {fromNow(r.at)}
      </time>
      {' · '}
      <span className="font-mono text-xs">{r.operation}</span>
      <span className="block break-all">
        {r.actor.label}
        {r.actor.client_name && ` via ${r.actor.client_name}`}
      </span>
    </>
  )
}

const num = (n: number) => n.toLocaleString('en')

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-bg p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="text-xs text-muted">{hint}</dd>}
    </div>
  )
}

/**
 * Activity overview and basic numbers for every member (counts only). Active, stale and review totals come
 * from the payload's counts, so they show even when an older server sends no `stats`. On `_shared` only the
 * audit-based parts show: it has no request log.
 */
function Status({ shared, data }: { shared: boolean; data: DashboardJson }) {
  const st = data.stats
  const lifecycle = Object.values(data.counts)
  const active = lifecycle.reduce((n, c) => n + c.active, 0)
  const stale = lifecycle.reduce((n, c) => n + c.stale, 0)
  const review = reviewCounts(data.review)
  const open = REVIEW_SECTIONS.reduce((n, s) => n + review[s], 0)
  const req = shared ? null : (st?.requests ?? null)
  const days = st?.per_day.map((d) => ({ ...d, label: dayLabel(d.day) })) ?? []
  const range = st ? `${dayLabel(st.window.from)} to ${dayLabel(st.window.to)}` : ''
  const sum = (k: 'reads' | 'writes' | 'changes') => days.reduce((n, d) => n + d[k], 0)
  return (
    <section aria-labelledby="status-h" className="rounded-md border border-border bg-surface p-4">
      <h2 id="status-h" className="text-base font-semibold">
        Status
      </h2>
      <dl aria-label="Project numbers" className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {req && (
          <>
            <Tile label="Agent requests today" value={num(req.today)} hint="UTC day" />
            <Tile label="Agent requests, 7 days" value={num(req.last_7_days)} />
            <Tile label="Active agents, 14 days" value={num(req.agents_14_days)} hint="tokens and clients" />
          </>
        )}
        {st && (
          <>
            <Tile label="Active people, 14 days" value={num(st.people_14_days)} />
            <Tile label="Items changed, 7 days" value={num(st.items_changed_7_days)} />
          </>
        )}
        <Tile label="Active items" value={num(active)} />
        <Tile label="Stale items" value={num(stale)} />
        <Tile label="In the review queue" value={num(open)} />
        {st && (
          <Tile
            label="Last cleanup"
            value={st.last_cleanup_at ? fromNow(st.last_cleanup_at) : 'never'}
            hint={st.last_cleanup_at ? undefined : 'the cleanup job has not run yet'}
          />
        )}
      </dl>
      {st && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {!shared && (
            <div className="min-w-0">
              <h3 className="mb-2 text-sm font-semibold">Agent requests per day</h3>
              <StackedBarChart
                title="Agent requests per day"
                description={`Agent reads and writes per UTC day, ${range}. ${num(sum('reads'))} reads and ${num(sum('writes'))} writes in total.`}
                series={[
                  { name: 'reads', fill: 'fill-accent', swatch: 'bg-accent' },
                  { name: 'writes', fill: 'fill-warning', swatch: 'bg-warning' },
                ]}
                data={days.map((d) => ({ label: d.label, values: [d.reads, d.writes] }))}
              />
            </div>
          )}
          <div className="min-w-0">
            <h3 className="mb-2 text-sm font-semibold">Item changes per day</h3>
            <StackedBarChart
              title="Item changes per day"
              description={`Item changes (the Recent changes kinds) per UTC day, ${range}. ${num(sum('changes'))} in total.`}
              series={[{ name: 'changes', fill: 'fill-success', swatch: 'bg-success' }]}
              data={days.map((d) => ({ label: d.label, values: [d.changes] }))}
            />
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * How to connect: an agent in a repository (any member), a teammate (project admins add members) and a new
 * project (instance admins). The commands carry this server's URL and CLI version, as install.md does.
 */
function Connect({
  slug,
  isAdmin,
  isInstanceAdmin,
}: {
  slug: string
  isAdmin: boolean
  isInstanceAdmin: boolean
}) {
  const instance = useInstance()
  const installPath = `/p/${encodeURIComponent(slug)}/install.md`
  const server = instance.data?.public_url ?? window.location.origin
  const version = instance.data?.version
  return (
    <section aria-labelledby="connect-h" className="rounded-md border border-border bg-surface p-4">
      <h2 id="connect-h" className="text-base font-semibold">
        Connect
      </h2>
      <div className="mt-3 grid gap-6 lg:grid-cols-3">
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">A repository or your agent</h3>
          {version && isReleaseVersion(version) ? (
            <CopyField label="1. Install the CLI" value={`npm i -g spoor-memory@${version}`} />
          ) : (
            <p className="text-sm text-muted">
              1. Install the CLI: this server is a development build, so build it from source as the install
              guide says.
            </p>
          )}
          <CopyField
            label="2. Sign in from the repository root"
            value={`spoor login --server ${server} --project ${slug}`}
            hint="Approve the code it shows in this browser. A new repository gets .mcp.json, hooks and AGENTS.md: commit them. A repository already set up needs only this step."
          />
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
            <a className="text-accent underline" href={installPath} target="_blank" rel="noreferrer noopener">
              Install guide (install.md)
            </a>
            <Link className="text-accent underline" to={projectPath(slug, 'tokens')}>
              Create a token instead
            </Link>
          </p>
          <p className="text-sm text-muted">Or ask your coding agent to follow the install guide.</p>
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">A new teammate</h3>
          {isAdmin ? (
            <p className="text-sm text-muted">
              Add an existing user, or create an invite link for a new one, on{' '}
              <Link className="text-accent underline" to={projectPath(slug, 'members')}>
                Members
              </Link>
              . Once they have signed in to the web UI, they run the two commands on the left in their copy of
              the repository.
            </p>
          ) : (
            <p className="text-sm text-muted">
              Ask a project admin to add them as a member. Once they have signed in to the web UI, they run
              the two commands on the left in their copy of the repository.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">A new project</h3>
          {isInstanceAdmin ? (
            <p className="text-sm text-muted">
              Create it with <strong>New project</strong> on{' '}
              <Link className="text-accent underline" to="/projects">
                Projects
              </Link>
              , then connect its repository from that project's dashboard.
            </p>
          ) : (
            <p className="text-sm text-muted">
              Instance admins create projects. Each repository connects to one project with the commands on
              the left, using that project's slug.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
