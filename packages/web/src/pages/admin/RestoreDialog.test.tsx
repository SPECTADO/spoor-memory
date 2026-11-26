import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { apiError, json, mockApi, renderWithProviders } from '../../test/utils'
import { RestoreDialog } from './RestoreDialog'

const backup = {
  id: '20261120T030000Z-auto',
  kind: 'auto' as const,
  created_at: '2026-11-20T03:00:12.000Z',
  size_bytes: 1000,
  pinned: false,
  verified_at: null,
  spoor_version: '0.8.0',
  migration: { count: 11, last_tag: '0010_backups' },
  pg_server_version: '17.6',
  projects: 3,
  projects_skipped: 0,
  restorable: true,
  protected: false,
}

const prepared = {
  token: 'tok1',
  expires_at: '2026-11-26T10:05:00Z',
  phrase: 'RESTORE 2026-11-20 03:00',
  backup,
  summary: {
    created_at: backup.created_at,
    spoor_version: '0.8.0',
    migration: {
      backup: { count: 10, last_tag: '0009_x' },
      current: { count: 11, last_tag: '0010_backups' },
      to_apply: 1,
    },
    projects: 3,
    items: 120,
    pre_restore_backup: true,
  },
  warnings: [
    { code: 'data_loss', message: 'Everything written after the backup is lost.' },
    { code: 'logout', message: 'Everyone is logged out.' },
  ],
}

const status = (over: Record<string, unknown> = {}) => ({
  state: 'running',
  phase: 'restoring',
  backup_id: backup.id,
  pre_restore_backup_id: '20261126T100000Z-pre-restore',
  started_at: '2026-11-26T10:00:00Z',
  finished_at: null,
  error: null,
  maintenance: true,
  ...over,
})

function open(onDone = vi.fn()) {
  renderWithProviders(<RestoreDialog backup={backup} onClose={() => {}} onDone={onDone} pollMs={20} />)
  return onDone
}

async function toConfirm() {
  await screen.findByText('Before you continue')
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
}

