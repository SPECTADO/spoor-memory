import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { projectFixture, summary } from '../test/browseFixtures'
import { meFixture, mockApi, renderApp } from '../test/utils'

const base = (role: 'viewer' | 'editor' | 'admin', extra: Record<string, never> = {}) => ({
  'GET /api/v1/me': [
    200,
    meFixture({}, [{ project: { id: 'p-acme', slug: 'acme', name: 'Acme' }, role }]),
  ] as [number, unknown],
  'GET /api/v1/projects/acme': [200, projectFixture('acme', role)] as [number, unknown],
  ...extra,
})

/** A filter change is a router navigation (the auth loader revalidates): wait until the last one committed. */
const settled = (router: ReturnType<typeof renderApp>['router']) =>
  waitFor(() => expect(router.state.navigation.state).toBe('idle'))

describe('SpaceListPage', () => {
  it('lists items with stale tint badge, and editors get quick actions and New', async () => {
    mockApi({
      ...base('editor'),
      'GET /api/v1/projects/acme/spaces/memories/items': [
        200,
        {
          items: [
            summary({ id: 'a', handle: 'm1', title: 'Use UTC', tags: ['time'] }),
            summary({ id: 'b', handle: 'm2', title: 'Old fact', lifecycle: 'stale' }),
          ],
          next_cursor: null,
        },
      ],
    })
    renderApp('/projects/acme/memories')
    const link = await screen.findByRole('link', { name: 'Use UTC' })
    expect(link).toHaveAttribute('href', '/projects/acme/i/m1')
    const row = screen.getByRole('link', { name: 'Old fact' }).closest('tr') as HTMLElement
    expect(within(row).getByText('stale')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pin m1' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'New memory' })).toHaveAttribute(
      'href',
      '/projects/acme/memories/new',
    )
  })

  it('hides write controls from viewers', async () => {
    mockApi({
      ...base('viewer'),
      'GET /api/v1/projects/acme/spaces/decisions/items': [
        200,
        {
          items: [
            summary({ handle: 'ADR-0001', title: 'Pick Postgres', space: 'decisions', status: 'accepted' }),
          ],
          next_cursor: null,
        },
      ],
    })
    renderApp('/projects/acme/decisions')
    expect(await screen.findByRole('link', { name: 'Pick Postgres' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Pin / })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'New decision' })).not.toBeInTheDocument()
  })

  it('puts filters in the URL and sends them to the server', async () => {
    const m = mockApi({
      ...base('viewer'),
      'GET /api/v1/projects/acme/spaces/memories/items': [200, { items: [], next_cursor: null }],
    })
    const { router } = renderApp('/projects/acme/memories')
    expect(await screen.findByText('No memories yet')).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('Type'), 'procedure')
    await userEvent.selectOptions(screen.getByLabelText('Lifecycle'), 'archived')
    await userEvent.type(screen.getByLabelText(/^Tag/), 'Auth{Enter}')
    await userEvent.click(screen.getByLabelText('Pinned only'))

    expect(await screen.findByText('No items match these filters')).toBeInTheDocument()
    await settled(router)
    expect(router.state.location.search).toBe('?type=procedure&lifecycle=archived&tag=auth&pinned=1')
    // the empty state may come from the previous filter set; wait for the request of the last one
    await waitFor(() => {
      const last = m.find('GET', '/api/v1/projects/acme/spaces/memories/items').at(-1)
      expect(last?.url.searchParams.get('pinned')).toBe('true')
      expect(last?.url.searchParams.get('type')).toBe('procedure')
      expect(last?.url.searchParams.get('lifecycle')).toBe('archived')
      expect(last?.url.searchParams.getAll('tag')).toEqual(['auth'])
    })

    await userEvent.click(screen.getByRole('button', { name: /Clear filters/ }))
    await settled(router)
    expect(router.state.location.search).toBe('')
  })

  it('keeps a filter change made before the previous one reached the URL', async () => {
    mockApi({
      ...base('viewer'),
      'GET /api/v1/projects/acme/spaces/memories/items': [200, { items: [], next_cursor: null }],
    })
    const { router } = renderApp('/projects/acme/memories')
    expect(await screen.findByText('No memories yet')).toBeInTheDocument()

    // both in one task: the second change happens while the first URL update is still a pending navigation
    fireEvent.change(screen.getByLabelText(/^Tag/), { target: { value: 'auth' } })
    fireEvent.submit(screen.getByRole('button', { name: 'Add tag' }).closest('form') as HTMLFormElement)
    expect(router.state.location.search).toBe('')
    fireEvent.click(screen.getByLabelText('Pinned only'))

    expect(await screen.findByText('No items match these filters')).toBeInTheDocument()
    await settled(router)
    expect(router.state.location.search).toBe('?tag=auth&pinned=1')
  })

  it('adds a tag filter from a row and loads more pages with the cursor', async () => {
    const m = mockApi({
      ...base('viewer'),
      'GET /api/v1/projects/acme/spaces/memories/items': (req) =>
        new Response(
          JSON.stringify(
            req.url.searchParams.get('cursor')
              ? { items: [summary({ id: 'c', handle: 'm3', title: 'Second page' })], next_cursor: null }
              : {
                  items: [summary({ id: 'a', handle: 'm1', title: 'First page', tags: ['db'] })],
                  next_cursor: 'cur1',
                },
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
    })
    const { router } = renderApp('/projects/acme/memories')
    await screen.findByRole('link', { name: 'First page' })
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(await screen.findByRole('link', { name: 'Second page' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
    expect(
      m.find('GET', '/api/v1/projects/acme/spaces/memories/items').at(-1)?.url.searchParams.get('cursor'),
    ).toBe('cur1')

    await userEvent.click(screen.getByRole('button', { name: 'Filter by tag db' }))
    await settled(router)
    expect(router.state.location.search).toBe('?tag=db')
  })
})

describe('SpaceListPage library', () => {
  const empty = { items: [], next_cursor: null }

  it('shows the subtitle, the footer and the empty state without the right', async () => {
    mockApi({
      ...base('editor'),
      'GET /api/v1/projects/acme/spaces/library/items': [200, empty],
    })
    renderApp('/projects/acme/library')
    expect(await screen.findByRole('heading', { name: 'Library' })).toBeInTheDocument()
    expect(screen.getByText(/Only people with the library right can change them/)).toBeInTheDocument()
    // an editor without the library right gets no New page
    expect(await screen.findByText('No library pages yet')).toBeInTheDocument()
    expect(screen.getByText('A project admin or a library editor can add pages here.')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'New page' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Shared → Library/ })).toHaveAttribute('href', '/shared/library')
    // the lifecycle filter has Active and Archived only
    const options = within(screen.getByLabelText('Lifecycle')).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['Active', 'Archived'])
    expect(screen.queryByLabelText('Pinned only')).not.toBeInTheDocument()
  })

  it('offers New page and Archive/Restore to a viewer holding the library right', async () => {
    mockApi({
      'GET /api/v1/me': [
        200,
        meFixture({}, [{ project: { id: 'p-acme', slug: 'acme', name: 'Acme' }, role: 'viewer' }]),
      ],
      'GET /api/v1/projects/acme': [200, projectFixture('acme', 'viewer', { can_edit_library: true })],
      'GET /api/v1/projects/acme/spaces/library/items': [
        200,
        {
          items: [
            summary({ id: 'l1', handle: 'L1', space: 'library', number: 1, title: 'Graphics guide' }),
            summary({
              id: 'l2',
              handle: 'L2',
              space: 'library',
              number: 2,
              title: 'Old guide',
              lifecycle: 'archived',
            }),
          ],
          next_cursor: null,
        },
      ],
    })
    renderApp('/projects/acme/library')
    expect(await screen.findByRole('link', { name: 'Graphics guide' })).toHaveAttribute(
      'href',
      '/projects/acme/i/L1',
    )
    expect(screen.getByRole('link', { name: 'New page' })).toHaveAttribute(
      'href',
      '/projects/acme/library/new',
    )
    expect(screen.getByRole('button', { name: 'Archive L1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore L2' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Pin / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Verify / })).not.toBeInTheDocument()
  })

  it('invites the right holder to write the first page', async () => {
    mockApi({
      ...base('admin'),
      'GET /api/v1/projects/acme': [200, projectFixture('acme', 'admin')],
      'GET /api/v1/projects/acme/spaces/library/items': [200, empty],
    })
    renderApp('/projects/acme/library')
    expect(await screen.findByText(/Write the guides agents must follow/)).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'New page' }).length).toBeGreaterThan(0)
  })
})
