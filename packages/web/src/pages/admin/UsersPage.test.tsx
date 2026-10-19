import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { apiError, meFixture, mockApi, renderApp } from '../../test/utils'

const user = (id: string, email: string, over: Record<string, unknown> = {}) => ({
  id,
  email,
  name: email.split('@')[0],
  is_admin: false,
  shared_editor: false,
  disabled_at: null,
  created_at: '2026-10-01T00:00:00Z',
  memberships: [{ project: { id: 'p1', slug: 'acme', name: 'Acme' }, role: 'editor' }],
  ...over,
})

describe('AdminUsersPage', () => {
  it('shows last_admin inline when demoting the last instance admin', async () => {
    mockApi({
      'GET /api/v1/me': [200, meFixture({ is_admin: true })],
      'GET /api/v1/users': [
        200,
        {
          items: [user('u1', 'ann@example.com', { is_admin: true }), user('u2', 'bob@example.com')],
          next_cursor: null,
        },
      ],
      'PATCH /api/v1/users/u1': apiError(409, 'last_admin', { message: 'This is the last instance admin.' }),
    })
    renderApp('/admin/users')
    await userEvent.click(await screen.findByLabelText('Instance admin: ann@example.com'))
    expect(await screen.findByText(/ann@example.com: This is the last instance admin\./)).toBeInTheDocument()
  })

  it('creates a reset invite for a user and shows the link once', async () => {
    const api = mockApi({
      'GET /api/v1/me': [200, meFixture({ is_admin: true })],
      'GET /api/v1/users': [200, { items: [user('u2', 'bob@example.com')], next_cursor: null }],
      'POST /api/v1/invites': [
        201,
        { invite: { id: 'i1' }, token: 'spi_x', link: 'https://spoor.example/invite#spi_x' },
      ],
    })
    renderApp('/admin/users')
    await userEvent.click(await screen.findByRole('button', { name: 'Create reset invite' }))
    const dialog = await screen.findByRole('dialog', { name: /Reset invite for bob@example.com/ })
    expect(within(dialog).getByLabelText(/revoke this user's API tokens/)).toBeChecked()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create invite' }))
    expect(await screen.findByLabelText('Invite link')).toHaveValue('https://spoor.example/invite#spi_x')
    await waitFor(() => expect(api.find('POST', '/api/v1/invites')).toHaveLength(1))
    expect(api.find('POST', '/api/v1/invites')[0]?.body).toEqual({
      expires_in_hours: 168,
      grants: [],
      reset_user_id: 'u2',
      reset_revoke_tokens: true,
    })
  })

  it('is a Forbidden page for a non-admin', async () => {
    mockApi({ 'GET /api/v1/me': [200, meFixture()] })
    renderApp('/admin/users')
    expect(await screen.findByText(/do not have access/i)).toBeInTheDocument()
  })
})
