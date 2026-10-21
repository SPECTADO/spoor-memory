/**
 * `/projects/:slug/requests`: the agent request log (api.md §10.3, ADR-0018), every MCP tool call and CLI
 * call of the last 14 days with who, which token and agent, what was read or written, and the outcome.
 * Project admins and instance admins only (the server answers 403 to anyone else).
 */
import { REQUEST_KINDS, REQUEST_LOG_KEEP_DAYS, REQUEST_SURFACES } from '@spoor/shared'
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router'
import { flattenPages, useProjectRequests } from '../api/hooks'
import type { RequestFilters, RequestRowJson } from '../api/types'
import { RequireRole } from '../components/RequireRole'
import { dateTime } from '../lib/format'
import { itemPath, useProjectSlug } from '../lib/paths'
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '../ui'
import { dayStart } from './settings/AuditPanel'

interface Draft {
  kind: string
  surface: string
  actor: string
  since: string
  until: string
}
const EMPTY: Draft = { kind: '', surface: '', actor: '', since: '', until: '' }

export function toRequestFilters(d: Draft): Omit<RequestFilters, 'cursor'> {
  return {
    kind: (d.kind || undefined) as RequestFilters['kind'],
    surface: (d.surface || undefined) as RequestFilters['surface'],
    actor: d.actor.trim() || undefined,
    since: dayStart(d.since),
    until: dayStart(d.until, 1),
  }
}

export function RequestLogPage() {
  return (
    <RequireRole gate="admin">
      <RequestLog />
    </RequireRole>
  )
}

function RequestLog() {
  const slug = useProjectSlug()
  const [applied, setApplied] = useState<Draft>(EMPTY)
  const requests = useProjectRequests(slug, toRequestFilters(applied))
  const rows = flattenPages(requests.data)
  return (
    <section>
      <PageHeader
        title="Request log"
        description={`Every agent read and write over MCP and the spoor CLI, kept ${REQUEST_LOG_KEEP_DAYS} days. Visible to project admins only.`}
      />
      <FilterForm onApply={setApplied} />
      <div className="mt-4">
        {requests.isPending ? (
          <SkeletonRows rows={5} />
        ) : requests.isError ? (
          <ErrorState error={requests.error} onRetry={() => requests.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState title="No requests match." />
        ) : (
          <>
            <RequestTable rows={rows} slug={slug} />
            {requests.hasNextPage && (
              <div className="mt-3 flex justify-center">
                <Button onClick={() => requests.fetchNextPage()} loading={requests.isFetchingNextPage}>
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function FilterForm({ onApply }: { onApply: (d: Draft) => void }) {
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const set = (k: keyof Draft) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onApply(draft)
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <Select
        label="Kind"
        value={draft.kind}
        onChange={set('kind')}
        options={[{ value: '', label: 'Any' }, ...REQUEST_KINDS.map((v) => ({ value: v, label: v }))]}
      />
      <Select
        label="Via"
        value={draft.surface}
        onChange={set('surface')}
        options={[{ value: '', label: 'Any' }, ...REQUEST_SURFACES.map((v) => ({ value: v, label: v }))]}
      />
      <Input
        label="Actor, token or agent contains"
        value={draft.actor}
        onChange={set('actor')}
        autoComplete="off"
      />
      <Input label="From" type="date" value={draft.since} onChange={set('since')} />
      <Input label="To (inclusive)" type="date" value={draft.until} onChange={set('until')} />
      <Button type="submit" variant="primary">
        Apply filters
      </Button>
      <Button
        onClick={() => {
          setDraft(EMPTY)
          onApply(EMPTY)
        }}
      >
        Clear
      </Button>
    </form>
  )
}

export function RequestTable({ rows, slug }: { rows: RequestRowJson[]; slug: string }) {
  return (
    <Table caption="Request log">
      <THead>
        <tr>
          <Th>Time</Th>
          <Th>Actor</Th>
          <Th>Request</Th>
          <Th>Items</Th>
          <Th>Query</Th>
        </tr>
      </THead>
      <TBody>
        {rows.map((r) => (
          <Tr key={r.id}>
            <Td className="whitespace-nowrap">{dateTime(r.at)}</Td>
            <Td>
              <div className="break-all">{r.actor.label}</div>
              {r.actor.token.name && (
                <div className="text-xs text-muted">
                  token {r.actor.token.name}
                  {r.actor.token.prefix && <span className="font-mono"> ({r.actor.token.prefix}…)</span>}
                </div>
              )}
              {r.actor.client_name && <div className="text-xs text-muted">{r.actor.client_name}</div>}
            </Td>
            <Td>
              <div className="flex flex-wrap items-center gap-1">
                <Badge tone={r.kind === 'write' ? 'accent' : 'neutral'}>{r.kind}</Badge>
                <Badge>{r.surface}</Badge>
                {r.outcome !== 'ok' && <Badge tone="danger">{r.outcome}</Badge>}
              </div>
              <div className="mt-0.5 font-mono text-xs">{r.operation}</div>
              <div className="text-xs text-muted">{r.duration_ms} ms</div>
            </Td>
            <Td>
              {(r.space || r.memory_type) && (
                <div className="text-xs text-muted">
                  {[r.space, r.memory_type].filter(Boolean).join(' · ')}
                </div>
              )}
              {r.handles.length > 0 ? (
                <div className="flex max-w-xs flex-wrap gap-x-2 font-mono text-xs">
                  {r.handles.map((h) =>
                    h.startsWith('S:') ? (
                      <span key={h}>{h}</span>
                    ) : (
                      <Link key={h} to={itemPath(slug, h)} className="text-accent underline">
                        {h}
                      </Link>
                    ),
                  )}
                </div>
              ) : (
                !r.space && !r.memory_type && '—'
              )}
            </Td>
            <Td className="min-w-48">
              {r.query ? <div className="break-words">{r.query}</div> : <span className="text-muted">—</span>}
              {Object.keys(r.data).length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-accent">Details</summary>
                  <pre className="mt-1 max-w-md overflow-x-auto rounded bg-surface p-2 text-xs">
                    {JSON.stringify(r.data, null, 2)}
                  </pre>
                </details>
              )}
            </Td>
          </Tr>
        ))}
      </TBody>
    </Table>
  )
}
