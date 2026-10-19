/**
 * Create an invite in one of three modes (web-ui.md §8): `admin` (instance admin: any grants and the instance
 * flags), `project` (a project admin inviting into one project: one grant, no flags) and `reset` (a password
 * reset link for an existing user). The link appears once in `InviteResultDialog` and is never stored.
 */
import { PROJECT_ROLES, type ProjectRole } from '@spoor/shared'
import { Plus, Trash2 } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { isApiError } from '../../api/client'
import { useCreateInvite } from '../../api/hooks'
import type { InviteCreateBody, InviteCreateResponse } from '../../api/types'
import { Alert, Button, Checkbox, CopyField, Dialog, IconButton, Input, Select } from '../../ui'

export type InviteMode =
  | { kind: 'admin'; projects: { slug: string; name: string }[] }
  | { kind: 'project'; project: string }
  | { kind: 'reset'; user: { id: string; email: string } }

interface GrantRow {
  key: number
  project: string
  role: ProjectRole
}

const ROLE_OPTIONS = PROJECT_ROLES.map((r) => ({ value: r, label: r }))

export function InviteDialog({
  open,
  onClose,
  mode,
  defaultEmail = '',
  defaultRole = 'editor',
}: {
  open: boolean
  onClose: () => void
  mode: InviteMode
  defaultEmail?: string
  defaultRole?: ProjectRole
}) {
  const [result, setResult] = useState<InviteCreateResponse | null>(null)
  const title =
    mode.kind === 'reset'
      ? `Reset invite for ${mode.user.email}`
      : mode.kind === 'project'
        ? 'Invite someone'
        : 'New invite'
  return (
    <>
      <Dialog open={open} onClose={onClose} title={title}>
        <InviteForm
          mode={mode}
          defaultEmail={defaultEmail}
          defaultRole={defaultRole}
          onCancel={onClose}
          onCreated={(res) => {
            onClose()
            setResult(res)
          }}
        />
      </Dialog>
      <InviteResultDialog result={result} onClose={() => setResult(null)} />
    </>
  )
}

function InviteForm({
  mode,
  defaultEmail,
  defaultRole,
  onCancel,
  onCreated,
}: {
  mode: InviteMode
  defaultEmail: string
  defaultRole: ProjectRole
  onCancel: () => void
  onCreated: (r: InviteCreateResponse) => void
}) {
  const create = useCreateInvite()
  const firstProject = mode.kind === 'admin' ? (mode.projects[0]?.slug ?? '') : ''
  const [email, setEmail] = useState(defaultEmail)
  const [role, setRole] = useState<ProjectRole>(defaultRole)
  const [grants, setGrants] = useState<GrantRow[]>(
    mode.kind === 'admin' && firstProject ? [{ key: 1, project: firstProject, role: defaultRole }] : [],
  )
  const [nextKey, setNextKey] = useState(2)
  const [isAdmin, setIsAdmin] = useState(false)
  const [sharedEditor, setSharedEditor] = useState(false)
  const [revokeTokens, setRevokeTokens] = useState(true)
  const [hours, setHours] = useState('168')

  const hoursNum = Number(hours)
  const hoursOk = Number.isInteger(hoursNum) && hoursNum >= 1 && hoursNum <= 720

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!hoursOk) return
    const body: InviteCreateBody = { expires_in_hours: hoursNum, grants: [] }
    if (mode.kind === 'reset') {
      body.reset_user_id = mode.user.id
      body.reset_revoke_tokens = revokeTokens
    } else {
      if (email.trim()) body.email = email.trim()
      if (mode.kind === 'project') body.grants = [{ project: mode.project, role }]
      else {
        body.grants = grants.filter((g) => g.project).map((g) => ({ project: g.project, role: g.role }))
        if (isAdmin) body.is_admin = true
        if (sharedEditor) body.shared_editor = true
      }
    }
    create.mutate(body, { onSuccess: onCreated })
  }

  const error = create.error
  const issues = isApiError(error) ? error.issues : []
  return (
    <form onSubmit={submit} className="space-y-4">
      {mode.kind === 'reset' ? (
        <>
          <p className="text-sm text-muted">
            Creates a link that lets this user set a new password. Their sessions end when it is used.
          </p>
          <Checkbox
            label="Also revoke this user's API tokens"
            checked={revokeTokens}
            onChange={(e) => setRevokeTokens(e.target.checked)}
          />
        </>
      ) : (
        <>
          <Input
            label="Email (optional)"
            type="email"
            hint="Locks the invite to this address."
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
          />
          {mode.kind === 'project' ? (
            <Select
              label="Role"
              value={role}
              onChange={(e) => setRole(e.target.value as ProjectRole)}
              options={ROLE_OPTIONS}
            />
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Project access</legend>
              {grants.map((g) => (
                <div key={g.key} className="flex items-end gap-2">
                  <Select
                    className="flex-1"
                    label="Project"
                    hideLabel
                    value={g.project}
                    onChange={(e) =>
                      setGrants((xs) =>
                        xs.map((x) => (x.key === g.key ? { ...x, project: e.target.value } : x)),
                      )
                    }
                    options={mode.projects.map((p) => ({ value: p.slug, label: p.name }))}
                  />
                  <Select
                    label="Role"
                    hideLabel
                    value={g.role}
                    onChange={(e) =>
                      setGrants((xs) =>
                        xs.map((x) => (x.key === g.key ? { ...x, role: e.target.value as ProjectRole } : x)),
                      )
                    }
                    options={ROLE_OPTIONS}
                  />
                  <IconButton
                    label="Remove this grant"
                    icon={<Trash2 className="size-4" aria-hidden="true" />}
                    onClick={() => setGrants((xs) => xs.filter((x) => x.key !== g.key))}
                  />
                </div>
              ))}
              <Button
                size="sm"
                icon={<Plus className="size-4" aria-hidden="true" />}
                disabled={mode.projects.length === 0}
                onClick={() => {
                  setGrants((xs) => [...xs, { key: nextKey, project: firstProject, role: 'editor' }])
                  setNextKey((k) => k + 1)
                }}
              >
                Add project
              </Button>
              <Checkbox
                label="Instance admin"
                checked={isAdmin}
                onChange={(e) => setIsAdmin(e.target.checked)}
              />
              <Checkbox
                label="Shared editor (can write to the shared space)"
                checked={sharedEditor}
                onChange={(e) => setSharedEditor(e.target.checked)}
              />
            </fieldset>
          )}
        </>
      )}
      <Input
        label="Expires after (hours)"
        type="number"
        min={1}
        max={720}
        value={hours}
        onChange={(e) => setHours(e.target.value)}
        error={hoursOk ? undefined : 'Use a whole number from 1 to 720.'}
      />
      {error && (
        <Alert tone="danger" title={error.message}>
          {issues.length > 0 && (
            <ul className="list-disc pl-5">
              {issues.map((i) => (
                <li key={`${i.path}:${i.message}`}>
                  {i.path}: {i.message}
                </li>
              ))}
            </ul>
          )}
          {isApiError(error) && error.hint}
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!hoursOk} loading={create.isPending}>
          Create invite
        </Button>
      </div>
    </form>
  )
}

/** The link of a new invite, shown once ("There is no email."). */
export function InviteResultDialog({
  result,
  onClose,
}: {
  result: InviteCreateResponse | null
  onClose: () => void
}) {
  return (
    <Dialog
      open={result !== null}
      onClose={onClose}
      title="Invite created"
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {result && (
        <CopyField
          label="Invite link"
          value={result.link}
          hint="Shown once; copy it now. There is no email. Send the link to the person yourself."
        />
      )}
    </Dialog>
  )
}
