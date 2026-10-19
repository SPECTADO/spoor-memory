/**
 * `/admin/users` (instance admin, web-ui.md §8): search, flags, disable, delete and reset invites.
 * `last_admin` and every other error of a row action show inline above the table.
 */
import { useEffect, useState } from 'react'
import { isApiError } from '../../api/client'
import { flattenPages, useDeleteUser, usePatchUser, useUsers } from '../../api/hooks'
import type { AdminUserJson, UserPatchBody } from '../../api/types'
import { dateTime } from '../../lib/format'
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
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
import { InviteDialog } from './InviteDialog'

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export function UsersPage() {
  const [q, setQ] = useState('')
  const debounced = useDebounced(q.trim(), 250)
  const users = useUsers(debounced ? { q: debounced } : {})
  const patch = usePatchUser()
  const del = useDeleteUser()
  const toast = useToast()
  const [reset, setReset] = useState<AdminUserJson | null>(null)
  const [deleting, setDeleting] = useState<AdminUserJson | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  const rows = flattenPages(users.data)
  const update = (u: AdminUserJson, body: UserPatchBody, done: string) => {
    setRowError(null)
    patch.mutate(
      { id: u.id, body },
      {
        onSuccess: () => toast.success(done),
        onError: (e) =>
          setRowError(
            isApiError(e, 'last_admin')
              ? `${u.email}: ${e.message || 'this would leave the instance without an admin.'}`
              : `${u.email}: ${e instanceof Error ? e.message : 'The change failed.'}`,
          ),
      },
    )
  }

  return (
    <section>
      <PageHeader title="Users" description="People are added through invites (Invites page)." />
      <search className="mb-4 max-w-sm">
        <Input
          label="Search users"
          hideLabel
          type="search"
          placeholder="Search by name or email"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </search>
      {rowError && (
        <Alert tone="danger" className="mb-4">
          {rowError}
        </Alert>
      )}
      {users.isPending ? (
        <SkeletonRows rows={5} />
      ) : users.isError ? (
        <ErrorState error={users.error} onRetry={() => users.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No users match." />
      ) : (
        <>
          <Table caption="Users">
            <THead>
              <tr>
                <Th>User</Th>
                <Th>Projects</Th>
                <Th>Instance admin</Th>
                <Th>Shared editor</Th>
                <Th>Status</Th>
                <Th>Actions</Th>
              </tr>
            </THead>
            <TBody>
              {rows.map((u) => (
                <Tr key={u.id}>
                  <Td className="min-w-48">
                    <div className="font-medium">{u.name}</div>
                    <div className="text-xs text-muted break-all">{u.email}</div>
                  </Td>
                  <Td>
                    {u.memberships.length === 0 ? (
                      <span className="text-muted">none</span>
                    ) : (
                      <ul className="space-y-0.5">
                        {u.memberships.map((m) => (
                          <li key={m.project.slug} className="text-xs">
                            {m.project.name} <Badge>{m.role}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Td>
                  <Td>
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--c-accent)]"
                      aria-label={`Instance admin: ${u.email}`}
                      checked={u.is_admin}
                      onChange={(e) =>
                        update(
                          u,
                          { is_admin: e.target.checked },
                          e.target.checked ? 'Made instance admin.' : 'Admin removed.',
                        )
                      }
                    />
                  </Td>
                  <Td>
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--c-accent)]"
                      aria-label={`Shared editor: ${u.email}`}
                      checked={u.shared_editor}
                      onChange={(e) =>
                        update(
                          u,
                          { shared_editor: e.target.checked },
                          e.target.checked ? 'Shared editor enabled.' : 'Shared editor removed.',
                        )
                      }
                    />
                  </Td>
                  <Td>
                    {u.disabled_at ? (
                      <Badge tone="danger">disabled {dateTime(u.disabled_at)}</Badge>
                    ) : (
                      <Badge tone="success">active</Badge>
                    )}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        size="sm"
                        onClick={() =>
                          update(
                            u,
                            { disabled: !u.disabled_at },
                            u.disabled_at ? 'User enabled.' : 'User disabled; their sessions ended.',
                          )
                        }
                      >
                        {u.disabled_at ? 'Enable' : 'Disable'}
                      </Button>
                      <Button size="sm" onClick={() => setReset(u)}>
                        Create reset invite
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setDeleting(u)}>
                        Delete
                      </Button>
                    </div>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          {users.hasNextPage && (
            <div className="mt-3 flex justify-center">
              <Button onClick={() => users.fetchNextPage()} loading={users.isFetchingNextPage}>
                Load more
              </Button>
            </div>
          )}
        </>
      )}
      <InviteDialog
        open={reset !== null}
        onClose={() => setReset(null)}
        mode={{ kind: 'reset', user: { id: reset?.id ?? '', email: reset?.email ?? '' } }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.email ?? ''}?`}
        typeToConfirm={deleting?.email ?? ''}
        confirmLabel="Delete user"
        danger
        pending={del.isPending}
        error={del.error ? del.error.message : undefined}
        onConfirm={() => {
          const u = deleting
          if (!u) return
          setRowError(null)
          del.mutate(
            { id: u.id, email: u.email },
            {
              onSuccess: () => {
                setDeleting(null)
                toast.success('User deleted.')
              },
            },
          )
        }}
      >
        Their sessions and API tokens are removed. Items they wrote keep their history under their name.
      </ConfirmDialog>
    </section>
  )
}
