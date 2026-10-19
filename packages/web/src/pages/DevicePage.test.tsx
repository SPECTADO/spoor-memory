import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { apiError, meFixture, mockApi, renderApp } from '../test/utils'
import { normalizeUserCode } from './DevicePage'

const lookup = {
  project: { slug: 'acme', name: 'Acme' },
  client_name: 'spoor-cli/0.1.0',
  requester_ip: '203.0.113.7',
  requested_at: '2026-10-19T10:00:00Z',
  age_s: 125,
  your_role: 'editor',
}

describe('normalizeUserCode', () => {
  it('accepts the code with or without dash, any case', () => {
    expect(normalizeUserCode('wdjb-mjht')).toBe('WDJBMJHT')
    expect(normalizeUserCode(' WDJB MJHT ')).toBe('WDJBMJHT')
    expect(normalizeUserCode('WDJB-MJH')).toBeNull()
    expect(normalizeUserCode('AAAA-AAAA')).toBeNull() // vowels are not in the alphabet
  })
})

describe('DevicePage', () => {
  it('ignores ?code= and rejects malformed codes without calling the server', async () => {
    const m = mockApi({ 'GET /api/v1/me': [200, meFixture()] })
    renderApp('/device?code=WDJBMJHT')
    const input = await screen.findByLabelText(/^Code/)
    expect(input).toHaveValue('')
    await userEvent.type(input, 'abc')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText(/A code has 8 letters/)).toBeInTheDocument()
    expect(m.find('GET', '/api/v1/device/lookup')).toHaveLength(0)
  })

  it('shows who asked and approves read-only by default', async () => {
    const m = mockApi({
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/device/lookup': [200, lookup],
      'POST /api/v1/device/approve': [200, { status: 'approved', role_cap: 'viewer' }],
    })
    renderApp('/device')
    await userEvent.type(await screen.findByLabelText(/^Code/), 'wdjb-mjht')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('203.0.113.7')).toBeInTheDocument()
    expect(screen.getByText('2 minutes ago')).toBeInTheDocument()
    expect(screen.getByText('spoor-cli/0.1.0')).toBeInTheDocument()
    expect(screen.getByText('reported by the requester (unverified)')).toBeInTheDocument()
    expect(m.find('GET', '/api/v1/device/lookup')[0]?.url.search).toBe('?code=WDJBMJHT')

    const readOnly = screen.getByRole('button', { name: 'Approve read-only' })
    expect(readOnly).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByText(/Approved \(read-only\) for Acme/)).toBeInTheDocument()
    expect(m.find('POST', '/api/v1/device/approve')[0]?.body).toEqual({ code: 'WDJBMJHT', read_only: true })
  })

  it('denies', async () => {
    const m = mockApi({
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/device/lookup': [200, lookup],
      'POST /api/v1/device/deny': [200, { status: 'denied' }],
    })
    renderApp('/device')
    await userEvent.type(await screen.findByLabelText(/^Code/), 'WDJBMJHT')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Deny' }))
    expect(await screen.findByText('Denied for Acme')).toBeInTheDocument()
    expect(m.find('POST', '/api/v1/device/deny')[0]?.body).toEqual({ code: 'WDJBMJHT' })
  })

  it('explains an unknown code and the lock', async () => {
    mockApi({
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/device/lookup': [
        apiError(404, 'not_found'),
        apiError(403, 'forbidden', {
          message: 'Too many wrong codes.',
          hint: 'Code lookup is locked for your account for 10 more minutes.',
        }),
      ],
    })
    renderApp('/device')
    await userEvent.type(await screen.findByLabelText(/^Code/), 'WDJBMJHT')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('No pending login for WDJB-MJHT')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Enter another code' }))
    await userEvent.type(await screen.findByLabelText(/^Code/), 'BCDFGHJK')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText(/locked for your account/)).toBeInTheDocument()
  })

  it('sends a logged-out visitor to login and back to /device', async () => {
    mockApi({ 'GET /api/v1/me': apiError(401, 'unauthenticated') })
    const { router } = renderApp('/device')
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument()
    expect(router.state.location.search).toBe('?next=%2Fdevice')
  })
})
