import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { projectFixture, summary } from '../test/browseFixtures'
import { meFixture, mockApi, renderApp } from '../test/utils'
import { reviewCounts } from './DashboardPage'

const lc = (active: number, stale: number, archived: number) => ({ active, stale, archived })
const dashboard = (review: Record<string, number>) => ({
  counts: { memories: lc(12, 2, 1), decisions: lc(3, 0, 0), docs: lc(4, 1, 0), library: lc(2, 0, 1) },
  review,
  recent: [
    {
      item: summary({ handle: 'm9', title: 'Retry with jitter' }),
      change: 'create',
      actor: { user_id: 'u', label: 'ann@example.com', via: 'mcp', client_name: 'claude-code/2.1' },
      at: '2026-10-19T08:00:00Z',
    },
  ],
})
const setup = (
  role: 'viewer' | 'admin',
  review = { stale: 2, archived: 0, expiring: 0, conflicts: 1, push_conflicts: 0 },
  extra: Record<string, [number, unknown]> = {},
) =>
  mockApi({
    'GET /api/v1/me': [200, meFixture({}, [{ project: { id: 'p-acme', slug: 'acme', name: 'Acme' }, role }])],
    'GET /api/v1/projects/acme': [200, projectFixture('acme', role)],
    'GET /api/v1/projects/acme/dashboard': [200, dashboard(review)],
    ...extra,
  })

describe('reviewCounts', () => {
  it('reads a missing push_conflicts count as 0', () => {
    expect(reviewCounts({ stale: 1, archived: 0, expiring: 0, conflicts: 0 }).push_conflicts).toBe(0)
  })
})

