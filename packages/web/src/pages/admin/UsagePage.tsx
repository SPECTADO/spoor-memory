/**
 * `/admin/usage` (instance admin): agent traffic of the last 14 UTC days and host resources over time
 * (api.md §10.4, ADR-0033). Traffic is the request log, so MCP and CLI calls only, not web UI use. Resources
 * are the `resource-sample` job's samples. Refreshes every 60 s; the charts are inline SVG (ui/Charts.tsx).
 */
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router'
import { useInstanceUsage } from '../../api/hooks'
import type { ResourceMetric, UsageJson, UsageRange } from '../../api/types'
import { bytes, dateTime, dayLabel, fromNow } from '../../lib/format'
import {
  Button,
  cx,
  EmptyState,
  ErrorState,
  LineChart,
  PageHeader,
  SkeletonRows,
  StackedBarChart,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '../../ui'

const num = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en'))

const METRICS: { key: ResourceMetric; label: string; fmt: (n: number) => string }[] = [
  { key: 'cpu_percent', label: 'Process CPU', fmt: (n) => `${n.toFixed(1)} %` },
  { key: 'load_avg_1', label: 'Load average (1 min)', fmt: (n) => n.toFixed(2) },
  { key: 'rss_bytes', label: 'Memory (RSS)', fmt: bytes },
  { key: 'heap_used_bytes', label: 'Heap used', fmt: bytes },
  { key: 'event_loop_delay_ms', label: 'Event-loop delay (p99)', fmt: (n) => `${n.toFixed(1)} ms` },
  { key: 'db_size_bytes', label: 'Database size', fmt: bytes },
  { key: 'db_connections', label: 'Database connections', fmt: num },
  { key: 'pool_total', label: 'App pool connections', fmt: num },
  { key: 'pool_waiting', label: 'Pool waiting', fmt: num },
  { key: 'mcp_sessions', label: 'Open MCP sessions', fmt: num },
  { key: 'embeddings_pending', label: 'Pending embeddings', fmt: num },
]

const RANGE_TEXT: Record<UsageRange, string> = { '24h': 'last 24 hours', '14d': 'last 14 days' }

function Card({
  title,
  actions,
  busy = false,
  children,
}: {
  title: string
  actions?: ReactNode
  busy?: boolean
  children: ReactNode
}) {
  return (
    <section
      aria-label={title}
      aria-busy={busy || undefined}
      className="min-w-0 rounded-lg border border-border bg-bg p-4"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  )
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-bg p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="text-xs text-muted">{hint}</dd>}
    </div>
  )
}

export function UsagePage() {
  const [range, setRange] = useState<UsageRange>('24h')
  const q = useInstanceUsage(range)
  return (
    <section>
      <PageHeader
        title="Usage"
        description="Agent traffic and host resources of this instance. Refreshes every 60 seconds."
        actions={
          <Button onClick={() => q.refetch()} loading={q.isFetching && !q.isPending}>
            Refresh
          </Button>
        }
      />
      {q.data === undefined ? (
        q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <SkeletonRows rows={6} />
        )
      ) : (
        <>
          {/* a failed background poll keeps the last good numbers on screen */}
          {q.isError && (
            <p role="status" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-danger">Could not refresh.</span>
              <Button size="sm" variant="secondary" onClick={() => q.refetch()} loading={q.isFetching}>
                Try again
              </Button>
            </p>
          )}
          <UsageView u={q.data} range={range} onRange={setRange} loadingRange={q.isPlaceholderData} />
        </>
      )}
    </section>
  )
}

