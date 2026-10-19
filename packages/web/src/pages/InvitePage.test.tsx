import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { apiError, meFixture, mockApi, renderApp } from '../test/utils'
import { extractInviteToken } from './InvitePage'

const TOKEN = 'spi_abcDEF123_-x'
const preview = (over = {}) => ({
  email: null,
  is_admin: false,
  shared_editor: false,
  reset: false,
  grants: [{ project: { slug: 'acme', name: 'Acme' }, role: 'editor' }],
  expires_at: '2026-10-26T10:00:00Z',
  ...over,
})
const PASSWORD = 'correct horse battery'

describe('extractInviteToken', () => {
  it('finds the token in a fragment, a full link or a bare paste', () => {
    expect(extractInviteToken(`#${TOKEN}`)).toBe(TOKEN)
    expect(extractInviteToken(`https://spoor.example.com/invite#${TOKEN}`)).toBe(TOKEN)
    expect(extractInviteToken('nonsense')).toBeNull()
  })
})

describe('InvitePage', () => {
  it('previews (token in the body, not the URL) and accepts a new account', async () => {
    const m = mockApi({
      'POST /api/v1/invites/preview': [200, preview()],
      'POST /api/v1/invites/accept': [201, { user: meFixture().user }],
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/projects': [200, { items: [] }],
    })
    const { router } = renderApp(`/invite#${TOKEN}`)
    expect(await screen.findByText('Acme')).toBeInTheDocument()
    expect(m.find('POST', '/api/v1/invites/preview')[0]?.body).toEqual({ token: TOKEN })

    await userEvent.type(screen.getByLabelText(/^Name/), 'Ann')
    await userEvent.type(screen.getByLabelText(/^Email/), 'ann@example.com')
    await userEvent.type(screen.getByLabelText(/^Password/), PASSWORD)
    await userEvent.type(screen.getByLabelText(/^Repeat/), PASSWORD)
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/projects')
    expect(m.find('POST', '/api/v1/invites/accept')[0]?.body).toEqual({
      token: TOKEN,
      password: PASSWORD,
      name: 'Ann',
      email: 'ann@example.com',
    })
  })

  it('validates the password locally and explains an existing account', async () => {
    const m = mockApi({
      'POST /api/v1/invites/preview': [200, preview({ email: 'ann@example.com' })],
      'POST /api/v1/invites/accept': apiError(409, 'already_exists'),
    })
    renderApp(`/invite#${TOKEN}`)
    expect(await screen.findByDisplayValue('ann@example.com')).toHaveAttribute('readonly')
    await userEvent.type(screen.getByLabelText(/^Name/), 'Ann')
    await userEvent.type(screen.getByLabelText(/^Password/), 'short')
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText(/Use 12 to 256 characters/)).toBeInTheDocument()
    expect(m.find('POST', '/api/v1/invites/accept')).toHaveLength(0)

    await userEvent.clear(screen.getByLabelText(/^Password/))
    await userEvent.type(screen.getByLabelText(/^Password/), PASSWORD)
    await userEvent.type(screen.getByLabelText(/^Repeat/), PASSWORD)
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText(/An account with this email already exists/)).toBeInTheDocument()
    // a locked invite does not send an email
    expect(m.find('POST', '/api/v1/invites/accept')[0]?.body).toEqual({
      token: TOKEN,
      password: PASSWORD,
      name: 'Ann',
    })
  })

  it('reset variant: only a new password', async () => {
    const m = mockApi({
      'POST /api/v1/invites/preview': [200, preview({ reset: true, email: 'bob@example.com', grants: [] })],
      'POST /api/v1/invites/accept': [201, { user: meFixture().user }],
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/projects': [200, { items: [] }],
    })
    renderApp(`/invite#${TOKEN}`)
    expect(await screen.findByRole('heading', { name: 'Set a new password' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/^Name/)).not.toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/^New password/), PASSWORD)
    await userEvent.type(screen.getByLabelText(/^Repeat/), PASSWORD)
    await userEvent.click(screen.getByRole('button', { name: 'Set password and log in' }))
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument()
    expect(m.find('POST', '/api/v1/invites/accept')[0]?.body).toEqual({ token: TOKEN, password: PASSWORD })
  })

  it('explains an invalid link', async () => {
    mockApi({ 'POST /api/v1/invites/preview': apiError(404, 'not_found') })
    renderApp(`/invite#${TOKEN}`)
    expect(await screen.findByText('This invite link is not valid')).toBeInTheDocument()
  })

  it('asks for the link when there is no token', async () => {
    const m = mockApi({ 'POST /api/v1/invites/preview': [200, preview()] })
    renderApp('/invite')
    await userEvent.type(await screen.findByLabelText('Invite link'), `https://x.example/invite#${TOKEN}`)
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('Acme')).toBeInTheDocument()
    expect(m.find('POST', '/api/v1/invites/preview')).toHaveLength(1)
  })
})
