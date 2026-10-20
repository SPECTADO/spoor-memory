import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { apiError, meFixture, mockApi, renderInRouter } from '../../test/utils'
import { MembersPanel } from './MembersPanel'

const member = (id: string, email: string, role: string, library_editor = false) => ({
  user: { id, email, name: email.split('@')[0] },
  role,
  library_editor,
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

describe('MembersPanel library editor', () => {
  const list = (items: unknown[]) => [200, { items }] as [number, unknown]
  const library = (email: string) => screen.findByLabelText(`Library editor ${email}`)

  it('shows admin rows checked and disabled with the tooltip', async () => {
    mockApi({
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/projects/acme/members': list([member('u1', 'ann@example.com', 'admin')]),
    })
    renderInRouter(<MembersPanel slug="acme" />, '/projects/acme/members')
    const box = await library('ann@example.com')
    expect(box).toBeChecked()
    expect(box).toBeDisabled()
    expect(box).toHaveAttribute('title', 'Admins can always edit the library')
  })

  it('sends PUT {library_editor} when toggled', async () => {
    const m = mockApi({
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/projects/acme/members': [
        list([member('u2', 'bob@example.com', 'viewer')]),
        list([member('u2', 'bob@example.com', 'viewer', true)]),
      ],
      'PUT /api/v1/projects/acme/members/u2': [200, member('u2', 'bob@example.com', 'viewer', true)],
    })
    renderInRouter(<MembersPanel slug="acme" />, '/projects/acme/members')
    const box = await library('bob@example.com')
    expect(box).not.toBeChecked()
    await userEvent.click(box)
    await waitFor(() =>
      expect(m.find('PUT', '/api/v1/projects/acme/members/u2')[0]?.body).toEqual({ library_editor: true }),
    )
    await waitFor(() => expect(box).toBeChecked())
  })

  it('rolls the toggle back when the server fails', async () => {
    mockApi({
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/projects/acme/members': list([member('u2', 'bob@example.com', 'editor')]),
      'PUT /api/v1/projects/acme/members/u2': apiError(500, 'internal', { message: 'boom' }),
    })
    renderInRouter(<MembersPanel slug="acme" />, '/projects/acme/members')
    const box = await library('bob@example.com')
    await userEvent.click(box)
    expect(await screen.findByText('boom')).toBeInTheDocument()
    await waitFor(() => expect(box).not.toBeChecked())
  })

  it('warns when a role change leaves admin, and sends the role only', async () => {
    const m = mockApi({
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/projects/acme/members': list([
        member('u1', 'ann@example.com', 'admin'),
        member('u3', 'cy@example.com', 'admin'),
      ]),
      'PUT /api/v1/projects/acme/members/u1': [200, member('u1', 'ann@example.com', 'editor')],
    })
    renderInRouter(<MembersPanel slug="acme" />, '/projects/acme/members')
    await userEvent.selectOptions(await screen.findByLabelText('Role of ann@example.com'), 'editor')
    expect(
      await screen.findByText(
        'Library editing is not kept after leaving admin; tick Library editor to grant it.',
      ),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(m.find('PUT', '/api/v1/projects/acme/members/u1')[0]?.body).toEqual({ role: 'editor' }),
    )
  })

  it('the add form sends library_editor only when ticked, and hides it for admin', async () => {
    const m = mockApi({
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/projects/acme/members': list([]),
      'POST /api/v1/projects/acme/members': [201, member('u9', 'new@example.com', 'editor', true)],
    })
    renderInRouter(<MembersPanel slug="acme" />, '/projects/acme/members')
    await userEvent.type(await screen.findByLabelText('Add member by email'), 'new@example.com')
    await userEvent.click(screen.getByLabelText('Library editor'))
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))
    await waitFor(() =>
      expect(m.find('POST', '/api/v1/projects/acme/members')[0]?.body).toEqual({
        email: 'new@example.com',
        role: 'editor',
        library_editor: true,
      }),
    )
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'admin')
    expect(screen.queryByLabelText('Library editor')).not.toBeInTheDocument()
  })
})
