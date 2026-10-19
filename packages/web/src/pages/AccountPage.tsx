/**
 * `/account`: name, password change, and the user's own API tokens across all projects (list and revoke).
 * There is no cross-project token endpoint, so "My tokens" reads `GET …/tokens` of every visible project
 * and keeps the user tokens owned by the caller.
 */
import { PASSWORD_MAX, PASSWORD_MIN, passwordSchema } from '@spoor/shared'
import { type FormEvent, type ReactNode, useState } from 'react'
import { Link } from 'react-router'
import { isApiError } from '../api/client'
import {
  useChangePassword,
  useMe,
  usePatchMe,
  useProjects,
  useRevokeToken,
  useTokensAcross,
} from '../api/hooks'
import type { TokenJson } from '../api/types'
import { dateTime, fromNow } from '../lib/format'
import { projectPath } from '../lib/paths'
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
} from '../ui'

export function AccountPage() {
  return (
    <section className="max-w-4xl">
      <PageHeader title="Account" />
      <div className="space-y-10">
        <ProfileForm />
        <PasswordForm />
        <MyTokens />
      </div>
    </section>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  const id = `section-${title.toLowerCase().replace(/\W+/g, '-')}`
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

function ProfileForm() {
  const me = useMe()
  const patch = usePatchMe()
  const toast = useToast()
  const [name, setName] = useState(me.data?.user.name ?? '')
  const changed = name.trim() !== '' && name.trim() !== me.data?.user.name
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!changed) return
    patch.mutate({ name: name.trim() }, { onSuccess: () => toast.success('Name saved.') })
  }
  return (
    <Section title="Profile">
      <form onSubmit={submit} className="max-w-md space-y-4">
        <Input
          label="Email"
          value={me.data?.user.email ?? ''}
          readOnly
          hint="Ask an instance admin to change it."
        />
        <Input
          label="Name"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={isApiError(patch.error) ? patch.error.message : undefined}
        />
        <Button type="submit" variant="primary" disabled={!changed} loading={patch.isPending}>
          Save name
        </Button>
      </form>
    </Section>
  )
}

function PasswordForm() {
  const change = useChangePassword()
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!current) errs.current = 'Enter your current password.'
    if (!passwordSchema.safeParse(next).success)
      errs.next = `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`
    else if (next !== confirm) errs.confirm = 'The passwords do not match.'
    setErrors(errs)
    if (Object.keys(errs).length) return
    change.mutate(
      { current_password: current, new_password: next },
      {
        onSuccess: () => {
          setCurrent('')
          setNext('')
          setConfirm('')
          toast.success('Password changed.', 'Your other sessions were signed out.')
        },
        onError: (err) => {
          if (isApiError(err, 'invalid_credentials')) setErrors({ current: 'The current password is wrong.' })
        },
      },
    )
  }

  const otherError = change.error && !isApiError(change.error, 'invalid_credentials') ? change.error : null
  return (
    <Section
      title="Password"
      description="Changing it signs out your other sessions. API tokens keep working."
    >
      <form onSubmit={submit} className="max-w-md space-y-4" noValidate>
        {/* username field for password managers */}
        <input type="hidden" autoComplete="username" />
        {otherError && <Alert tone="danger">{otherError.message}</Alert>}
        <Input
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          error={errors.current}
        />
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          hint={`${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`}
          error={errors.next}
        />
        <Input
          label="Repeat the new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={errors.confirm}
        />
        <Button type="submit" variant="primary" loading={change.isPending}>
          Change password
        </Button>
      </form>
    </Section>
  )
}

const roleLabel = (t: TokenJson) =>
  t.role === 'viewer' ? 'read-only' : t.role === 'editor' ? 'editor cap' : 'my role'

function MyTokens() {
  const me = useMe()
  const projects = useProjects()
  const list = projects.data?.items ?? []
  const results = useTokensAcross(list.map((p) => p.slug))
  const [revoking, setRevoking] = useState<{ slug: string; token: TokenJson } | null>(null)

  const pending = projects.isPending || results.some((r) => r.isPending)
  const failed = projects.error ?? results.find((r) => r.error)?.error
  const rows = list.flatMap((p, i) =>
    (results[i]?.data?.items ?? [])
      .filter((t) => t.kind === 'user' && t.user?.id === me.data?.user.id && !t.revoked_at)
      .map((t) => ({ project: p, token: t })),
  )

  return (
    <Section
      title="My API tokens"
      description="Tokens let the spoor CLI and agents act as you in one project. Create them on a project's Tokens page or with spoor login."
    >
      {pending ? (
        <SkeletonRows rows={2} />
      ) : failed ? (
        <ErrorState error={failed} />
      ) : rows.length === 0 ? (
        <EmptyState>You have no active tokens.</EmptyState>
      ) : (
        <Table caption="My API tokens">
          <THead>
            <Tr>
              <Th>Project</Th>
              <Th>Name</Th>
              <Th>Origin</Th>
              <Th>Access</Th>
              <Th>Prefix</Th>
              <Th>Last used</Th>
              <Th>Expires</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </Tr>
          </THead>
          <TBody>
            {rows.map(({ project, token }) => (
              <Tr key={token.id}>
                <Td>
                  <Link to={projectPath(project.slug, 'tokens')} className="text-accent underline">
                    {project.name}
                  </Link>
                </Td>
                <Td className="break-all">{token.name}</Td>
                <Td>
                  <Badge>{token.origin === 'device' ? 'device login' : 'web'}</Badge>
                </Td>
                <Td>{roleLabel(token)}</Td>
                <Td className="font-mono text-xs">{token.prefix}…</Td>
                <Td title={dateTime(token.last_used_at)}>
                  {token.last_used_at ? fromNow(token.last_used_at) : 'never'}
                </Td>
                <Td title={dateTime(token.expires_at)}>
                  {token.expires_at ? fromNow(token.expires_at) : 'never'}
                </Td>
                <Td className="text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRevoking({ slug: project.slug, token })}
                  >
                    Revoke
                  </Button>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      {revoking && (
        <RevokeDialog slug={revoking.slug} token={revoking.token} onClose={() => setRevoking(null)} />
      )}
    </Section>
  )
}

function RevokeDialog({ slug, token, onClose }: { slug: string; token: TokenJson; onClose: () => void }) {
  const revoke = useRevokeToken(slug)
  const toast = useToast()
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title="Revoke token?"
      danger
      confirmLabel="Revoke"
      pending={revoke.isPending}
      onConfirm={() =>
        revoke.mutate(token.id, {
          onSuccess: () => {
            toast.success(`Token "${token.name}" revoked.`)
            onClose()
          },
          onError: (e) => toast.error(e),
        })
      }
    >
      <p>
        <strong>{token.name}</strong> (<code className="font-mono">{token.prefix}…</code>) stops working at
        its next request. This cannot be undone.
      </p>
    </ConfirmDialog>
  )
}
