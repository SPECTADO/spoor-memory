import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { apiError, json, meFixture, mockApi, renderApp } from '../../test/utils'

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: id.endsWith('manual') ? 'manual' : 'auto',
  created_at: '2026-11-20T03:00:00.000Z',
  size_bytes: 2_048_000,
  pinned: false,
  verified_at: '2026-11-20T03:05:00.000Z',
  spoor_version: '0.8.0',
  migration: { count: 11, last_tag: '0010_backups' },
  pg_server_version: '17.6',
  projects: 3,
  projects_skipped: 0,
  restorable: true,
  protected: false,
  ...over,
})

const status = (over: Record<string, unknown> = {}) => ({
  available: true,
  dir: '/var/lib/spoor/backups',
  free_bytes: 5_000_000_000,
  pg_dump_version: 'pg_dump (PostgreSQL) 17.6',
  server_version: '17.6',
  last_good_at: '2026-11-20T03:05:00.000Z',
  next_due_at: '2026-11-21T03:00:00.000Z',
  overdue: false,
  running: null,
  ...over,
})

const settings = (over: Record<string, unknown> = {}) => ({
  enabled: false,
  time_utc: '03:00',
  tiers: [
    { every: '24h', keep: 3 },
    { every: '7d', keep: 2 },
  ],
  project_archives: true,
  ...over,
})

const listBody = (
  over: { status?: Record<string, unknown>; settings?: Record<string, unknown>; items?: unknown[] } = {},
) => ({
  status: status(over.status),
  settings: settings(over.settings),
  items: over.items ?? [item('20261120T030000Z-auto'), item('20261121T101500Z-manual', { pinned: true })],
})

const admin = { 'GET /api/v1/me': [200, meFixture({ is_admin: true })] as [number, unknown] }

