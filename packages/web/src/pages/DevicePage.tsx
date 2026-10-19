/**
 * `/device` (web-ui.md §2, auth-and-security.md §6): approve a `spoor login` from the terminal. The user
 * TYPES the code (a `?code=` parameter is deliberately ignored), sees who asked (project, requester IP, age,
 * the unverified client name) and decides. "Approve read-only" has the default focus. Malformed codes are
 * rejected locally: every server-side miss counts toward a 10-minute lock.
 */
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router'
import { isApiError } from '../api/client'
import { useDeviceApprove, useDeviceDeny, useDeviceLookup } from '../api/hooks'
import type { DeviceLookup } from '../api/types'
import { CenteredPage } from '../components/CenteredPage'
import { duration } from '../lib/format'
import { Alert, Badge, Button, ErrorState, Input, SkeletonRows } from '../ui'

const CODE_ALPHABET = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/

/** What the user typed → `WDJBMJHT`, or null when it cannot be a code. */
export function normalizeUserCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '')
  return CODE_ALPHABET.test(s) ? s : null
}

export const formatUserCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`

type Outcome = { kind: 'approved'; readOnly: boolean; project: string } | { kind: 'denied'; project: string }

export function DevicePage() {
  const [code, setCode] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const reset = () => {
    setCode(null)
    setOutcome(null)
  }

  return (
    <CenteredPage title="Approve a CLI login" wide>
      {outcome ? (
        <Done outcome={outcome} onAgain={reset} />
      ) : code ? (
        <Review code={code} onBack={reset} onDone={setOutcome} />
      ) : (
        <CodeForm onCode={setCode} />
      )}
    </CenteredPage>
  )
}

function CodeForm({ onCode }: { onCode: (code: string) => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const c = normalizeUserCode(text)
    if (c) onCode(c)
    else setError('A code has 8 letters, like WDJB-MJHT.')
  }
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <p className="text-sm text-muted">
        Type the code that <code className="font-mono">spoor login</code> shows in your terminal. Only approve
        a request you started yourself.
      </p>
      <Input
        label="Code"
        value={text}
        onChange={(e) => {
          setText(e.target.value.toUpperCase())
          setError(null)
        }}
        placeholder="XXXX-XXXX"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={12}
        autoFocus
        inputClassName="font-mono tracking-widest uppercase"
        error={error}
      />
      <Button type="submit" variant="primary" className="w-full">
        Continue
      </Button>
    </form>
  )
}

function Review({
  code,
  onBack,
  onDone,
}: {
  code: string
  onBack: () => void
  onDone: (o: Outcome) => void
}) {
  const lookup = useDeviceLookup(code)
  const approve = useDeviceApprove()
  const deny = useDeviceDeny()

  if (lookup.isPending) return <SkeletonRows rows={4} label="Looking up the code" />
  if (lookup.isError) {
    return (
      <div className="space-y-4">
        {isApiError(lookup.error, 'not_found') ? (
          <Alert tone="danger" title={`No pending login for ${formatUserCode(code)}`}>
            Check the code. Codes expire after 10 minutes and only work for projects you belong to; run{' '}
            <code className="font-mono">spoor login</code> again for a new one.
          </Alert>
        ) : (
          <ErrorState error={lookup.error} />
        )}
        <Button onClick={onBack}>Enter another code</Button>
      </div>
    )
  }

  const d = lookup.data
  const decisionError = approve.error ?? deny.error
  const busy = approve.isPending || deny.isPending
  const doApprove = (readOnly: boolean) =>
    approve.mutate(
      { code, readOnly },
      { onSuccess: () => onDone({ kind: 'approved', readOnly, project: d.project.name }) },
    )
  const doDeny = () =>
    deny.mutate(code, { onSuccess: () => onDone({ kind: 'denied', project: d.project.name }) })

  return (
    <div className="space-y-4">
      <RequestDetails code={code} d={d} />
      {decisionError &&
        (isApiError(decisionError, 'not_found') ? (
          <Alert tone="danger">This code was already decided or has expired.</Alert>
        ) : (
          <ErrorState error={decisionError} />
        ))}
      <p className="text-sm text-muted">
        <strong className="text-fg">Approve read-only</strong> gives the CLI a token that can only read.{' '}
        <strong className="text-fg">Approve</strong> gives it your role in the project ({d.your_role}). The
        token expires after 90 days.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          autoFocus
          disabled={busy}
          loading={approve.isPending && approve.variables?.readOnly}
          onClick={() => doApprove(true)}
        >
          Approve read-only
        </Button>
        <Button
          disabled={busy}
          loading={approve.isPending && !approve.variables?.readOnly}
          onClick={() => doApprove(false)}
        >
          Approve
        </Button>
        <Button variant="danger" disabled={busy} loading={deny.isPending} onClick={doDeny}>
          Deny
        </Button>
      </div>
      <button type="button" onClick={onBack} className="text-sm text-accent underline">
        This is not my request / enter another code
      </button>
    </div>
  )
}

function RequestDetails({ code, d }: { code: string; d: DeviceLookup }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border border-border bg-surface p-3 text-sm">
      <dt className="text-muted">Code</dt>
      <dd className="font-mono">{formatUserCode(code)}</dd>
      <dt className="text-muted">Project</dt>
      <dd>
        {d.project.name} <span className="font-mono text-xs text-muted">({d.project.slug})</span>
      </dd>
      <dt className="text-muted">Requested from</dt>
      <dd className="font-mono">{d.requester_ip ?? 'unknown address'}</dd>
      <dt className="text-muted">Requested</dt>
      <dd>{duration(d.age_s)} ago</dd>
      <dt className="text-muted">Client</dt>
      <dd>
        <span className="font-mono break-all">{d.client_name}</span>{' '}
        <span className="text-xs text-muted">reported by the requester (unverified)</span>
      </dd>
      <dt className="text-muted">Your role</dt>
      <dd>
        <Badge>{d.your_role}</Badge>
      </dd>
    </dl>
  )
}

function Done({ outcome, onAgain }: { outcome: Outcome; onAgain: () => void }) {
  return (
    <div className="space-y-4">
      {outcome.kind === 'approved' ? (
        <Alert
          tone="success"
          title={`Approved${outcome.readOnly ? ' (read-only)' : ''} for ${outcome.project}`}
        >
          Return to your terminal; the CLI picks up its token within a few seconds.
        </Alert>
      ) : (
        <Alert tone="info" title={`Denied for ${outcome.project}`}>
          The CLI will report that access was denied. Nothing was issued.
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={onAgain}>Approve another code</Button>
        <Link to="/projects" className="inline-flex h-9 items-center px-2 text-sm text-accent underline">
          Go to projects
        </Link>
      </div>
    </div>
  )
}