describe('RestoreDialog', () => {
  it('step 1 shows the summary and warnings from prepare', async () => {
    mockApi({ 'POST /api/v1/backups/20261120T030000Z-auto/restore/prepare': [200, prepared] })
    open()
    expect(await screen.findByText('Everything written after the backup is lost.')).toBeInTheDocument()
    expect(screen.getByText('3 projects, 120 items')).toBeInTheDocument()
    expect(screen.getByText(/1 will be applied after the restore/)).toBeInTheDocument()
  })

  it('shows a refusal from prepare (other instances) and offers to try again', async () => {
    mockApi({
      'POST /api/v1/backups/20261120T030000Z-auto/restore/prepare': apiError(409, 'other_instances', {
        message: 'Other Spoor instances are connected.',
        hint: 'Stop them first.',
      }),
    })
    open()
    expect(await screen.findByText('Other Spoor instances are connected.')).toBeInTheDocument()
    expect(screen.getByText('Stop them first.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('step 2 needs the exact phrase and a password', async () => {
    const api = mockApi({
      'POST /api/v1/backups/20261120T030000Z-auto/restore/prepare': [200, prepared],
      'POST /api/v1/backups/20261120T030000Z-auto/restore': [202, { restore: status() }],
      'GET /api/v1/backups/restore-status': [200, status()],
    })
    open()
    await toConfirm()
    const submit = screen.getByRole('button', { name: 'Restore database' })
    expect(submit).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/to confirm/), 'RESTORE 2026-11-20 03:0')
    await userEvent.type(screen.getByLabelText('Your password'), 'secret')
    expect(submit).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/to confirm/), '0')
    expect(submit).toBeEnabled()
    await userEvent.click(submit)
    expect(await screen.findByText(/Restoring… you will be logged out/)).toBeInTheDocument()
    expect(api.find('POST', '/api/v1/backups/20261120T030000Z-auto/restore')[0]?.body).toEqual({
      token: 'tok1',
      password: 'secret',
      phrase: 'RESTORE 2026-11-20 03:00',
    })
  })

  it('a wrong password says the confirmation is used up and prepares again', async () => {
    const api = mockApi({
      'POST /api/v1/backups/20261120T030000Z-auto/restore/prepare': [200, prepared],
      'POST /api/v1/backups/20261120T030000Z-auto/restore': apiError(403, 'confirmation_failed', {
        message: 'Confirmation failed.',
      }),
    })
    open()
    await toConfirm()
    await userEvent.type(screen.getByLabelText(/to confirm/), 'RESTORE 2026-11-20 03:00')
    await userEvent.type(screen.getByLabelText('Your password'), 'nope')
    await userEvent.click(screen.getByRole('button', { name: 'Restore database' }))
    expect(await screen.findByText('Confirmation failed.')).toBeInTheDocument()
    expect(screen.getByText(/prepare the restore again/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Prepare again' }))
    await waitFor(() =>
      expect(api.find('POST', '/api/v1/backups/20261120T030000Z-auto/restore/prepare')).toHaveLength(2),
    )
    expect(await screen.findByText('Before you continue')).toBeInTheDocument()
  })

  it('step 3 keeps polling through 503 maintenance and network errors, then goes on when done', async () => {
    mockApi({
      'POST /api/v1/backups/20261120T030000Z-auto/restore/prepare': [200, prepared],
      'POST /api/v1/backups/20261120T030000Z-auto/restore': [
        202,
        { restore: status({ phase: 'pre_restore_backup' }) },
      ],
      'GET /api/v1/backups/restore-status': [
        () => json(200, status({ phase: 'restoring' })),
        () => apiError(503, 'maintenance', { message: 'Maintenance.' }),
        () => {
          throw new TypeError('network down')
        },
        () =>
          json(
            200,
            status({ state: 'done', phase: 'done', maintenance: false, finished_at: '2026-11-26T10:03:00Z' }),
          ),
      ],
    })
    const onDone = open()
    await toConfirm()
    await userEvent.type(screen.getByLabelText(/to confirm/), 'RESTORE 2026-11-20 03:00')
    await userEvent.type(screen.getByLabelText('Your password'), 'pw')
    await userEvent.click(screen.getByRole('button', { name: 'Restore database' }))
    expect(await screen.findByText(/Restoring… you will be logged out/)).toBeInTheDocument()
    expect(await screen.findByText(/The server is not answering at the moment/)).toBeInTheDocument()
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(screen.getByText(/Taking you to the login page/)).toBeInTheDocument()
  })

  async function startRestore() {
    await toConfirm()
    await userEvent.type(screen.getByLabelText(/to confirm/), 'RESTORE 2026-11-20 03:00')
    await userEvent.type(screen.getByLabelText('Your password'), 'pw')
    await userEvent.click(screen.getByRole('button', { name: 'Restore database' }))
  }

  it('a failure with the gate still on says to restart Spoor, not that it rolled back', async () => {
    mockApi({
      'POST /api/v1/backups/20261120T030000Z-auto/restore/prepare': [200, prepared],
      'POST /api/v1/backups/20261120T030000Z-auto/restore': [202, { restore: status() }],
      // redacted by the gate: no error text, no ids
      'GET /api/v1/backups/restore-status': [
        200,
        status({
          state: 'failed',
          phase: 'startup',
          error: null,
          backup_id: null,
          pre_restore_backup_id: null,
        }),
      ],
    })
    const onDone = open()
    await startRestore()
    expect(await screen.findByText('Spoor could not finish the restore')).toBeInTheDocument()
    expect(screen.getByText(/Restart the Spoor app container/)).toBeInTheDocument()
    expect(screen.queryByText(/rolls back/)).not.toBeInTheDocument()
    expect(screen.queryByText('No details were recorded.')).not.toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()
  })

  it('done while the gate is still on does not leave yet; the 401 once it is off does', async () => {
    mockApi({
      'POST /api/v1/backups/20261120T030000Z-auto/restore/prepare': [200, prepared],
      'POST /api/v1/backups/20261120T030000Z-auto/restore': [202, { restore: status() }],
      'GET /api/v1/backups/restore-status': [
        () => json(200, status({ state: 'done', phase: 'done', maintenance: true })),
        () => json(200, status({ state: 'done', phase: 'done', maintenance: true })),
        () => apiError(401, 'unauthenticated', { message: 'Log in first.' }),
      ],
    })
    const onDone = open()
    await startRestore()
    expect(await screen.findByText(/Done…/)).toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('a 503 busy answer to the confirmation used up the token: prepare again', async () => {
    mockApi({
      'POST /api/v1/backups/20261120T030000Z-auto/restore/prepare': [200, prepared],
      'POST /api/v1/backups/20261120T030000Z-auto/restore': apiError(503, 'busy', {
        message: 'A backup is running.',
      }),
    })
    open()
    await startRestore()
    expect(await screen.findByText('A backup is running.')).toBeInTheDocument()
    expect(screen.getByText(/prepare the restore again/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Prepare again' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restore database' })).not.toBeInTheDocument()
  })

  it('shows a failed restore with its error', async () => {
    mockApi({
      'POST /api/v1/backups/20261120T030000Z-auto/restore/prepare': [200, prepared],
      'POST /api/v1/backups/20261120T030000Z-auto/restore': [202, { restore: status() }],
      'GET /api/v1/backups/restore-status': [
        200,
        status({ state: 'failed', phase: null, error: 'psql exited with 3', maintenance: false }),
      ],
    })
    const onDone = open()
    await toConfirm()
    await userEvent.type(screen.getByLabelText(/to confirm/), 'RESTORE 2026-11-20 03:00')
    await userEvent.type(screen.getByLabelText('Your password'), 'pw')
    await userEvent.click(screen.getByRole('button', { name: 'Restore database' }))
    expect(await screen.findByText('The restore failed')).toBeInTheDocument()
    expect(screen.getByText('psql exited with 3')).toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()
  })
})