function UsageView({
  u,
  range,
  onRange,
  loadingRange,
}: {
  u: UsageJson
  range: UsageRange
  onRange: (r: UsageRange) => void
  /** The selected range's data is still loading: what is shown is the previous range's. */
  loadingRange: boolean
}) {
  const t = u.totals
  const surface = (s: string) => u.by_surface.find((x) => x.surface === s)
  const mcp = surface('mcp')
  const cli = surface('cli')
  const days = u.per_day.map((d) => ({ ...d, label: dayLabel(d.day) }))
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        Counts come from the agent request log: MCP tool calls and CLI calls. Web UI use is not counted. The
        log keeps {u.window.days} days; days are UTC, from {dayLabel(u.window.from)} to{' '}
        {dayLabel(u.window.to)}.
      </p>

      <dl
        aria-label="Totals for the last 14 days"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      >
        <Tile
          label="Requests"
          value={num(t.requests)}
          hint={`MCP ${num((mcp?.reads ?? 0) + (mcp?.writes ?? 0))} · CLI ${num((cli?.reads ?? 0) + (cli?.writes ?? 0))}`}
        />
        <Tile label="Reads" value={num(t.reads)} hint={`${num(t.searches)} searches`} />
        <Tile label="Writes" value={num(t.writes)} hint={`${num(t.errors)} failed requests`} />
        <Tile
          label="People"
          value={num(t.people)}
          hint={`${num(t.tokens)} tokens, ${num(t.clients)} clients`}
        />
        <Tile label="Active projects" value={num(t.projects)} />
        <Tile label="Revisions written" value={num(t.revisions)} hint="all surfaces, web included" />
        <Tile label="Items created" value={num(t.items_created)} />
      </dl>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Agent requests per day">
          <StackedBarChart
            title="Agent requests per day"
            description={`Reads and writes per UTC day, ${dayLabel(u.window.from)} to ${dayLabel(u.window.to)}. ${num(t.reads)} reads and ${num(t.writes)} writes in total.`}
            series={[
              { name: 'reads', fill: 'fill-accent', swatch: 'bg-accent' },
              { name: 'writes', fill: 'fill-warning', swatch: 'bg-warning' },
            ]}
            data={days.map((d) => ({ label: d.label, values: [d.reads, d.writes] }))}
          />
        </Card>
        <Card title="Content written per day">
          <StackedBarChart
            title="Content written per day"
            description={`Item revisions per UTC day, split into new items and other revisions. ${num(t.revisions)} revisions and ${num(t.items_created)} new items in total.`}
            series={[
              { name: 'new items', fill: 'fill-success', swatch: 'bg-success' },
              { name: 'other revisions', fill: 'fill-accent', swatch: 'bg-accent' },
            ]}
            data={days.map((d) => ({
              label: d.label,
              values: [d.items_created, Math.max(0, d.revisions - d.items_created)],
            }))}
          />
        </Card>
      </div>

      <Resources r={u.resources} range={range} onRange={onRange} loading={loadingRange} />

      {t.requests === 0 ? (
        <EmptyState title="No agent requests in the last 14 days">
          Requests appear here once an agent uses the MCP tools or the CLI.
        </EmptyState>
      ) : (
        <>
          <Table caption="Requests by project" hideCaption={false}>
            <THead>
              <tr>
                <Th>Project</Th>
                <Th className="text-right">Reads</Th>
                <Th className="text-right">Writes</Th>
                <Th>Last request</Th>
              </tr>
            </THead>
            <TBody>
              {u.by_project.map((p) => (
                <Tr key={p.slug}>
                  <Td className="break-words">
                    <Link
                      className="text-accent hover:underline"
                      to={p.slug === '_shared' ? '/shared' : `/projects/${p.slug}`}
                    >
                      {p.name}
                    </Link>{' '}
                    <span className="font-mono text-xs text-muted">{p.slug}</span>
                  </Td>
                  <Td className="text-right tabular-nums">{num(p.reads)}</Td>
                  <Td className="text-right tabular-nums">{num(p.writes)}</Td>
                  <Td title={dateTime(p.last_at)}>{fromNow(p.last_at)}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>

          <div className="grid gap-4 lg:grid-cols-2">
            <Table caption="Requests by operation" hideCaption={false}>
              <THead>
                <tr>
                  <Th>Operation</Th>
                  <Th className="text-right">Requests</Th>
                  <Th className="text-right">Failed</Th>
                  <Th className="text-right">Avg / p95</Th>
                </tr>
              </THead>
              <TBody>
                {u.by_operation.map((o) => (
                  <Tr key={`${o.surface} ${o.operation}`}>
                    <Td>
                      <span className="font-mono break-all">{o.operation}</span>{' '}
                      <span className="text-xs text-muted">
                        {o.surface} {o.kind}
                      </span>
                    </Td>
                    <Td className="text-right tabular-nums">{num(o.requests)}</Td>
                    <Td className={cx('text-right tabular-nums', o.errors > 0 && 'text-danger')}>
                      {num(o.errors)}
                    </Td>
                    <Td className="text-right whitespace-nowrap tabular-nums">{`${o.avg_ms} / ${o.p95_ms} ms`}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <Table caption="Requests by client" hideCaption={false}>
              <THead>
                <tr>
                  <Th>Client</Th>
                  <Th className="text-right">Requests</Th>
                  <Th className="text-right">People</Th>
                </tr>
              </THead>
              <TBody>
                {u.by_client.map((c) => (
                  <Tr key={c.client ?? ''}>
                    <Td className="font-mono break-all">
                      {c.client ?? <span className="font-sans text-muted">unknown</span>}
                    </Td>
                    <Td className="text-right tabular-nums">{num(c.requests)}</Td>
                    <Td className="text-right tabular-nums">{num(c.people)}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
        </>
      )}
    </div>
  )
}

function Resources({
  r,
  range,
  onRange,
  loading,
}: {
  r: UsageJson['resources']
  /** The selected range (the toggle); the charts describe `r.range`, the range the data was fetched for. */
  range: UsageRange
  onRange: (r: UsageRange) => void
  loading: boolean
}) {
  const toggle = (
    <fieldset className="flex gap-1">
      <legend className="sr-only">Time range</legend>
      {(['24h', '14d'] as const).map((v) => (
        <Button
          key={v}
          size="sm"
          variant={v === range ? 'primary' : 'secondary'}
          aria-pressed={v === range}
          onClick={() => onRange(v)}
        >
          {v === '24h' ? '24 hours' : '14 days'}
        </Button>
      ))}
    </fieldset>
  )
  return (
    <Card title="Host resources" actions={toggle} busy={loading}>
      {/* until the selected range arrives the charts still show (and describe) the previous one, dimmed */}
      <div className={loading ? 'opacity-60 transition-opacity' : undefined}>
        {r.samples === 0 ? (
          <EmptyState title="No samples yet">
            The resource-sample job writes one every 5 minutes. It runs only where SPOOR_JOBS=on.
          </EmptyState>
        ) : (
          <>
            <p className="mb-4 text-sm text-muted">
              {`Sampled every ${Math.round(r.interval_s / 60)} minutes on ${r.host ?? 'an unknown host'}. `}
              {`Last sample ${fromNow(r.last_sample_at)}. Each point covers ${Math.round(r.bucket_s / 60)} minutes.`}
            </p>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {METRICS.map((m) => {
                const s = r.metrics[m.key]
                const f = (n: number | null) => (n === null ? '—' : m.fmt(n))
                const of =
                  m.key === 'pool_total'
                    ? ` of ${r.pool_max}`
                    : m.key === 'cpu_percent'
                      ? ` (${r.cpus} CPUs)`
                      : ''
                return (
                  <li key={m.key} className="min-w-0 rounded-md border border-border p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted">{m.label}</span>
                      <span className="text-sm font-semibold tabular-nums">
                        {f(s.current)}
                        {s.current !== null && of && <span className="font-normal text-muted">{of}</span>}
                      </span>
                    </div>
                    <LineChart
                      className="mt-2"
                      title={m.label}
                      description={`${m.label}, ${RANGE_TEXT[r.range]}: now ${f(s.current)}, lowest ${f(s.min)}, highest ${f(s.max)}.`}
                      values={r.points.map((p) => p[m.key])}
                      max={m.key === 'pool_total' ? r.pool_max : undefined}
                    />
                    <div className="mt-1 text-xs text-muted tabular-nums">{`min ${f(s.min)} · max ${f(s.max)}`}</div>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </Card>
  )
}
