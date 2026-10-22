import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { WEB_VERSION } from './lib/version'
import { apiError, meFixture, mockApi, renderApp } from './test/utils'

const project = (role: 'admin' | 'editor' | 'viewer', slug = 'demo') => ({
  id: 'p1',
  slug,
  name: 'Demo',
  description: '',
  kind: slug === '_shared' ? 'shared' : 'project',
  settings: {},
  role,
  embedding: { model: 'e5', target: null, remaining: 0 },
  created_at: '2026-10-01T00:00:00Z',
})
const projectList = {
  items: [
    {
      slug: 'demo',
      name: 'Demo',
      description: '',
      role: 'editor',
      counts: { memories: 1, decisions: 0, docs: 0 },
      review_total: 2,
    },
  ],
}
const reviewCounts = { counts: { stale: 1, archived: 0, expiring: 1, conflicts: 0, push_conflicts: 0 } }

describe('app shell', () => {
  it('shows the project nav for a member, with the review count, and hides admin entries', async () => {
    mockApi({
      'GET /api/v1/me': [
        200,
        meFixture({}, [{ project: { id: 'p1', slug: 'demo', name: 'Demo' }, role: 'editor' }]),
      ],
      'GET /api/v1/projects': [200, projectList],
      'GET /api/v1/projects/demo': [200, project('editor')],
      'GET /api/v1/projects/demo/review': [200, reviewCounts],
    })
    renderApp('/projects/demo/search')
    const nav = await screen.findByRole('navigation', { name: 'Project' })
    for (const name of [
      'Dashboard',
      'Memories',
      'Decisions',
      'Docs',
      'Map',
      'Search',
      'Audit log',
      'Tokens',
    ]) {
      expect(within(nav).getByRole('link', { name: new RegExp(`^${name}`) })).toBeInTheDocument()
    }
    const review = within(nav).getByRole('link', { name: /^Review/ })
    await waitFor(() => expect(review).toHaveTextContent('Review 2 to review'))
    expect(within(nav).queryByRole('link', { name: 'Members' })).not.toBeInTheDocument()
    expect(within(nav).queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Search' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('navigation', { name: 'Instance administration' })).not.toBeInTheDocument()
  })

  it('shows Members, Settings and the admin nav to an instance admin', async () => {
    mockApi({
      'GET /api/v1/me': [200, meFixture({ is_admin: true })],
      'GET /api/v1/projects': [200, projectList],
      'GET /api/v1/projects/demo': [200, project('admin')],
      'GET /api/v1/projects/demo/review': [200, reviewCounts],
    })
    renderApp('/projects/demo')
    const nav = await screen.findByRole('navigation', { name: 'Project' })
    expect(within(nav).getByRole('link', { name: 'Members' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Settings' })).toBeInTheDocument()
    const admin = screen.getByRole('navigation', { name: 'Instance administration' })
    expect(within(admin).getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/admin/users')
  })

  it('shows the web and server versions at the bottom of the sidebar', async () => {
    mockApi({
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/projects': [200, projectList],
      'GET /api/v1/instance': [200, { version: '9.8.7', providers: [] }],
    })
    renderApp('/projects')
    const sidebar = await screen.findByRole('complementary', { name: 'Sidebar' })
    await waitFor(() => expect(sidebar).toHaveTextContent(`Web ${WEB_VERSION} · Server 9.8.7`))
    expect(WEB_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('serves the shared space under /shared without Tokens or Members', async () => {
    mockApi({
      'GET /api/v1/me': [200, meFixture({ shared_editor: true })],
      'GET /api/v1/projects': [200, projectList],
      'GET /api/v1/projects/_shared': [200, project('editor', '_shared')],
      'GET /api/v1/projects/_shared/review': [200, reviewCounts],
    })
    renderApp('/shared/memories')
    const nav = await screen.findByRole('navigation', { name: 'Project' })
    expect(within(nav).getByRole('link', { name: 'Memories' })).toHaveAttribute('href', '/shared/memories')
    expect(within(nav).queryByRole('link', { name: 'Tokens' })).not.toBeInTheDocument()
    expect(within(nav).queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('renders Not found for a project the API hides (404)', async () => {
    mockApi({
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/projects': [200, { items: [] }],
    })
    renderApp('/projects/secret')
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument()
  })

  it('gates instance admin pages', async () => {
    mockApi({ 'GET /api/v1/me': [200, meFixture()], 'GET /api/v1/projects': [200, { items: [] }] })
    renderApp('/admin/users')
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeInTheDocument()
  })

  it('redirects to /login?next= when /me is 401, then back after logging in', async () => {
    const api = mockApi({
      'GET /api/v1/me': [apiError(401, 'unauthenticated'), [200, meFixture()]],
      'POST /api/v1/auth/login': [200, { user: meFixture().user }],
      'GET /api/v1/projects': [200, projectList],
    })
    const { router } = renderApp('/projects?x=1')
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
    expect(router.state.location.search).toBe(`?next=${encodeURIComponent('/projects?x=1')}`)
    expect(api.calls[0]?.init.credentials).toBe('same-origin')

    await userEvent.type(screen.getByLabelText(/Email/), 'ann@example.com')
    await userEvent.type(screen.getByLabelText(/Password/), 'correct horse battery')
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByRole('heading', { name: 'Projects' })).toBeInTheDocument()
    expect(router.state.location.search).toBe('?x=1')
  })

  it('logs out from the account menu', async () => {
    const api = mockApi({
      'GET /api/v1/me': [200, meFixture()],
      'GET /api/v1/projects': [200, { items: [] }],
      'POST /api/v1/auth/logout': [204],
    })
    const { router } = renderApp('/projects')
    await userEvent.click(await screen.findByRole('button', { name: /Ann/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Log out' }))
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
    expect(api.find('POST', '/api/v1/auth/logout')).toHaveLength(1)
  })
})

describe('library nav', () => {
  const routes = (slug: string, role: 'editor' | 'viewer') => ({
    'GET /api/v1/me': [200, meFixture({ shared_editor: true })] as [number, unknown],
    'GET /api/v1/projects': [200, projectList] as [number, unknown],
    [`GET /api/v1/projects/${slug}`]: [200, project(role, slug)] as [number, unknown],
    [`GET /api/v1/projects/${slug}/review`]: [200, reviewCounts] as [number, unknown],
  })

  it('shows the Library tab after Docs on a project', async () => {
    mockApi(routes('demo', 'viewer'))
    renderApp('/projects/demo/search')
    const nav = await screen.findByRole('navigation', { name: 'Project' })
    expect(within(nav).getByRole('link', { name: 'Library' })).toHaveAttribute(
      'href',
      '/projects/demo/library',
    )
    const names = within(nav)
      .getAllByRole('link')
      .map((a) => a.textContent)
    expect(names.indexOf('Library')).toBe(names.indexOf('Docs') + 1)
    expect(names.indexOf('Map')).toBe(names.indexOf('Library') + 1)
    expect(within(nav).getByRole('link', { name: 'Map' })).toHaveAttribute('href', '/projects/demo/graph')
  })

  it('shows the Library tab on /shared', async () => {
    mockApi(routes('_shared', 'editor'))
    renderApp('/shared/search')
    const nav = await screen.findByRole('navigation', { name: 'Project' })
    expect(within(nav).getByRole('link', { name: 'Library' })).toHaveAttribute('href', '/shared/library')
    expect(within(nav).getByRole('link', { name: 'Map' })).toHaveAttribute('href', '/shared/graph')
  })
})
