/**
 * Tokens of a project (web-ui.md §8): list, create (user token for yourself, service token for project
 * admins) and revoke. A new secret is shown exactly once in `SecretOnceDialog`, which cannot be closed before
 * the user confirms the copy; the secret lives only in component state and is dropped on close.
 */
import { nameSchema, tokenCreateRequest } from '@spoor/shared'
import { type FormEvent, useState } from 'react'
import { isApiError } from '../../api/client'
import { installDocUrl } from '../../api/endpoints'
import { useCreateToken, useRevokeToken, useTokens } from '../../api/hooks'
import type { TokenCreateRequest, TokenJson } from '../../api/types'
import { useCan } from '../../components/RequireRole'
import { dateTime, fromNow } from '../../lib/format'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  CopyField,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  issuesByField,
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

export function TokensPanel({ slug }: { slug: string }) {
  const admin = useCan('admin', slug).allowed
  const [showRevoked, setShowRevoked] = useState(false)
  const tokens = useTokens(slug, showRevoked)
  const revoke = useRevokeToken(slug)
  const toast = useToast()
  const [creating, setCreating] = useState(false)
  const [secret, setSecret] = useState<{ value: string; name: string } | null>(null)
  const [revoking, setRevoking] = useState<TokenJson | null>(null)

  return (
    <section aria-label="Tokens">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Tokens</h2>
          <p className="mt-0.5 text-sm text-muted">
            {admin ? 'All tokens of this project.' : 'Your tokens for this project.'} A token is the CLI's and
            agents' key; revoking it takes effect at the next request.
          </p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          New token
        </Button>
      </div>
      <TokenHelp slug={slug} />
      <div className="my-4">
        <Checkbox
          label="Show revoked tokens"
          checked={showRevoked}
          onChange={(e) => setShowRevoked(e.target.checked)}
        />
      </div>
      {tokens.isPending ? (
        <SkeletonRows rows={3} />
      ) : tokens.isError ? (
        <ErrorState error={tokens.error} onRetry={() => tokens.refetch()} />
      ) : tokens.data.items.length === 0 ? (
        <EmptyState title="No tokens.">
          Create one for an agent, or run spoor login to mint one from a terminal.
        </EmptyState>
      ) : (
        <Table caption="Tokens">
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Kind</Th>
              <Th>Origin</Th>
              <Th>Role cap</Th>
              <Th>Prefix</Th>
              <Th>Created</Th>
              <Th>Last used</Th>
              <Th>Expires</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {tokens.data.items.map((t) => (
              <Tr key={t.id}>
                <Td className="min-w-40">
                  <div className="font-medium">{t.name}</div>
                  {t.user && admin && <div className="text-xs text-muted">{t.user.label}</div>}
                </Td>
                <Td>{t.kind}</Td>
                <Td>
                  <Badge>{t.origin === 'device' ? 'device login' : 'web'}</Badge>
                </Td>
                <Td>{t.role ?? 'inherits role'}</Td>
                <Td className="font-mono text-xs">{t.prefix}…</Td>
                <Td className="whitespace-nowrap" title={dateTime(t.created_at)}>
                  {fromNow(t.created_at)}
                </Td>
                <Td className="whitespace-nowrap">{t.last_used_at ? fromNow(t.last_used_at) : 'never'}</Td>
                <Td className="whitespace-nowrap">{t.expires_at ? dateTime(t.expires_at) : 'never'}</Td>
                <Td>
                  {t.revoked_at ? (
                    <Badge tone="danger">revoked</Badge>
                  ) : (
                    <Button size="sm" variant="danger" onClick={() => setRevoking(t)}>
                      Revoke
                      <span className="sr-only"> {t.name}</span>
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      <TokenCreateDialog
        open={creating}
        slug={slug}
        admin={admin}
        onClose={() => setCreating(false)}
        onCreated={(value, name) => {
          setCreating(false)
          setSecret({ value, name })
        }}
      />
      <SecretOnceDialog secret={secret} onClose={() => setSecret(null)} />
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={`Revoke ${revoking?.name ?? ''}?`}
        confirmLabel="Revoke token"
        danger
        onConfirm={() => {
          const t = revoking
          if (!t) return
          setRevoking(null)
          revoke.mutate(t.id, {
            onSuccess: () => toast.success(`Token ${t.name} revoked.`),
            onError: (e) => toast.error(e),
          })
        }}
      >
        Anything using this token stops working at its next request. This cannot be undone.
      </ConfirmDialog>
    </section>
  )
}

function TokenHelp({ slug }: { slug: string }) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  return (
    <p className="mt-3 text-sm text-muted">
      From a terminal,{' '}
      <code className="font-mono">
        spoor login --server {origin || '<server>'} --project {slug}
      </code>{' '}
      creates a token after you approve it in the browser. Setup instructions:{' '}
      <a href={installDocUrl(slug)} className="text-accent underline">
        install.md
      </a>
      .
    </p>
  )
}

// ---- create ---------------------------------------------------------------------------------------------

function TokenCreateDialog({
  open,
  slug,
  admin,
  onClose,
  onCreated,
}: {
  open: boolean
  slug: string
  admin: boolean
  onClose: () => void
  onCreated: (secret: string, name: string) => void
}) {
  return (
    <Dialog open={open} onClose={onClose} title="New token">
      <TokenCreateForm slug={slug} admin={admin} onCancel={onClose} onCreated={onCreated} />
    </Dialog>
  )
}

function TokenCreateForm({
  slug,
  admin,
  onCancel,
  onCreated,
}: {
  slug: string
  admin: boolean
  onCancel: () => void
  onCreated: (secret: string, name: string) => void
}) {
  const create = useCreateToken(slug)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'user' | 'service'>('user')
  const [userRole, setUserRole] = useState<'' | 'viewer'>('')
  const [serviceRole, setServiceRole] = useState<'editor' | 'viewer'>('viewer')
  const [expires, setExpires] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!nameSchema.safeParse(name).success) errs.name = 'Enter a name (1 to 100 characters).'
    const body: TokenCreateRequest = { kind, name: name.trim() }
    if (kind === 'service') body.role = serviceRole
    else if (userRole) body.role = userRole
    if (expires) {
      const t = new Date(expires)
      if (Number.isNaN(t.getTime()) || t.getTime() <= Date.now())
        errs.expires_at = 'Pick a time in the future.'
      else body.expires_at = t.toISOString()
    }
    if (!errs.name && !errs.expires_at) {
      const parsed = tokenCreateRequest.safeParse(body)
      if (!parsed.success) for (const i of parsed.error.issues) errs[i.path.join('.')] ??= i.message
    }
    setErrors(errs)
    if (Object.keys(errs).length) return
    create.mutate(body, {
      onSuccess: (res) => onCreated(res.secret, res.token.name),
      onError: (err) => {
        if (isApiError(err, 'invalid_input') && err.issues.length) setErrors(issuesByField(err.issues))
      },
    })
  }
  const err = create.error
  const banner = err && !(isApiError(err, 'invalid_input') && err.issues.length) ? err.message : null
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {banner && <Alert tone="danger">{banner}</Alert>}
      <Input
        label="Name"
        required
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        hint="What it is used for, for example laptop or ci."
        error={errors.name}
      />
      {admin && (
        <Select
          label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as 'user' | 'service')}
          options={[
            { value: 'user', label: 'User token (acts as you)' },
            { value: 'service', label: 'Service token (fixed role, for automation)' },
          ]}
        />
      )}
      {kind === 'service' ? (
        <Select
          label="Role"
          value={serviceRole}
          onChange={(e) => setServiceRole(e.target.value as 'editor' | 'viewer')}
          options={[
            { value: 'viewer', label: 'viewer (read only)' },
            { value: 'editor', label: 'editor' },
          ]}
          error={errors.role}
        />
      ) : (
        <Select
          label="Role"
          value={userRole}
          onChange={(e) => setUserRole(e.target.value as '' | 'viewer')}
          options={[
            { value: '', label: 'Same as my role' },
            { value: 'viewer', label: 'Read-only' },
          ]}
          error={errors.role}
        />
      )}
      <Input
        label="Expires (optional)"
        type="datetime-local"
        value={expires}
        onChange={(e) => setExpires(e.target.value)}
        hint="Leave empty for a token that does not expire."
        error={errors.expires_at}
      />
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          Create token
        </Button>
      </div>
    </form>
  )
}

// ---- shown once ------------------------------------------------------------------------------------------

export function SecretOnceDialog({
  secret,
  onClose,
}: {
  secret: { value: string; name: string } | null
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const close = () => {
    setCopied(false)
    onClose()
  }
  return (
    <Dialog
      open={secret !== null}
      onClose={close}
      dismissible={copied}
      title="Token created"
      description={secret ? `Token ${secret.name}` : undefined}
      footer={
        <Button variant="primary" disabled={!copied} onClick={close}>
          Done
        </Button>
      }
    >
      {secret && (
        <div className="space-y-4">
          <Alert tone="warning">
            This is the only time you can see it. Copy it now; it cannot be shown again.
          </Alert>
          <CopyField label="Token" value={secret.value} />
          <Checkbox label="I have copied it" checked={copied} onChange={(e) => setCopied(e.target.checked)} />
        </div>
      )}
    </Dialog>
  )
}
