/** `/admin/invites` (instance admin, web-ui.md §8): filter by status, create, revoke open invites. */
import { useState } from 'react'
import { flattenPages, useInvites, useProjects, useRevokeInvite } from '../../api/hooks'
import type { InviteJson, InviteStatus } from '../../api/types'
import { dateTime, fromNow } from '../../lib/format'
import {
  Badge,
  type BadgeTone,
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  TBody,
  Td,
  THead,
  Th,
  Tr,
  useToast,
} from '../../ui'
import { InviteDialog } from './InviteDialog'

const STATUS_TONE: Record<InviteStatus, BadgeTone> = {
  open: 'accent',
  used: 'success',
  expired: 'neutral',
  revoked: 'danger',
}

export function InvitesPage() {
  const [status, setStatus] = useState<InviteStatus | ''>('')
  const invites = useInvites(status ? { status } : {})
  const projects = useProjects()
  const revoke = useRevokeInvite()
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const rows = flattenPages(invites.data)

  return (
    <section>
      <PageHeader
        title="Invites"
        description="An invite is a one-time link. There is no email: send the link yourself."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New invite
          </Button>
        }
      />
      <Select
        className="mb-4 max-w-48"
        label="Status"
        value={status}
        onChange={(e) => setStatus(e.target.value as InviteStatus | '')}
        options={[
          { value: '', label: 'All' },
          { value: 'open', label: 'Open' },
          { value: 'used', label: 'Used' },
          { value: 'expired', label: 'Expired' },
          { value: 'revoked', label: 'Revoked' },
        ]}
      />
      {invites.isPending ? (
        <SkeletonRows rows={4} />
      ) : invites.isError ? (
        <ErrorState error={invites.error} onRetry={() => invites.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No invites.">Create one to add a person to the instance or a project.</EmptyState>
      ) : (
        <>
          <Table caption="Invites">
            <THead>
              <tr>
                <Th>Invite</Th>
                <Th>Grants</Th>
                <Th>Status</Th>
                <Th>Created</Th>
                <Th>Expires</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </THead>
            <TBody>
              {rows.map((i) => (
                <InviteRow
                  key={i.id}
                  invite={i}
                  onRevoke={() =>
                    revoke.mutate(i.id, {
                      onSuccess: () => toast.success('Invite revoked.'),
                      onError: (e) => toast.error(e),
                    })
                  }
                />
              ))}
            </TBody>
          </Table>
          {invites.hasNextPage && (
            <div className="mt-3 flex justify-center">
              <Button onClick={() => invites.fetchNextPage()} loading={invites.isFetchingNextPage}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
      <InviteDialog
        open={creating}
        onClose={() => setCreating(false)}
        mode={{
          kind: 'admin',
          projects: (projects.data?.items ?? []).map((p) => ({ slug: p.slug, name: p.name })),
        }}
      />
    </section>
  )
}

function InviteRow({ invite: i, onRevoke }: { invite: InviteJson; onRevoke: () => void }) {
  return (
    <Tr>
      <Td className="min-w-40">
        {i.email ?? <span className="text-muted">any email</span>}
        <div className="mt-0.5 flex flex-wrap gap-1">
          {i.reset && <Badge tone="warning">password reset</Badge>}
          {i.is_admin && <Badge>instance admin</Badge>}
          {i.shared_editor && <Badge>shared editor</Badge>}
        </div>
      </Td>
      <Td>
        {i.grants.length === 0 ? (
          <span className="text-muted">none</span>
        ) : (
          <ul className="space-y-0.5 text-xs">
            {i.grants.map((g) => (
              <li key={g.project.slug}>
                {g.project.name} <Badge>{g.role}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Td>
      <Td>
        <Badge tone={STATUS_TONE[i.status]}>{i.status}</Badge>
      </Td>
      <Td className="whitespace-nowrap" title={dateTime(i.created_at)}>
        {fromNow(i.created_at)}
      </Td>
      <Td className="whitespace-nowrap" title={dateTime(i.expires_at)}>
        {fromNow(i.expires_at)}
      </Td>
      <Td>
        {i.status === 'open' && (
          <Button size="sm" variant="danger" onClick={onRevoke}>
            Revoke
          </Button>
        )}
      </Td>
    </Tr>
  )
}
