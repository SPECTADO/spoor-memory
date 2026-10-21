import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { projectFixture } from '../test/browseFixtures'
import { meFixture, mockApi, renderApp } from '../test/utils'

const row = {
  id: 7,
  at: '2026-10-20T08:00:00Z',
  kind: 'write',
  surface: 'mcp',
  operation: 'spoor_remember',
  actor: {
    user_id: 'u',
    label: 'ann@example.com',
    token: { id: 't', name: 'laptop', prefix: 'spr_abcdefgh' },
    client_name: 'claude-code/2.1',
  },
  space: 'memories',
  memory_type: 'fact',
  handles: ['m9'],
  query: null,
  outcome: 'ok',
  duration_ms: 12,
  data: {},
}
const failed = {
  ...row,
  id: 6,
  kind: 'read',
  operation: 'spoor_search',
  handles: [],
  space: null,
  memory_type: null,
  query: 'retries',
  outcome: 'invalid_input',
}

const setup = (role: 'viewer' | 'admin') =>
  mockApi({
    'GET /api/v1/me': [200, meFixture({}, [{ project: { id: 'p-acme', slug: 'acme', name: 'Acme' }, role }])],
    'GET /api/v1/projects/acme': [200, projectFixture('acme', role)],
    'GET /api/v1/projects/acme/requests': [200, { items: [row, failed], next_cursor: null }],
  })

describe('RequestLogPage', () => {
  it('lists agent requests with actor, token, agent, items and outcome', async () => {
    setup('admin')
    renderApp('/projects/acme/requests')
    const table = await screen.findByRole('table', { name: 'Request log' })
    const [, first, second] = within(table).getAllByRole('row')
    const r1 = within(first as HTMLElement)
    expect(r1.getByText('ann@example.com')).toBeInTheDocument()
    expect(r1.getByText(/token laptop/)).toBeInTheDocument()
    expect(r1.getByText('claude-code/2.1')).toBeInTheDocument()
    expect(r1.getByText('spoor_remember')).toBeInTheDocument()
    expect(r1.getByText('memories · fact')).toBeInTheDocument()
    expect(r1.getByRole('link', { name: 'm9' })).toHaveAttribute('href', '/projects/acme/i/m9')
    const r2 = within(second as HTMLElement)
    expect(r2.getByText('retries')).toBeInTheDocument()
    expect(r2.getByText('invalid_input')).toBeInTheDocument()
  })

  it('sends the filters', async () => {
    const m = setup('admin')
    renderApp('/projects/acme/requests')
    await screen.findByRole('table', { name: 'Request log' })
    await userEvent.selectOptions(screen.getByLabelText('Kind'), 'write')
    await userEvent.type(screen.getByLabelText(/Actor, token or agent/), 'laptop')
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
    await waitFor(() => expect(m.find('GET', '/api/v1/projects/acme/requests')).toHaveLength(2))
    const url = m.find('GET', '/api/v1/projects/acme/requests')[1]?.url
    expect(url?.searchParams.get('kind')).toBe('write')
    expect(url?.searchParams.get('actor')).toBe('laptop')
  })

  it('is forbidden to members who are not admins', async () => {
    const m = setup('viewer')
    renderApp('/projects/acme/requests')
    expect(await screen.findByText('No access')).toBeInTheDocument()
    expect(m.find('GET', '/api/v1/projects/acme/requests')).toHaveLength(0)
  })
})
