/** The project and instance audit logs (web-ui.md §8): filters, cursor paging, expandable `data`. */
import { AUDIT_VIAS } from '@spoor/shared'
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router'
import { flattenPages, useInstanceAudit, useProjectAudit } from '../../api/hooks'
import type { AuditFilters, AuditRowJson } from '../../api/types'
import { dateTime } from '../../lib/format'
import { itemPath } from '../../lib/paths'
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Input,
  Select,
  SkeletonRows,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
} from '../../ui'

const ACTION_PREFIXES = ['item.', 'edge.', 'member.', 'token.', 'project.', 'device.']

interface Draft {
  action: string
  actor: string
  via: string
  since: string
  until: string
}
const EMPTY: Draft = { action: '', actor: '', via: '', since: '', until: '' }

/** Local midnight of a `YYYY-MM-DD` date as an ISO instant; `until` is exclusive, so it is the next midnight. */
function dayStart(date: string, plusDays = 0): string | undefined {
  if (!date) return undefined
  const d = new Date(`${date}T00:00:00`)
  if (Number.isNaN(d.getTime())) return undefined
  d.setDate(d.getDate() + plusDays)
  return d.toISOString()
}

export function toFilters(d: Draft): Omit<AuditFilters, 'cursor'> {
  return {
    action: d.action ? [d.action] : undefined,
    actor: d.actor.trim() || undefined,
    via: (d.via || undefined) as AuditFilters['via'],
    since: dayStart(d.since),
    until: dayStart(d.until, 1),
  }
}

const INSTANCE_ACTION_PREFIXES = ['user.', 'invite.', 'project.', 'job.']

/** The project audit log of `slug`. */
export function AuditPanel({ slug }: { slug: string }) {
  const [applied, setApplied] = useState<Draft>(EMPTY)
  const audit = useProjectAudit(slug, toFilters(applied))
  return (
    <section aria-label="Audit log">
      <h2 className="text-base font-semibold">Audit log</h2>
      <AuditFilterForm prefixes={ACTION_PREFIXES} onApply={setApplied} />
      <AuditResults audit={audit} slug={slug} />
    </section>
  )
}

/** The instance-level audit log (`/admin/audit`): users, invites, projects, jobs. */
export function InstanceAuditPanel() {
  const [applied, setApplied] = useState<Draft>(EMPTY)
  const audit = useInstanceAudit(toFilters(applied))
  return (
    <section aria-label="Instance audit log">
      <AuditFilterForm prefixes={INSTANCE_ACTION_PREFIXES} onApply={setApplied} />
      <AuditResults audit={audit} />
    </section>
  )
}

function AuditFilterForm({ prefixes, onApply }: { prefixes: string[]; onApply: (d: Draft) => void }) {
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const set = (k: keyof Draft) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    onApply(draft)
  }
  return (
    <form onSubmit={submit} className="mt-4 flex flex-wrap items-end gap-3">
      <Select
        label="Action"
        value={draft.action}
        onChange={set('action')}
        options={[{ value: '', label: 'All' }, ...prefixes.map((p) => ({ value: p, label: `${p}*` }))]}
      />
      <Input label="Actor contains" value={draft.actor} onChange={set('actor')} autoComplete="off" />
      <Select
        label="Via"
        value={draft.via}
        onChange={set('via')}
        options={[{ value: '', label: 'Any' }, ...AUDIT_VIAS.map((v) => ({ value: v, label: v }))]}
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

function AuditResults({
  audit,
  slug,
}: {
  audit: ReturnType<typeof useProjectAudit> | ReturnType<typeof useInstanceAudit>
  slug?: string
}) {
  const rows = flattenPages(audit.data)
  return (
    <div className="mt-4">
      {audit.isPending ? (
        <SkeletonRows rows={5} />
      ) : audit.isError ? (
        <ErrorState error={audit.error} onRetry={() => audit.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No audit rows match." />
      ) : (
        <>
          <AuditTable rows={rows} slug={slug} />
          {audit.hasNextPage && (
            <div className="mt-3 flex justify-center">
              <Button onClick={() => audit.fetchNextPage()} loading={audit.isFetchingNextPage}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Rows of an audit list; `slug` makes item handles links (omit for the instance log). */
export function AuditTable({ rows, slug }: { rows: AuditRowJson[]; slug?: string }) {
  return (
    <Table caption="Audit log">
      <THead>
        <tr>
          <Th>Time</Th>
          <Th>Actor</Th>
          <Th>Action</Th>
          <Th>Item</Th>
          <Th>Summary</Th>
        </tr>
      </THead>
      <TBody>
        {rows.map((r) => (
          <Tr key={r.id}>
            <Td className="whitespace-nowrap">{dateTime(r.at)}</Td>
            <Td>
              <div className="break-all">{r.actor.label}</div>
              <div className="mt-0.5 flex flex-wrap gap-1">
                <Badge>{r.actor.via}</Badge>
                {r.actor.client_name && <span className="text-xs text-muted">{r.actor.client_name}</span>}
              </div>
            </Td>
            <Td className="font-mono text-xs">{r.action}</Td>
            <Td>
              {r.item_handle ? (
                slug && r.item_id ? (
                  <Link to={itemPath(slug, r.item_handle)} className="font-mono text-accent underline">
                    {r.item_handle}
                  </Link>
                ) : (
                  <span className="font-mono">{r.item_handle}</span>
                )
              ) : (
                '—'
              )}
            </Td>
            <Td className="min-w-48">
              <div>{r.summary}</div>
              {Object.keys(r.data).length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-accent">Data</summary>
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
