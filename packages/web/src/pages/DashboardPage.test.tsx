import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { DASHBOARD_REFRESH_MS } from '../api/hooks'
import { qk } from '../api/keys'
import { projectFixture, summary } from '../test/browseFixtures'
import { meFixture, mockApi, renderApp } from '../test/utils'
import { reviewCounts } from './DashboardPage'

const lc = (active: number, stale: number, archived: number) => ({ active, stale, archived })
const dashboard = (review: Record<string, number>) => ({
  counts: { memories: lc(12, 2, 1), decisions: lc(3, 0, 0), docs: lc(4, 1, 0), library: lc(2, 0, 1) },
  review,
  links: { unlinked_items: 12, dangling_refs: 3 },
  recent: [
    {
      item: summary({ handle: 'm9', title: 'Retry with jitter' }),
      change: 'create',
      actor: { user_id: 'u', label: 'ann@example.com', via: 'mcp', client_name: 'claude-code/2.1' },
      at: '2026-10-19T08:00:00Z',
    },
  ],
})
const stats = () => ({
  window: { days: 14, from: '2026-10-06', to: '2026-10-19' },
  per_day: Array.from({ length: 14 }, (_, i) => ({
    day: `2026-10-${String(6 + i).padStart(2, '0')}`,
    reads: i,
    writes: 1,
    changes: i % 3,
  })),
  requests: { today: 5, last_7_days: 40, agents_14_days: 3 },
  people_14_days: 2,
  items_changed_7_days: 7,
  last_cleanup_at: new Date(Date.now() - 3_600_000).toISOString(),
})
const setup = (
  role: 'viewer' | 'admin',
  review = { stale: 2, archived: 0, expiring: 0, conflicts: 1, push_conflicts: 0 },
  extra: Parameters<typeof mockApi>[0] = {},
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

  it('reads a missing duplicates count (a server before 0.7) as 0', () => {
    const c = reviewCounts({ stale: 1, archived: 0, expiring: 0, conflicts: 0, push_conflicts: 2 })
    expect(c.duplicates).toBe(0)
    expect(c.push_conflicts).toBe(2)
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
    expect(screen.getByRole('link', { name: 'Possible duplicates' })).toHaveAttribute(
      'href',
      '/projects/acme/review?section=duplicates',
    )
    const recent = screen.getByRole('link', { name: 'Retry with jitter' })
    expect(recent).toHaveAttribute('href', '/projects/acme/i/m9')
    expect(within(recent.closest('li') as HTMLElement).getByText('created')).toBeInTheDocument()
    expect(screen.getByText(/via claude-code\/2.1/)).toBeInTheDocument()
  })

  it('shows the link-health line, linking to the graph', async () => {
    setup('viewer')
    renderApp('/projects/acme')
    expect(await screen.findByRole('link', { name: '12 items without links' })).toHaveAttribute(
      'href',
      '/projects/acme/graph?unlinked=1',
    )
    expect(screen.getByRole('link', { name: '3 dangling references' })).toHaveAttribute(
      'href',
      '/projects/acme/graph',
    )
  })

  it('prints only the non-zero link parts, pluralised', async () => {
    setup('viewer', undefined, {
      'GET /api/v1/projects/acme/dashboard': [
        200,
        { ...dashboard({}), links: { unlinked_items: 1, dangling_refs: 0 } },
      ],
    })
    renderApp('/projects/acme')
    expect(await screen.findByRole('link', { name: '1 item without links' })).toBeInTheDocument()
    expect(screen.queryByText(/dangling/)).not.toBeInTheDocument()
    expect(screen.queryByText('·')).not.toBeInTheDocument()
  })

  it('pluralises a single dangling reference and drops the zero part', async () => {
    setup('viewer', undefined, {
      'GET /api/v1/projects/acme/dashboard': [
        200,
        { ...dashboard({}), links: { unlinked_items: 0, dangling_refs: 1 } },
      ],
    })
    renderApp('/projects/acme')
    expect(await screen.findByRole('link', { name: '1 dangling reference' })).toBeInTheDocument()
    expect(screen.queryByText(/without links/)).not.toBeInTheDocument()
  })

  it('links to the shared graph on the shared dashboard', async () => {
    mockApi({
      'GET /api/v1/me': [200, meFixture({}, [])],
      'GET /api/v1/projects/_shared': [200, projectFixture('_shared', 'viewer')],
      'GET /api/v1/projects/_shared/dashboard': [200, dashboard({})],
    })
    renderApp('/shared')
    expect(await screen.findByRole('link', { name: '12 items without links' })).toHaveAttribute(
      'href',
      '/shared/graph?unlinked=1',
    )
    expect(screen.getByRole('link', { name: '3 dangling references' })).toHaveAttribute(
      'href',
      '/shared/graph',
    )
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
    const activity = await screen.findByRole('region', { name: 'Latest activity' })
    expect(within(activity).getByText('spoor_search')).toBeInTheDocument()
    expect(within(activity).getByText('ann@example.com via claude-code/2.1')).toBeInTheDocument()
    expect(within(activity).getByText('None in the last 14 days.')).toBeInTheDocument()
    expect(within(activity).queryByRole('link', { name: /Request log/ })).not.toBeInTheDocument()
    unmount()

    withLast('admin')
    renderApp('/projects/acme')
    const forAdmin = await screen.findByRole('region', { name: 'Latest activity' })
    expect(within(forAdmin).getByRole('link', { name: /Request log/ })).toHaveAttribute(
      'href',
      '/projects/acme/requests',
    )
  })

  it('shows the status overview: numbers and the two 14-day charts', async () => {
    setup('viewer', undefined, {
      'GET /api/v1/projects/acme/dashboard': [
        200,
        { ...dashboard({ stale: 2, conflicts: 1 }), stats: stats() },
      ],
    })
    renderApp('/projects/acme')
    const status = await screen.findByRole('region', { name: 'Status' })
    const tile = (label: string) => within(status).getByText(label).closest('div') as HTMLElement
    expect(within(tile('Agent requests today')).getByText('5')).toBeInTheDocument()
    expect(within(tile('Agent requests, 7 days')).getByText('40')).toBeInTheDocument()
    expect(within(tile('Active agents, 14 days')).getByText('3')).toBeInTheDocument()
    expect(within(tile('Active people, 14 days')).getByText('2')).toBeInTheDocument()
    expect(within(tile('Items changed, 7 days')).getByText('7')).toBeInTheDocument()
    // from the counts: 12 + 3 + 4 + 2 active, 2 + 1 stale; review 2 + 1
    expect(within(tile('Active items')).getByText('21')).toBeInTheDocument()
    expect(within(tile('Stale items')).getByText('3')).toBeInTheDocument()
    expect(within(tile('In the review queue')).getByText('3')).toBeInTheDocument()
    expect(within(tile('Last cleanup')).getByText(/ago/)).toBeInTheDocument()
    expect(within(status).getByRole('img', { name: /Agent requests per day/ })).toBeInTheDocument()
    expect(within(status).getByRole('img', { name: /Item changes per day/ })).toBeInTheDocument()
    // every number is in the hidden table too
    const table = within(status).getByRole('table', { name: 'Agent requests per day' })
    expect(within(table).getAllByRole('row')).toHaveLength(15)
  })

  it('works with an older server: no stats or activity, still the totals and the last requests', async () => {
    setup('admin')
    renderApp('/projects/acme')
    const status = await screen.findByRole('region', { name: 'Status' })
    expect(within(status).getByText('Active items')).toBeInTheDocument()
    expect(within(status).queryByText('Agent requests today')).not.toBeInTheDocument()
    expect(within(status).queryByRole('img')).not.toBeInTheDocument()
    const activity = screen.getByRole('region', { name: 'Latest activity' })
    expect(within(activity).getAllByText('None in the last 14 days.')).toHaveLength(2)
    expect(within(activity).queryByText('Latest agent requests')).not.toBeInTheDocument()
  })

  it('lists the newest agent requests when the server sends them (admins)', async () => {
    const activity = [
      {
        id: 2,
        at: '2026-10-19T08:00:00Z',
        kind: 'write',
        surface: 'mcp',
        operation: 'spoor_remember',
        actor: { label: 'ann@example.com', client_name: 'claude-code/2.1', token_name: 'laptop' },
        outcome: 'conflict',
      },
      {
        id: 1,
        at: '2026-10-19T07:00:00Z',
        kind: 'read',
        surface: 'cli',
        operation: 'GET /context',
        actor: { label: 'service:ci', client_name: null, token_name: null },
        outcome: 'ok',
      },
    ]
    setup('admin', undefined, {
      'GET /api/v1/projects/acme/dashboard': [200, { ...dashboard({}), activity }],
    })
    renderApp('/projects/acme')
    const region = await screen.findByRole('region', { name: 'Latest activity' })
    const list = within(region).getByRole('list', { name: 'Latest agent requests' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0] as HTMLElement).getByText('write')).toBeInTheDocument()
    expect(within(rows[0] as HTMLElement).getByText('spoor_remember')).toBeInTheDocument()
    expect(within(rows[0] as HTMLElement).getByText('conflict')).toBeInTheDocument()
    expect(
      within(rows[0] as HTMLElement).getByText('ann@example.com via laptop, claude-code/2.1'),
    ).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('service:ci')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).queryByText('ok')).not.toBeInTheDocument()
    expect(within(region).getByRole('link', { name: /Request log/ })).toBeInTheDocument()
  })

  it('on _shared shows only the audit-based status parts and no agent activity', async () => {
    mockApi({
      'GET /api/v1/me': [200, meFixture({}, [])],
      'GET /api/v1/projects/_shared': [200, projectFixture('_shared', 'viewer')],
      'GET /api/v1/projects/_shared/dashboard': [
        200,
        { ...dashboard({}), stats: { ...stats(), requests: null } },
      ],
    })
    renderApp('/shared')
    const status = await screen.findByRole('region', { name: 'Status' })
    expect(within(status).getByText('Items changed, 7 days')).toBeInTheDocument()
    expect(within(status).queryByText('Agent requests today')).not.toBeInTheDocument()
    expect(within(status).queryByRole('img', { name: /Agent requests per day/ })).not.toBeInTheDocument()
    expect(within(status).getByRole('img', { name: /Item changes per day/ })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Latest activity' })).not.toBeInTheDocument()
  })

  it('refetches every minute in the background and says when it last updated', async () => {
    setup('viewer')
    const { qc } = renderApp('/projects/acme')
    expect(await screen.findByText(/^Updated/)).toHaveTextContent(/Refreshes every minute/)
    const q = qc.getQueryCache().find({ queryKey: qk.dashboard('acme') })
    const opts = q?.observers[0]?.options
    expect(opts?.refetchInterval).toBe(DASHBOARD_REFRESH_MS)
    expect(DASHBOARD_REFRESH_MS).toBe(60_000)
    expect(opts?.refetchIntervalInBackground).toBe(false)
  })

  it('keeps the page on a failed refetch and offers to try again', async () => {
    setup('viewer', undefined, {
      'GET /api/v1/projects/acme/dashboard': [
        [200, dashboard({})],
        [500, { error: 'internal', request_id: 'r' }],
      ],
    })
    const { qc } = renderApp('/projects/acme')
    expect(await screen.findByRole('region', { name: 'Status' })).toBeInTheDocument()
    await qc.refetchQueries({ queryKey: qk.dashboard('acme') })
    expect(await screen.findByText('Could not refresh.')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Status' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('refreshes the project with each dashboard refetch', async () => {
    const m = setup('viewer')
    const { qc } = renderApp('/projects/acme')
    await screen.findByRole('region', { name: 'Status' })
    await waitFor(() => expect(m.find('GET', '/api/v1/projects/acme')).toHaveLength(1))
    await qc.refetchQueries({ queryKey: qk.dashboard('acme') })
    await waitFor(() => expect(m.find('GET', '/api/v1/projects/acme')).toHaveLength(2))
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
