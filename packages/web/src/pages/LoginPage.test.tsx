import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { apiError, meFixture, mockApi, renderApp } from '../test/utils'

async function fill() {
  await userEvent.type(await screen.findByLabelText(/Email/), 'ann@example.com')
  await userEvent.type(screen.getByLabelText(/Password/), 'secret secret secret')
  await userEvent.click(screen.getByRole('button', { name: 'Log in' }))
}

describe('LoginPage', () => {
  it('shows one message for wrong credentials', async () => {
    const m = mockApi({ 'POST /api/v1/auth/login': apiError(401, 'invalid_credentials') })
    renderApp('/login')
    await fill()
    expect(await screen.findByText('Wrong email or password.')).toBeInTheDocument()
    expect(m.find('POST', '/api/v1/auth/login')[0]?.body).toEqual({
      email: 'ann@example.com',
      password: 'secret secret secret',
    })
  })

  it('ignores a next= that is not an in-app path', async () => {
    mockApi({
      'POST /api/v1/auth/login': [200, { user: meFixture().user }],
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/projects': [200, { items: [] }],
    })
    const { router } = renderApp('/login?next=//evil.example/x')
    await fill()
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/projects')
  })
})
