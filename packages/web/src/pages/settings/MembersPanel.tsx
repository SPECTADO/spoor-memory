/** Members of a project (web-ui.md §8): role change, removal, add by email, invite. Admin rule errors show inline. */
import { PROJECT_ROLES, type ProjectRole } from '@spoor/shared'
import { type FormEvent, useState } from 'react'
import { isApiError } from '../../api/client'
import { useAddMember, useMe, useMembers, useRemoveMember, useSetMember } from '../../api/hooks'
import type { MemberJson } from '../../api/types'
import { dateTime } from '../../lib/format'
import {
  Alert,
  Button,
  Checkbox,
  ConfirmDialog,
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
  useToast,
} from '../../ui'
import { InviteDialog } from '../admin/InviteDialog'

const LEAVING_ADMIN_NOTICE =
  'Library editing is not kept after leaving admin; tick Library editor to grant it.'

const ROLE_OPTIONS = PROJECT_ROLES.map((r) => ({ value: r, label: r }))

export function MembersPanel({ slug }: { slug: string }) {
  const members = useMembers(slug)
  const me = useMe()
  const setMember = useSetMember(slug)
  const remove = useRemoveMember(slug)
  const toast = useToast()
  const [removing, setRemoving] = useState<MemberJson | null>(null)
  const [inviting, setInviting] = useState<{ email: string; role: ProjectRole } | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const explain = (e: unknown, who: string) =>
    isApiError(e, 'last_admin')
      ? `${who} is the last project admin. Make someone else an admin first.`
      : e instanceof Error
        ? e.message
        : 'The change failed.'

  return (
    <section aria-label="Members">
      <h2 className="text-base font-semibold">Members</h2>
      <div className="mt-4 space-y-6">
        <AddMember slug={slug} onInvite={(email, role) => setInviting({ email, role })} />
        {rowError && <Alert tone="danger">{rowError}</Alert>}
        {notice && <Alert tone="info">{notice}</Alert>}
        {members.isPending ? (
          <SkeletonRows rows={3} />
        ) : members.isError ? (
          <ErrorState error={members.error} onRetry={() => members.refetch()} />
        ) : members.data.items.length === 0 ? (
          <EmptyState title="No members yet.">Add someone by email or send an invite.</EmptyState>
        ) : (
          <Table caption="Members">
            <THead>
              <tr>
                <Th>Member</Th>
                <Th>Role</Th>
                <Th>Library editor</Th>
                <Th>Added</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </THead>
            <TBody>
              {members.data.items.map((m) => (
                <Tr key={m.user.id}>
                  <Td className="min-w-48">
                    <div className="font-medium">{m.user.name}</div>
                    <div className="text-xs text-muted break-all">{m.user.email}</div>
                  </Td>
                  <Td>
                    <Select
                      label={`Role of ${m.user.email}`}
                      hideLabel
                      value={m.role}
                      onChange={(e) => {
                        const role = e.target.value as ProjectRole
                        setRowError(null)
                        setNotice(
                          m.role === 'admin' && role !== 'admin' && m.library_editor !== true
                            ? LEAVING_ADMIN_NOTICE
                            : null,
                        )
                        setMember.mutate(
                          { userId: m.user.id, role },
                          {
                            onError: (err) => {
                              setNotice(null)
                              setRowError(explain(err, m.user.email))
                            },
                          },
                        )
                      }}
                      options={ROLE_OPTIONS}
                      inputClassName="w-32"
                    />
                  </Td>
                  <Td>
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--c-accent)]"
                      aria-label={`Library editor ${m.user.email}`}
                      title={m.role === 'admin' ? 'Admins can always edit the library' : undefined}
                      checked={m.role === 'admin' || m.library_editor === true}
                      disabled={m.role === 'admin'}
                      onChange={(e) => {
                        setRowError(null)
                        setNotice(null)
                        setMember.mutate(
                          { userId: m.user.id, library_editor: e.target.checked },
                          { onError: (err) => setRowError(explain(err, m.user.email)) },
                        )
                      }}
                    />
                  </Td>
                  <Td className="whitespace-nowrap">{dateTime(m.created_at)}</Td>
                  <Td>
                    <Button size="sm" variant="danger" onClick={() => setRemoving(m)}>
                      Remove
                      <span className="sr-only"> {m.user.email}</span>
                    </Button>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </div>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Remove ${removing?.user.email ?? ''}?`}
        confirmLabel="Remove member"
        danger
        onConfirm={() => {
          const m = removing
          if (!m) return
          setRemoving(null)
          setRowError(null)
          remove.mutate(m.user.id, {
            onSuccess: () => toast.success(`${m.user.email} removed.`),
            onError: (err) => setRowError(explain(err, m.user.email)),
          })
        }}
      >
        {removing?.user.id === me.data?.user.id
          ? 'You lose access to this project. '
          : 'They lose access to this project. '}
        Their API tokens for it are revoked.
      </ConfirmDialog>
      <InviteDialog
        open={inviting !== null}
        onClose={() => setInviting(null)}
        mode={{ kind: 'project', project: slug }}
        defaultEmail={inviting?.email ?? ''}
        defaultRole={inviting?.role ?? 'editor'}
      />
    </section>
  )
}

function AddMember({
  slug,
  onInvite,
}: {
  slug: string
  onInvite: (email: string, role: ProjectRole) => void
}) {
  const add = useAddMember(slug)
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<ProjectRole>('editor')
  const [libraryEditor, setLibraryEditor] = useState(false)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    add.mutate(
      { email: email.trim(), role, ...(libraryEditor && role !== 'admin' ? { library_editor: true } : {}) },
      {
        onSuccess: (m) => {
          toast.success(`${m.user.email} added as ${m.role}.`)
          setEmail('')
          setLibraryEditor(false)
        },
      },
    )
  }
  const err = add.error
  const notFound = isApiError(err, 'user_not_found')
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Input
          className="min-w-56 flex-1"
          label="Add member by email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
        />
        <Select
          label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value as ProjectRole)}
          options={ROLE_OPTIONS}
        />
        {role !== 'admin' && (
          <Checkbox
            className="mb-2"
            label="Library editor"
            checked={libraryEditor}
            onChange={(e) => setLibraryEditor(e.target.checked)}
          />
        )}
        <Button type="submit" variant="primary" disabled={!email.trim()} loading={add.isPending}>
          Add member
        </Button>
        <Button onClick={() => onInvite('', role)}>Invite someone</Button>
      </div>
      {err && (
        <Alert tone={notFound ? 'warning' : 'danger'}>
          <p>{notFound ? 'No account has this email.' : err.message}</p>
          {isApiError(err) && err.hint && <p>{err.hint}</p>}
          {notFound && (
            <Button size="sm" className="mt-2" onClick={() => onInvite(email.trim(), role)}>
              Create an invite instead
            </Button>
          )}
        </Alert>
      )}
    </form>
  )
}
