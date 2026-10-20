import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { apiError, meFixture, mockApi, renderApp } from '../test/utils'
import { suggestProjectSlug } from './ProjectsPage'

const list = {
  items: [
    {
      slug: 'acme',
      name: 'Acme',
      description: 'Main app',
      role: 'editor',
      counts: { memories: 12, decisions: 3, docs: 4, library: 2 },
      review_total: 2,
    },
  ],
}

describe('suggestProjectSlug', () => {
  it('slugifies and fits the 40-character project slug', () => {
    expect(suggestProjectSlug('My New Project')).toBe('my-new-project')
    expect(suggestProjectSlug(`${'x'.repeat(39)} yz`).length).toBeLessThanOrEqual(40)
    expect(suggestProjectSlug(`${'x'.repeat(39)} yz`).endsWith('-')).toBe(false)
  })
})

describe('ProjectsPage', () => {
  it('lists projects with counts, role and review badge, plus the shared card; no create for members', async () => {
    mockApi({ 'GET /api/v1/me': [200, meFixture()], 'GET /api/v1/projects': [200, list] })
    renderApp('/projects')
    const link = await screen.findByRole('link', { name: 'Acme' })
    expect(link).toHaveAttribute('href', '/projects/acme')
    const card = link.closest('article') as HTMLElement
    expect(within(card).getByText('12')).toBeInTheDocument()
    expect(within(card).getByText('editor')).toBeInTheDocument()
    expect(within(card).getByText('2 to review')).toBeInTheDocument()
    expect(within(card).getByText('library')).toBeInTheDocument()
    expect(within(card).getByText('2', { selector: 'dd' })).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Shared knowledge' })[0]).toHaveAttribute('href', '/shared')
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument()
  })

  it('lets an instance admin create a project, mapping slug_taken to the slug field', async () => {
    const created = {
      id: 'p2',
      slug: 'new-thing',
      name: 'New Thing',
      description: '',
      kind: 'project',
      settings: {},
      role: 'admin',
      embedding: { model: 'e5', target: null, remaining: 0 },
      created_at: '2026-10-19T00:00:00Z',
    }
    const m = mockApi({
      'GET /api/v1/me': [200, meFixture({ is_admin: true })],
      'GET /api/v1/projects': [200, list],
      'POST /api/v1/projects': [apiError(409, 'slug_taken'), [201, created]],
      'GET /api/v1/projects/new-thing': [200, created],
      'GET /api/v1/projects/new-thing/review': [
        200,
        { counts: { stale: 0, archived: 0, expiring: 0, conflicts: 0, push_conflicts: 0 } },
      ],
    })
    const { router } = renderApp('/projects')
    await userEvent.click(await screen.findByRole('button', { name: 'New project' }))
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    await userEvent.type(within(dialog).getByLabelText(/^Name/), 'New Thing')
    expect(within(dialog).getByLabelText(/^Slug/)).toHaveValue('new-thing')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }))
    expect(await within(dialog).findByText('This slug is taken.')).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }))
    expect(await screen.findByText('Project New Thing created.')).toBeInTheDocument()
    // the dashboard is a lazy route: the location changes once its chunk has loaded
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/new-thing'))
    expect(m.find('POST', '/api/v1/projects')[1]?.body).toEqual({
      slug: 'new-thing',
      name: 'New Thing',
      description: '',
    })
  })

  it('validates the slug locally', async () => {
    const m = mockApi({
      'GET /api/v1/me': [200, meFixture({ is_admin: true })],
      'GET /api/v1/projects': [200, { items: [] }],
    })
    renderApp('/projects')
    await userEvent.click((await screen.findAllByRole('button', { name: 'New project' }))[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    await userEvent.type(within(dialog).getByLabelText(/^Name/), 'API')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create project' }))
    expect(await within(dialog).findByText(/some words are reserved/)).toBeInTheDocument()
    expect(m.find('POST', '/api/v1/projects')).toHaveLength(0)
  })
})
