import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { meFixture, mockApi, renderInRouter } from '../../test/utils'
import { TokensPanel } from './TokensPanel'

const SECRET = 'spr_Zk3Qm9Wd1xT7vB2nHj5LrP8sYc4Af6GuEoIiKtN0wXe'

const project = {
  id: 'p1',
  slug: 'acme',
  name: 'Acme',
  description: '',
  kind: 'project',
  settings: {},
  role: 'admin',
  embedding: { model: 'm', target: null, remaining: 0 },
  created_at: '2026-10-01T00:00:00Z',
}

const token = {
  id: 't1',
  kind: 'user',
  origin: 'web',
  name: 'laptop',
  prefix: 'spr_Zk3Qm9Wd',
  role: null,
  user: { id: 'u1', label: 'ann@example.com' },
  created_at: '2026-10-19T10:00:00Z',
  last_used_at: null,
  expires_at: null,
  revoked_at: null,
}

function setup() {
  let created = false
  const api = mockApi({
    'GET /api/v1/me': [200, meFixture({ is_admin: true })],
    'GET /api/v1/projects/acme': [200, project],
    'GET /api/v1/projects/acme/tokens': () =>
      new Response(JSON.stringify({ items: created ? [token] : [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    'POST /api/v1/projects/acme/tokens': () => {
      created = true
      return new Response(JSON.stringify({ token, secret: SECRET }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })
  renderInRouter(<TokensPanel slug="acme" />, '/projects/acme/tokens')
  return api
}

describe('TokensPanel secret shown once', () => {
  it('shows the secret after creating, blocks closing until it is confirmed copied, then drops it', async () => {
    const api = setup()
    await userEvent.click(await screen.findByRole('button', { name: 'New token' }))
    await userEvent.type(await screen.findByLabelText(/^Name/), 'laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }))

    const field = await screen.findByLabelText('Token')
    expect(field).toHaveValue(SECRET)
    expect(screen.getByText(/only time you can see it/i)).toBeInTheDocument()
    expect(api.find('POST', '/api/v1/projects/acme/tokens')[0]?.body).toEqual({
      kind: 'user',
      name: 'laptop',
    })

    // cannot be closed before the copy is confirmed: no close button, Done disabled
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    const done = screen.getByRole('button', { name: 'Done' })
    expect(done).toBeDisabled()
    await userEvent.click(screen.getByLabelText('I have copied it'))
    expect(done).toBeEnabled()
    await userEvent.click(done)

    // the secret is gone from the page; the list only has the prefix
    await waitFor(() => expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument())
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument()
    expect(await screen.findByText('spr_Zk3Qm9Wd…')).toBeInTheDocument()
  })

  it('sends a read-only user token with an expiry and a service token with its role', async () => {
    const api = setup()
    await userEvent.click(await screen.findByRole('button', { name: 'New token' }))
    await userEvent.type(await screen.findByLabelText(/^Name/), 'ci')
    await userEvent.selectOptions(screen.getByLabelText('Kind'), 'service')
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'editor')
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }))
    await screen.findByLabelText('Token')
    expect(api.find('POST', '/api/v1/projects/acme/tokens')[0]?.body).toEqual({
      kind: 'service',
      name: 'ci',
      role: 'editor',
    })
  })

  it('rejects an expiry in the past without calling the server', async () => {
    const api = setup()
    await userEvent.click(await screen.findByRole('button', { name: 'New token' }))
    await userEvent.type(await screen.findByLabelText(/^Name/), 'old')
    await userEvent.type(screen.getByLabelText(/^Expires/), '2020-01-01T10:00')
    await userEvent.click(screen.getByRole('button', { name: 'Create token' }))
    expect(await screen.findByText('Pick a time in the future.')).toBeInTheDocument()
    expect(api.find('POST', '/api/v1/projects/acme/tokens')).toHaveLength(0)
  })
})
