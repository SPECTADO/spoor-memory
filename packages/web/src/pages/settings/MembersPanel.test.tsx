import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { apiError, meFixture, mockApi, renderInRouter } from '../../test/utils'
import { MembersPanel } from './MembersPanel'

const member = (id: string, email: string, role: string) => ({
  user: { id, email, name: email.split('@')[0] },
  role,
  created_at: '2026-10-01T00:00:00Z',
})

describe('MembersPanel', () => {
  it('offers an invite when the email has no account', async () => {
    mockApi({
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/projects/acme/members': [200, { items: [member('u1', 'ann@example.com', 'admin')] }],
      'POST /api/v1/projects/acme/members': apiError(404, 'user_not_found', {
        message: 'No user with this email.',
        hint: 'create an invite instead',
      }),
    })
    renderInRouter(<MembersPanel slug="acme" />, '/projects/acme/members')
    await userEvent.type(await screen.findByLabelText('Add member by email'), 'new@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Create an invite instead' }))
    const dialog = await screen.findByRole('dialog', { name: 'Invite someone' })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByLabelText('Email (optional)')).toHaveValue('new@example.com')
  })

  it('explains the last-admin rule inline and rolls the role back', async () => {
    mockApi({
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/projects/acme/members': [200, { items: [member('u1', 'ann@example.com', 'admin')] }],
      'PUT /api/v1/projects/acme/members/u1': apiError(409, 'last_admin', { message: 'last admin' }),
    })
    renderInRouter(<MembersPanel slug="acme" />, '/projects/acme/members')
    const select = await screen.findByLabelText('Role of ann@example.com')
    await userEvent.selectOptions(select, 'viewer')
    expect(await screen.findByText(/last project admin/)).toBeInTheDocument()
    await waitFor(() => expect(select).toHaveValue('admin'))
  })
})