describe('DashboardPage', () => {
  it('shows counts per space, review links and recent changes', async () => {
    setup('viewer')
    renderApp('/projects/acme')
    const counts = await screen.findByRole('region', { name: 'Items per space' })
    const memories = within(counts).getByRole('link', { name: 'Memories' })
    expect(memories).toHaveAttribute('href', '/projects/acme/memories')
    expect(within(memories.closest('li') as HTMLElement).getByText('2 stale')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Stale' })).toHaveAttribute(
      'href',
      '/projects/acme/review?section=stale',
    )
    expect(screen.getByRole('link', { name: 'Conflicts' })).toBeInTheDocument()
    const recent = screen.getByRole('link', { name: 'Retry with jitter' })
    expect(recent).toHaveAttribute('href', '/projects/acme/i/m9')
    expect(within(recent.closest('li') as HTMLElement).getByText('created')).toBeInTheDocument()
    expect(screen.getByText(/via claude-code\/2.1/)).toBeInTheDocument()
  })

  it('shows a fourth Library card that is never stale', async () => {
    setup('viewer')
    renderApp('/projects/acme')
    const counts = await screen.findByRole('region', { name: 'Items per space' })
    const lib = within(counts).getByRole('link', { name: 'Library' })
    expect(lib).toHaveAttribute('href', '/projects/acme/library')
    const card = lib.closest('li') as HTMLElement
    expect(within(card).getByText('2')).toBeInTheDocument()
    expect(within(card).getByText('never stale')).toBeInTheDocument()
    expect(within(card).getByText('1 archived')).toBeInTheDocument()
    expect(within(counts).getAllByRole('listitem')).toHaveLength(4)
  })

  it('shows every member how to connect, with this server and CLI version in the commands', async () => {
    setup('viewer', undefined, {
      'GET /api/v1/instance': [
        200,
        {
          version: '0.2.0',
          public_url: 'https://spoor.example.com',
          providers: [],
          default_provider: 'local',
        },
      ],
    })
    renderApp('/projects/acme')
    const connect = await screen.findByRole('region', { name: 'Connect' })
    expect(await within(connect).findByDisplayValue('npm i -g spoor-memory@0.2.0')).toBeInTheDocument()
    expect(
      within(connect).getByDisplayValue('spoor login --server https://spoor.example.com --project acme'),
    ).toBeInTheDocument()
    expect(within(connect).getByRole('link', { name: /Install guide/ })).toHaveAttribute(
      'href',
      '/p/acme/install.md',
    )
    expect(within(connect).getByRole('link', { name: 'Create a token instead' })).toHaveAttribute(
      'href',
      '/projects/acme/tokens',
    )
    expect(within(connect).getByText(/Ask a project admin to add them/)).toBeInTheDocument()
    expect(within(connect).queryByRole('link', { name: 'Members' })).not.toBeInTheDocument()
  })

  it('points project admins to Members for a new teammate', async () => {
    setup('admin')
    renderApp('/projects/acme')
    const connect = await screen.findByRole('region', { name: 'Connect' })
    expect(within(connect).getByRole('link', { name: 'Members' })).toHaveAttribute(
      'href',
      '/projects/acme/members',
    )
  })

  it('shows the last agent read and write to every member, and the log link to admins', async () => {
    const last = {
      read: {
        at: '2026-10-19T08:00:00Z',
        surface: 'mcp',
        operation: 'spoor_search',
        actor: { label: 'ann@example.com', client_name: 'claude-code/2.1' },
      },
      write: null,
    }
    const withLast = (role: 'viewer' | 'admin') =>
      setup(role, undefined, {
        'GET /api/v1/projects/acme/dashboard': [
          200,
          {
            ...dashboard({ stale: 0, archived: 0, expiring: 0, conflicts: 0, push_conflicts: 0 }),
            last_requests: last,
          },
        ],
      })
    withLast('viewer')
    const { unmount } = renderApp('/projects/acme')
    const activity = await screen.findByRole('region', { name: 'Agent activity' })
    expect(within(activity).getByText('spoor_search')).toBeInTheDocument()
    expect(within(activity).getByText('ann@example.com via claude-code/2.1')).toBeInTheDocument()
    expect(within(activity).getByText('None in the last 14 days.')).toBeInTheDocument()
    expect(within(activity).queryByRole('link', { name: /Request log/ })).not.toBeInTheDocument()
    unmount()

    withLast('admin')
    renderApp('/projects/acme')
    const forAdmin = await screen.findByRole('region', { name: 'Agent activity' })
    expect(within(forAdmin).getByRole('link', { name: /Request log/ })).toHaveAttribute(
      'href',
      '/projects/acme/requests',
    )
  })

  it('says so when nothing needs review', async () => {
    setup('viewer', { stale: 0, archived: 0, expiring: 0, conflicts: 0, push_conflicts: 0 })
    renderApp('/projects/acme')
    expect(await screen.findByText('Nothing needs review.')).toBeInTheDocument()
  })
})

describe('digest preview', () => {
  it('shows the digest an agent would get and sends the typed query and files', async () => {
    const m = setup('viewer', undefined, {
      'GET /api/v1/projects/acme/context': [
        200,
        {
          text: '# Spoor digest\n- m9 Retry with jitter',
          budget: 1500,
          est_tokens: 42,
          items: ['m9'],
          dropped: 3,
        },
      ],
    })
    renderApp('/projects/acme')
    await userEvent.click(await screen.findByRole('button', { name: 'Preview digest' }))
    const dialog = await screen.findByRole('dialog', { name: 'Digest preview' })
    expect(await within(dialog).findByText(/m9 Retry with jitter/)).toBeInTheDocument()
    expect(within(dialog).getByText(/About 42 of 1,500 tokens · 1 items · 3 left out/)).toBeInTheDocument()

    await userEvent.type(within(dialog).getByLabelText(/Query/), 'retries')
    await userEvent.type(within(dialog).getByLabelText(/Changed files/), 'src/a.ts{Enter}{Enter}src/b.ts')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Show digest' }))
    await waitFor(() => expect(m.find('GET', '/api/v1/projects/acme/context')).toHaveLength(2))
    const url = m.find('GET', '/api/v1/projects/acme/context')[1]?.url
    expect(url?.searchParams.get('query')).toBe('retries')
    expect(url?.searchParams.getAll('file')).toEqual(['src/a.ts', 'src/b.ts'])
    expect(url?.searchParams.get('format')).toBe('json')
  })
})
