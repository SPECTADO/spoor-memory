import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { projectFixture, summary } from '../test/browseFixtures'
import { meFixture, mockApi, renderApp } from '../test/utils'

const routes = (search: unknown) => ({
  'GET /api/v1/me': [
    200,
    meFixture({}, [{ project: { id: 'p-acme', slug: 'acme', name: 'Acme' }, role: 'viewer' }]),
  ] as [number, unknown],
  'GET /api/v1/projects/acme': [200, projectFixture('acme', 'viewer')] as [number, unknown],
  'GET /api/v1/projects/acme/search': [200, search] as [number, unknown],
})

describe('SearchPage', () => {
  it('searches the URL query and shows snippets and stale marks', async () => {
    const m = mockApi(
      routes({
        items: [
          {
            item: summary({ handle: 'm7', title: 'Sliding sessions', lifecycle: 'stale' }),
            score: 0.03,
            snippet: 'sliding on last_seen_at',
          },
          {
            item: summary({ id: 'x', handle: 'S:d3', project: '_shared', title: 'Shared rule' }),
            score: 0.02,
            snippet: '',
          },
        ],
        notes: ['vector search unavailable'],
      }),
    )
    renderApp('/projects/acme/search?q=session')
    expect(await screen.findByRole('link', { name: 'Sliding sessions' })).toHaveAttribute(
      'href',
      '/projects/acme/i/m7',
    )
    expect(screen.getByRole('link', { name: 'Shared rule' })).toHaveAttribute('href', '/shared/i/d3')
    expect(screen.getByText('sliding on last_seen_at')).toBeInTheDocument()
    expect(screen.getByText('stale')).toBeInTheDocument()
    expect(screen.getByText('vector search unavailable')).toBeInTheDocument()
    expect(screen.getByText('2 results')).toBeInTheDocument()
    const call = m.find('GET', '/api/v1/projects/acme/search')[0]
    expect(call?.url.searchParams.get('q')).toBe('session')
    expect(call?.url.searchParams.has('include_inactive')).toBe(false)
  })

  it('applies the space filter and include inactive', async () => {
    const m = mockApi(routes({ items: [], notes: [] }))
    const { router } = renderApp('/projects/acme/search?q=session')
    expect(await screen.findByText('No results for "session"')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Space'), 'docs')
    await userEvent.click(screen.getByLabelText('Include inactive'))
    // a query change is a router navigation (the auth loader revalidates): wait until the last one committed
    await waitFor(() => expect(router.state.navigation.state).toBe('idle'))
    expect(router.state.location.search).toContain('space=docs')
    expect(router.state.location.search).toContain('inactive=1')
    // previous results stay visible while the next query loads: wait for the request itself
    await waitFor(() => {
      const last = m.find('GET', '/api/v1/projects/acme/search').at(-1)
      expect(last?.url.searchParams.get('space')).toBe('docs')
      expect(last?.url.searchParams.get('include_inactive')).toBe('true')
    })
  })

  it('debounces typing into the URL query', async () => {
    const m = mockApi(routes({ items: [], notes: [] }))
    const { router } = renderApp('/projects/acme/search')
    expect(await screen.findByText(/Type a query/)).toBeInTheDocument()
    // no delay between keys, so a slow machine cannot outlast the 250 ms debounce mid-word
    await userEvent.setup({ delay: null }).type(screen.getByLabelText('Query'), 'cache')
    expect(m.find('GET', '/api/v1/projects/acme/search')).toHaveLength(0)
    expect(await screen.findByText('No results for "cache"')).toBeInTheDocument()
    expect(router.state.location.search).toBe('?q=cache')
    expect(m.find('GET', '/api/v1/projects/acme/search')).toHaveLength(1)
  })
})
