/**
 * `/admin/status` (instance admin): what this deployment runs and holds — version, embedding providers,
 * record counts, database size, runtime stats (api.md §10.4). Read-only; refreshes every 15 s.
 */
import type { ReactNode } from 'react'
import { useInstanceStatus } from '../../api/hooks'
import type { InstanceStatusJson } from '../../api/types'
import { dateTime, duration } from '../../lib/format'
import {
  Alert,
  Badge,
  Button,
  cx,
  ErrorState,
  PageHeader,
  SkeletonRows,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '../../ui'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** `1536000` → "1.5 MB" (1024-based). */
export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  let v = n
  let i = 0
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024
    i++
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${UNITS[i]}`
}

const num = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en'))

/** Uptime: "3 d 4 h", "5 hours", "12 minutes". */
function uptime(s: number): string {
  if (s < 86_400) return duration(s)
  return `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3_600)} h`
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-lg border border-border bg-bg p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">{children}</dl>
}

function Fact({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className={cx('min-w-0 break-words', mono && 'font-mono')}>{children}</dd>
    </>
  )
}

const SPACES = ['memories', 'decisions', 'docs', 'library']

function ItemsTable({ items }: { items: InstanceStatusJson['records']['items'] }) {
  const lifecycles = [...new Set(Object.values(items).flatMap((l) => Object.keys(l)))].sort()
  const spaces = [...SPACES, ...Object.keys(items).filter((s) => !SPACES.includes(s))]
  if (lifecycles.length === 0) return <p className="text-sm text-muted">No items yet.</p>
  return (
    <Table caption="Items by space and lifecycle">
      <THead>
        <tr>
          <Th>Space</Th>
          {lifecycles.map((l) => (
            <Th key={l} className="text-right">
              {l}
            </Th>
          ))}
        </tr>
      </THead>
      <TBody>
        {spaces.map((s) => (
          <Tr key={s}>
            <Td>{s}</Td>
            {lifecycles.map((l) => (
              <Td key={l} className="text-right tabular-nums">
                {num(items[s]?.[l] ?? 0)}
              </Td>
            ))}
          </Tr>
        ))}
      </TBody>
    </Table>
  )
}

export function StatusPage() {
  const q = useInstanceStatus()
  return (
    <section>
      <PageHeader
        title="Status"
        description="What this deployment runs and holds. Refreshes every 15 seconds."
        actions={
          <Button onClick={() => q.refetch()} loading={q.isFetching && !q.isPending}>
            Refresh
          </Button>
        }
      />
      {q.isPending ? (
        <SkeletonRows rows={6} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <StatusView s={q.data} />
      )}
    </section>
  )
}

function StatusView({ s }: { s: InstanceStatusJson }) {
  const { instance: i, embedding: e, records: r, database: d, runtime: rt } = s
  const pending = r.chunks_pending
  const reembedding = e.projects_by_model.reduce((a, m) => a + m.reembedding, 0)
  return (
    <div className="space-y-6">
      {!i.jobs_enabled && (
        <Alert tone="warning">
          The scheduler is disabled on this instance (SPOOR_JOBS=off): pending embeddings and cleanup do not
          run.
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Installation">
          <Facts>
            <Fact label="Version" mono>
              {i.version}
            </Fact>
            <Fact label="Public URL" mono>
              {i.public_url}
            </Fact>
            <Fact label="Started">
              {dateTime(i.started_at)} (up {uptime(i.uptime_s)})
            </Fact>
            <Fact label="Node.js" mono>
              {i.node}
            </Fact>
            <Fact label="Platform" mono>
              {i.platform}
            </Fact>
            <Fact label="Host" mono>
              {i.hostname}
            </Fact>
            <Fact label="Jobs">{i.jobs_enabled ? 'on' : 'off'}</Fact>
          </Facts>
        </Card>
        <Card title="Embedding">
          <Facts>
            <Fact label="Default provider">{e.default.name}</Fact>
            <Fact label="Model" mono>
              {e.default.model}
            </Fact>
            <Fact label="Variant">{e.default.variant || '—'}</Fact>
            <Fact label="Dimensions">{e.default.dims}</Fact>
            <Fact label="Max input tokens">{e.default.max_input_tokens}</Fact>
            <Fact label="Tag" mono>
              <span className="break-all">{e.default.tag}</span>
            </Fact>
            {e.default.name === 'local' && <Fact label="Worker threads">{e.local_threads}</Fact>}
            <Fact label="Enabled providers">
              <span className="flex flex-wrap gap-1">
                {e.providers.map((p) => (
                  <Badge key={p.tag} tone={p.tag === e.default.tag ? 'accent' : 'neutral'}>
                    {p.name}
                    {p.remote ? ' (remote)' : ''}
                  </Badge>
                ))}
              </span>
            </Fact>
            <Fact label="Pending">
              {pending > 0 ? <Badge tone="warning">{num(pending)} chunks</Badge> : 'none'}
            </Fact>
            {reembedding > 0 && (
              <Fact label="Re-embedding">
                {reembedding} project{reembedding === 1 ? '' : 's'}
              </Fact>
            )}
          </Facts>
        </Card>
        <Card title="Records">
          <Facts>
            <Fact label="Projects">{num(r.projects)}</Fact>
            <Fact label="Users">{`${num(r.users_active)} active of ${num(r.users)}`}</Fact>
            <Fact label="Memberships">{num(r.memberships)}</Fact>
            <Fact label="API tokens (valid)">{num(r.tokens_active)}</Fact>
            <Fact label="Web sessions">{num(r.web_sessions)}</Fact>
            <Fact label="Items">{num(r.items_total)}</Fact>
            <Fact label="Revisions">{num(r.revisions)}</Fact>
            <Fact label="Links">{num(r.edges)}</Fact>
            <Fact label="Chunks">{num(r.chunks)}</Fact>
            <Fact label="Audit rows">{num(r.audit_rows)}</Fact>
            <Fact label="Request log rows">{num(r.request_log_rows)}</Fact>
            <Fact label="Job runs">{num(r.job_runs)}</Fact>
          </Facts>
        </Card>
        <Card title="Database">
          <Facts>
            <Fact label="PostgreSQL" mono>
              {d.version ?? '—'}
            </Fact>
            <Fact label="Database" mono>
              {d.name ?? '—'}
            </Fact>
            <Fact label="Size">{bytes(d.size_bytes)}</Fact>
            <Fact label="Connections">{num(d.connections)}</Fact>
            <Fact label="App pool">
              {`${num(d.pool.total)} open, ${num(d.pool.idle)} idle, ${num(d.pool.waiting)} waiting (max ${d.pool.max})`}
            </Fact>
            <Fact label="Extensions" mono>
              {d.extensions.map((x) => `${x.name} ${x.version}`).join(', ') || '—'}
            </Fact>
          </Facts>
        </Card>
        <Card title="Runtime">
          <Facts>
            <Fact label="Memory (RSS)">{bytes(rt.rss_bytes)}</Fact>
            <Fact label="Heap">{`${bytes(rt.heap_used_bytes)} of ${bytes(rt.heap_total_bytes)}`}</Fact>
            <Fact label="External">{bytes(rt.external_bytes)}</Fact>
            <Fact label="Load average">{rt.load_avg.map((l) => l.toFixed(2)).join(' / ')}</Fact>
            <Fact label="CPUs">{rt.cpus}</Fact>
            <Fact label="System memory">
              {`${bytes(rt.system_free_bytes)} free of ${bytes(rt.system_memory_bytes)}`}
            </Fact>
            <Fact label="MCP sessions">{num(rt.mcp_sessions)}</Fact>
          </Facts>
        </Card>
        <Card title="Items">
          <ItemsTable items={r.items} />
        </Card>
      </div>

      <Table caption="Chunks per embedding model" hideCaption={false}>
        <THead>
          <tr>
            <Th>Model tag</Th>
            <Th className="text-right">Dims</Th>
            <Th className="text-right">Chunks</Th>
            <Th className="text-right">Pending</Th>
            <Th className="text-right">Projects</Th>
          </tr>
        </THead>
        <TBody>
          {e.chunks.length === 0 ? (
            <Tr>
              <Td colSpan={5} className="text-muted">
                No chunks yet.
              </Td>
            </Tr>
          ) : (
            e.chunks.map((c) => (
              <Tr key={c.model}>
                <Td className="font-mono break-all">{c.model}</Td>
                <Td className="text-right tabular-nums">{c.dims}</Td>
                <Td className="text-right tabular-nums">{num(c.chunks)}</Td>
                <Td className="text-right tabular-nums">{num(c.pending)}</Td>
                <Td className="text-right tabular-nums">
                  {num(e.projects_by_model.find((m) => m.model === c.model)?.projects ?? 0)}
                </Td>
              </Tr>
            ))
          )}
        </TBody>
      </Table>

      <Table caption="Table sizes" hideCaption={false}>
        <THead>
          <tr>
            <Th>Table</Th>
            <Th className="text-right">Rows (estimate)</Th>
            <Th className="text-right">Size (incl. indexes)</Th>
          </tr>
        </THead>
        <TBody>
          {d.tables.map((t) => (
            <Tr key={t.name}>
              <Td className="font-mono">{t.name}</Td>
              <Td className="text-right tabular-nums">{num(t.rows_estimate)}</Td>
              <Td className="text-right tabular-nums">{bytes(t.bytes)}</Td>
            </Tr>
          ))}
        </TBody>
      </Table>
    </div>
  )
}
