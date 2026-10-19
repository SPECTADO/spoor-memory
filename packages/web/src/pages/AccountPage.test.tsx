import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { apiError, meFixture, mockApi, renderApp } from '../test/utils'

const token = (id: string, over = {}) => ({
  id,
  kind: 'user',
  origin: 'device',
  name: `laptop-${id}`,
  prefix: `spr_${id}abcdefg`.slice(0, 12),
  role: 'viewer',
  user: { id: 'u1', label: 'ann@example.com' },
  created_at: '2026-10-01T00:00:00Z',
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
  ...over,
})
const projects = {
  items: [
    {
      slug: 'acme',
      name: 'Acme',
      description: '',
      role: 'admin',
      counts: { memories: 0, decisions: 0, docs: 0 },
      review_total: 0,
    },
    {
      slug: 'beta',
      name: 'Beta',
      description: '',
      role: 'viewer',
      counts: { memories: 0, decisions: 0, docs: 0 },
      review_total: 0,
    },
  ],
}

describe('AccountPage', () => {
  it("lists only the caller's own active user tokens across projects and revokes one", async () => {
    const m = mockApi({
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/projects': [200, projects],
      // a project admin sees everyone's tokens; only u1's user tokens belong on this page
      'GET /api/v1/projects/acme/tokens': [
        200,
        {
          items: [
            token('a1'),
            token('a2', { user: { id: 'u2', label: 'bob@example.com' } }),
            token('a3', { kind: 'service', user: null }),
          ],
        },
      ],
      'GET /api/v1/projects/beta/tokens': [
        [200, { items: [token('b1', { origin: 'web', role: null })] }],
        [200, { items: [] }],
      ],
      'DELETE /api/v1/projects/beta/tokens/b1': [204],
    })
    renderApp('/account')
    const table = await screen.findByRole('table', { name: 'My API tokens' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getAllByRole('cell')[1]?.textContent)).toEqual([
      'laptop-a1',
      'laptop-b1',
    ])
    expect(within(rows[0] as HTMLElement).getByText('read-only')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('my role')).toBeInTheDocument()

    await userEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'Revoke' }))
    const dialog = await screen.findByRole('dialog', { name: 'Revoke token?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(within(table).queryByText('laptop-b1')).not.toBeInTheDocument())
    expect(m.find('DELETE', '/api/v1/projects/beta/tokens/b1')).toHaveLength(1)
    expect(await screen.findByText('Token "laptop-b1" revoked.')).toBeInTheDocument()
  })

  it('changes the password and maps a wrong current password to its field', async () => {
    const m = mockApi({
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/projects': [200, { items: [] }],
      'POST /api/v1/me/password': [apiError(401, 'invalid_credentials'), [204]],
    })
    renderApp('/account')
    const current = await screen.findByLabelText('Current password')
    await userEvent.type(current, 'wrong')
    await userEvent.type(screen.getByLabelText(/^New password/), 'a brand new password')
    await userEvent.type(screen.getByLabelText('Repeat the new password'), 'a brand new password')
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }))
    expect(await screen.findByText('The current password is wrong.')).toBeInTheDocument()
    expect(current).toHaveAttribute('aria-invalid', 'true')

    await userEvent.click(screen.getByRole('button', { name: 'Change password' }))
    expect(await screen.findByText('Password changed.')).toBeInTheDocument()
    expect(m.find('POST', '/api/v1/me/password')[1]?.body).toEqual({
      current_password: 'wrong',
      new_password: 'a brand new password',
    })
    expect(screen.getByLabelText('Current password')).toHaveValue('')
  })

  it('saves the name', async () => {
    const m = mockApi({
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/projects': [200, { items: [] }],
      'PATCH /api/v1/me': [200, { user: { ...meFixture().user, name: 'Ann B' } }],
    })
    renderApp('/account')
    const name = await screen.findByLabelText('Name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Ann B')
    await userEvent.click(screen.getByRole('button', { name: 'Save name' }))
    expect(await screen.findByText('Name saved.')).toBeInTheDocument()
    expect(m.find('PATCH', '/api/v1/me')[0]?.body).toEqual({ name: 'Ann B' })
  })
})
