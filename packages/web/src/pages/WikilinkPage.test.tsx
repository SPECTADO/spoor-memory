import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { projectFixture, summary } from '../test/browseFixtures'
import { apiError, meFixture, mockApi, renderApp } from '../test/utils'

const base = (role: 'viewer' | 'editor') => ({
  'GET /api/v1/me': [
    200,
    meFixture({ is_admin: false }, [{ project: { id: 'p-acme', slug: 'acme', name: 'Acme' }, role }]),
  ] as [number, unknown],
  'GET /api/v1/projects/acme': [200, projectFixture('acme', role)] as [number, unknown],
})

describe('WikilinkPage', () => {
  it('replaces itself with the resolved item, shared items under /shared', async () => {
    const m = mockApi({
      ...base('viewer'),
      'GET /api/v1/projects/acme/resolve': [
        200,
        { item: summary({ handle: 'S:d3', project: '_shared', title: 'Style guide' }) },
      ],
    })
    const { router } = renderApp('/projects/acme/w/shared%3Astyle-guide')
    await waitFor(() => expect(router.state.location.pathname).toBe('/shared/i/d3'))
    expect(router.state.historyAction).toBe('REPLACE')
    expect(m.find('GET', '/api/v1/projects/acme/resolve')[0]?.url.searchParams.get('ref')).toBe(
      'shared:style-guide',
    )
  })

  it('offers "Create doc" for a dangling link to editors only', async () => {
    mockApi({ ...base('editor'), 'GET /api/v1/projects/acme/resolve': apiError(404, 'not_found') })
    renderApp('/projects/acme/w/session-store')
    expect(await screen.findByText(/No item called/)).toHaveTextContent('No item called session-store.')
    expect(screen.getByRole('link', { name: 'Create doc' })).toHaveAttribute(
      'href',
      '/projects/acme/docs/new?title=session-store',
    )
  })

  it('a link from a library page offers "Create library page" to holders of the library right only', async () => {
    const m = mockApi({
      ...base('viewer'),
      'GET /api/v1/projects/acme': [200, projectFixture('acme', 'viewer', { can_edit_library: true })],
      'GET /api/v1/projects/acme/resolve': apiError(404, 'not_found'),
    })
    renderApp('/projects/acme/w/house-rules?from=library')
    expect(await screen.findByRole('link', { name: 'Create library page' })).toHaveAttribute(
      'href',
      '/projects/acme/library/new?title=house-rules',
    )
    expect(m.find('GET', '/api/v1/projects/acme/resolve')[0]?.url.searchParams.get('from')).toBe('library')
  })

  it('a link from a library page offers nothing to an editor without the library right', async () => {
    mockApi({ ...base('editor'), 'GET /api/v1/projects/acme/resolve': apiError(404, 'not_found') })
    renderApp('/projects/acme/w/house-rules?from=library')
    expect(await screen.findByText(/No item called/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Create/ })).toBeNull()
  })

  it('shows no create action to viewers', async () => {
    mockApi({ ...base('viewer'), 'GET /api/v1/projects/acme/resolve': apiError(404, 'not_found') })
    renderApp('/projects/acme/w/session-store')
    expect(await screen.findByText(/No item called/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Create doc' })).toBeNull()
  })
})