describe('AdminBackupsPage', () => {
  it('is a Forbidden page for a non-admin', async () => {
    mockApi({ 'GET /api/v1/me': [200, meFixture()] })
    renderApp('/admin/backups')
    expect(await screen.findByText(/do not have access/i)).toBeInTheDocument()
  })

  it('shows the status card and the backup table', async () => {
    mockApi({ ...admin, 'GET /api/v1/backups': [200, listBody()] })
    renderApp('/admin/backups')
    expect(await screen.findByText('/var/lib/spoor/backups')).toBeInTheDocument()
    expect(screen.getByText('scheduled backups are off')).toBeInTheDocument()
    const table = screen.getByRole('table', { name: 'Backups, newest first' })
    expect(within(table).getByText('auto')).toBeInTheDocument()
    expect(within(table).getByText('manual')).toBeInTheDocument()
    expect(within(table).getByText('Pinned')).toBeInTheDocument()
    expect(within(table).queryByRole('link', { name: /download/i })).not.toBeInTheDocument()
  })

  it('explains why backups are unavailable and disables the actions', async () => {
    mockApi({
      ...admin,
      'GET /api/v1/backups': [
        200,
        listBody({ status: { available: false, reason: 'pg_tools_missing', dir: null }, items: [] }),
      ],
    })
    renderApp('/admin/backups')
    expect(await screen.findByText('Backups are not available')).toBeInTheDocument()
    expect(screen.getByText(/pg_dump, pg_restore or psql was not found/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled()
    expect(screen.getByText('No backups yet.')).toBeInTheDocument()
  })

  it('warns when the last good backup is overdue', async () => {
    mockApi({
      ...admin,
      'GET /api/v1/backups': [200, listBody({ status: { overdue: true }, settings: { enabled: true } })],
    })
    renderApp('/admin/backups')
    expect(await screen.findByText('The last good backup is overdue')).toBeInTheDocument()
  })

  it('Back up now starts a manual backup', async () => {
    const api = mockApi({
      ...admin,
      'GET /api/v1/backups': [200, listBody()],
      'POST /api/v1/backups': [
        202,
        { backup: { id: 'x-manual', kind: 'manual', started_at: '2026-11-26T10:00:00Z' } },
      ],
    })
    renderApp('/admin/backups')
    await userEvent.click(await screen.findByRole('button', { name: 'Back up now' }))
    await waitFor(() => expect(api.find('POST', '/api/v1/backups')).toHaveLength(1))
    expect(await screen.findByText('Backup started.')).toBeInTheDocument()
  })

  it('pins and unpins a backup with PATCH', async () => {
    const api = mockApi({
      ...admin,
      'GET /api/v1/backups': [200, listBody()],
      'PATCH /api/v1/backups/20261120T030000Z-auto': [200, item('20261120T030000Z-auto', { pinned: true })],
    })
    renderApp('/admin/backups')
    await userEvent.click(await screen.findByRole('button', { name: 'Pin backup 20261120T030000Z-auto' }))
    await waitFor(() =>
      expect(api.find('PATCH', '/api/v1/backups/20261120T030000Z-auto')[0]?.body).toEqual({ pinned: true }),
    )
  })

  it('verify reports a failure with its problems', async () => {
    mockApi({
      ...admin,
      'GET /api/v1/backups': [200, listBody()],
      'POST /api/v1/backups/20261120T030000Z-auto/verify': [
        200,
        { ok: false, problems: ['database.dump: sha256 mismatch'], item: item('20261120T030000Z-auto') },
      ],
    })
    renderApp('/admin/backups')
    await userEvent.click(await screen.findByRole('button', { name: 'Verify backup 20261120T030000Z-auto' }))
    expect(await screen.findByText(/database.dump: sha256 mismatch/)).toBeInTheDocument()
  })

  it('deletes a backup after a confirmation', async () => {
    const api = mockApi({
      ...admin,
      'GET /api/v1/backups': [200, listBody()],
      'DELETE /api/v1/backups/20261120T030000Z-auto': [204],
    })
    renderApp('/admin/backups')
    await userEvent.click(await screen.findByRole('button', { name: 'Delete backup 20261120T030000Z-auto' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete this backup?' })
    expect(api.find('DELETE', '/api/v1/backups/20261120T030000Z-auto')).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete backup' }))
    await waitFor(() => expect(api.find('DELETE', '/api/v1/backups/20261120T030000Z-auto')).toHaveLength(1))
  })

  it('disables Restore for a backup newer than the server', async () => {
    mockApi({
      ...admin,
      'GET /api/v1/backups': [
        200,
        listBody({ items: [item('20261120T030000Z-auto', { restorable: false })] }),
      ],
    })
    renderApp('/admin/backups')
    expect(await screen.findByRole('button', { name: 'Restore backup 20261120T030000Z-auto' })).toBeDisabled()
    expect(screen.getByText('Newer than this server')).toBeInTheDocument()
  })

  it('a full restore dialog stays when the list answers 503 maintenance, and shows the outcome', async () => {
    const id = '20261120T030000Z-auto'
    const restoreStatus = (over: Record<string, unknown>) => ({
      state: 'running',
      phase: 'restoring',
      backup_id: null,
      pre_restore_backup_id: null,
      started_at: null,
      finished_at: null,
      error: null,
      maintenance: true,
      ...over,
    })
    const api = mockApi({
      ...admin,
      'GET /api/v1/backups': [
        () => json(200, listBody()),
        () => apiError(503, 'maintenance', { message: 'A full restore is running.' }),
      ],
      [`POST /api/v1/backups/${id}/restore/prepare`]: [
        200,
        {
          token: 'tok',
          expires_at: '2026-11-26T10:05:00Z',
          phrase: 'RESTORE 2026-11-20 03:00',
          backup: item(id),
          summary: {
            created_at: '2026-11-20T03:00:00.000Z',
            spoor_version: '0.8.0',
            migration: {
              backup: { count: 11, last_tag: '0010_backups' },
              current: { count: 11, last_tag: '0010_backups' },
              to_apply: 0,
            },
            projects: 3,
            items: 10,
            pre_restore_backup: true,
          },
          warnings: [{ code: 'data_loss', message: 'Everything after is lost.' }],
        },
      ],
      [`POST /api/v1/backups/${id}/restore`]: [
        202,
        { restore: restoreStatus({ phase: 'pre_restore_backup' }) },
      ],
      'GET /api/v1/backups/restore-status': [
        () => json(200, restoreStatus({})),
        () => json(200, restoreStatus({ state: 'failed', phase: null })),
      ],
    })
    const { qc } = renderApp('/admin/backups')
    await userEvent.click(await screen.findByRole('button', { name: `Restore backup ${id}` }))
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await userEvent.type(screen.getByLabelText(/to confirm/), 'RESTORE 2026-11-20 03:00')
    await userEvent.type(screen.getByLabelText('Your password'), 'pw')
    await userEvent.click(screen.getByRole('button', { name: 'Restore database' }))
    expect(await screen.findByText(/Restoring… you will be logged out/)).toBeInTheDocument()
    // the list poll lands in the gate (and its one retry too)
    await act(() => qc.refetchQueries({ queryKey: ['backups'], exact: true }).catch(() => {}))
    await waitFor(() => expect(api.find('GET', '/api/v1/backups').length).toBeGreaterThanOrEqual(3), {
      timeout: 5000,
    })
    await waitFor(() => expect(qc.getQueryState(['backups'])?.status).toBe('error'), { timeout: 5000 })
    expect(screen.getByText(/Restoring… you will be logged out/)).toBeInTheDocument()
    // the next restore-status answer: failed after the commit (the gate still on)
    await act(() =>
      qc.refetchQueries({ queryKey: ['backups', 'restore-status'], exact: true }).catch(() => {}),
    )
    expect(await screen.findByText('Spoor could not finish the restore')).toBeInTheDocument()
  }, 15_000)

  describe('schedule form', () => {
    it('previews how many backups it keeps and saves the whole settings object', async () => {
      const api = mockApi({
        ...admin,
        'GET /api/v1/backups': [200, listBody()],
        'PUT /api/v1/backups/settings': (req) =>
          json(200, { settings: req.body, next_due_at: '2026-11-27T03:00:00.000Z' }),
      })
      renderApp('/admin/backups')
      expect(await screen.findByText(/Keeps up to 5 scheduled backups/)).toBeInTheDocument()
      await userEvent.click(screen.getByRole('switch', { name: 'Back up automatically' }))
      const keep = screen.getByLabelText('Tier 1: keep')
      await userEvent.clear(keep)
      await userEvent.type(keep, '7')
      expect(screen.getByText(/Keeps up to 9 scheduled backups/)).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Save schedule' }))
      await waitFor(() => expect(api.find('PUT', '/api/v1/backups/settings')).toHaveLength(1))
      expect(api.find('PUT', '/api/v1/backups/settings')[0]?.body).toEqual({
        enabled: true,
        time_utc: '03:00',
        tiers: [
          { every: '24h', keep: 7 },
          { every: '7d', keep: 2 },
        ],
        project_archives: true,
      })
    })

    it('adds a tier with an unused interval (up to three) and removes tiers (down to one)', async () => {
      mockApi({ ...admin, 'GET /api/v1/backups': [200, listBody()] })
      renderApp('/admin/backups')
      await userEvent.click(await screen.findByRole('button', { name: 'Add tier' }))
      expect(screen.getByLabelText('Tier 3: every')).toHaveValue('48h')
      expect(screen.getByRole('button', { name: 'Add tier' })).toBeDisabled()
      await userEvent.click(screen.getByRole('button', { name: 'Remove tier 3' }))
      await userEvent.click(screen.getByRole('button', { name: 'Remove tier 2' }))
      expect(screen.getByRole('button', { name: 'Remove tier 1' })).toBeDisabled()
    })

    it('does not allow the same interval twice and blocks saving an invalid keep', async () => {
      mockApi({ ...admin, 'GET /api/v1/backups': [200, listBody()] })
      renderApp('/admin/backups')
      const keep = await screen.findByLabelText('Tier 1: keep')
      await userEvent.clear(keep)
      await userEvent.type(keep, '0')
      expect(screen.getByRole('button', { name: 'Save schedule' })).toBeDisabled()
      expect(screen.getByText(/Fix the highlighted fields/)).toBeInTheDocument()
      // the interval of the other tier is not selectable
      const every = screen.getByLabelText('Tier 1: every')
      expect(within(every).getByRole('option', { name: 'Every week (7 d)' })).toBeDisabled()
    })

    it('shows a server refusal', async () => {
      mockApi({
        ...admin,
        'GET /api/v1/backups': [200, listBody()],
        'PUT /api/v1/backups/settings': apiError(400, 'invalid_input', { message: 'Invalid settings.' }),
      })
      renderApp('/admin/backups')
      await userEvent.click(await screen.findByRole('button', { name: 'Save schedule' }))
      expect(await screen.findByText('Invalid settings.')).toBeInTheDocument()
    })
  })
})
