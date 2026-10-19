/**
 * `/invite#spi_…` (web-ui.md §2, api.md §2.1): preview the invite, then accept it with a name, email and
 * password, or, for a reset invite, set a new password. The token lives in the URL fragment, so it never
 * reaches a server log; it is sent only in POST bodies.
 */
import { PASSWORD_MAX, PASSWORD_MIN, passwordSchema } from '@spoor/shared'
import { type FormEvent, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { isApiError } from '../api/client'
import { useAcceptInvite, useInvitePreview } from '../api/hooks'
import type { InvitePreview } from '../api/types'
import { CenteredPage } from '../components/CenteredPage'
import { dateTime } from '../lib/format'
import { Alert, Badge, Button, ErrorState, Input, issuesByField, SkeletonRows } from '../ui'

/** `spi_…` from a fragment, a pasted link, or a pasted bare token. */
export function extractInviteToken(text: string): string | null {
  const m = /spi_[A-Za-z0-9_-]+/.exec(text)
  return m ? m[0] : null
}

export function InvitePage() {
  const location = useLocation()
  const [token, setToken] = useState<string | null>(() => extractInviteToken(location.hash))
  const preview = useInvitePreview(token)

  if (!token) return <PasteToken onToken={setToken} />
  if (preview.isPending) {
    return (
      <CenteredPage title="Invite">
        <SkeletonRows rows={3} label="Checking the invite" />
      </CenteredPage>
    )
  }
  if (preview.isError) {
    return (
      <CenteredPage title="Invite">
        {isApiError(preview.error, 'not_found') ? (
          <Alert tone="danger" title="This invite link is not valid">
            It may have been used, revoked or expired. Ask an admin for a new link.
          </Alert>
        ) : (
          <ErrorState error={preview.error} onRetry={() => preview.refetch()} />
        )}
      </CenteredPage>
    )
  }
  return <AcceptForm token={token} invite={preview.data} />
}

function PasteToken({ onToken }: { onToken: (t: string) => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const t = extractInviteToken(text)
    if (t) onToken(t)
    else setError('That does not look like an invite link. It contains "#spi_".')
  }
  return (
    <CenteredPage title="Accept an invite">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">Open the invite link you were given, or paste it here.</p>
        <Input
          label="Invite link"
          value={text}
          onChange={(e) => setText(e.target.value)}
          error={error}
          autoFocus
        />
        <Button type="submit" variant="primary" className="w-full">
          Continue
        </Button>
      </form>
    </CenteredPage>
  )
}

function AcceptForm({ token, invite }: { token: string; invite: InvitePreview }) {
  const navigate = useNavigate()
  const accept = useAcceptInvite()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [local, setLocal] = useState<Record<string, string>>({})

  const reset = invite.reset
  const lockedEmail = invite.email

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!reset && !name.trim()) errs.name = 'Enter your name.'
    if (!reset && !lockedEmail && !email.trim()) errs.email = 'Enter your email.'
    if (!passwordSchema.safeParse(password).success) {
      errs.password = `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`
    } else if (password !== confirm) {
      errs.confirm = 'The passwords do not match.'
    }
    setLocal(errs)
    if (Object.keys(errs).length) return
    accept.mutate(
      reset
        ? { token, password }
        : { token, password, name: name.trim(), ...(lockedEmail ? {} : { email: email.trim() }) },
      { onSuccess: () => navigate('/projects', { replace: true }) },
    )
  }

  const err = accept.error
  const server = isApiError(err) ? issuesByField(err.issues) : {}
  const fieldError = (k: string) => local[k] ?? server[k]
  const banner = !err
    ? null
    : isApiError(err, 'already_exists')
      ? 'An account with this email already exists; ask an admin to add you to the project.'
      : isApiError(err, 'not_found')
        ? 'This invite link is no longer valid. Ask an admin for a new one.'
        : isApiError(err, 'invalid_input') && Object.keys(server).length
          ? 'Check the highlighted fields.'
          : err.message

  return (
    <CenteredPage title={reset ? 'Set a new password' : 'Accept your invite'} wide>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {reset ? (
          <p className="text-sm">
            Choose a new password for <strong>{lockedEmail}</strong>. Your other sessions will be signed out.
          </p>
        ) : (
          <InviteSummary invite={invite} />
        )}
        {banner && <Alert tone="danger">{banner}</Alert>}
        {!reset && (
          <Input
            label="Name"
            autoComplete="name"
            required
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            error={fieldError('name')}
          />
        )}
        {!reset &&
          (lockedEmail ? (
            <Input label="Email" value={lockedEmail} readOnly hint="This invite is for this email address." />
          ) : (
            <Input
              label="Email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fieldError('email')}
            />
          ))}
        {/* hidden username for password managers on the reset form */}
        {reset && lockedEmail && <input type="hidden" autoComplete="username" value={lockedEmail} readOnly />}
        <Input
          label={reset ? 'New password' : 'Password'}
          type="password"
          autoComplete="new-password"
          required
          autoFocus={reset}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={`${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`}
          error={fieldError('password')}
        />
        <Input
          label="Repeat the password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={fieldError('confirm')}
        />
        <Button type="submit" variant="primary" className="w-full" loading={accept.isPending}>
          {reset ? 'Set password and log in' : 'Create account'}
        </Button>
        <p className="text-xs text-muted">This link expires {dateTime(invite.expires_at)}.</p>
      </form>
    </CenteredPage>
  )
}

function InviteSummary({ invite }: { invite: InvitePreview }) {
  return (
    <div className="space-y-2 text-sm">
      {invite.grants.length > 0 ? (
        <>
          <p>You are invited to:</p>
          <ul className="space-y-1">
            {invite.grants.map((g) => (
              <li
                key={g.project.slug}
                className="flex items-center justify-between gap-2 rounded-md bg-surface px-3 py-1.5"
              >
                <span className="truncate">{g.project.name}</span>
                <Badge>{g.role}</Badge>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>You are invited to this Spoor instance.</p>
      )}
      {(invite.is_admin || invite.shared_editor) && (
        <p className="flex flex-wrap gap-1">
          {invite.is_admin && <Badge tone="accent">Instance admin</Badge>}
          {invite.shared_editor && <Badge tone="accent">Shared editor</Badge>}
        </p>
      )}
    </div>
  )
}
