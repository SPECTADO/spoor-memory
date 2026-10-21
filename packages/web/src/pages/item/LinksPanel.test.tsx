import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { mockApi, renderApp } from '../../test/utils'
import { baseRoutes, itemFixture } from './testFixtures'

const noEdges = [200, { outgoing: [], incoming: [] }] as [number, unknown]
const related = (items: unknown[], note?: string): [number, unknown] => [
  200,
  { items, ...(note ? { note } : {}) },
]

describe('LinksPanel suggested links', () => {
  it('lets a writer link a suggestion with a kind, then the row disappears', async () => {
    const other = itemFixture({ id: 'id-30', handle: 'm30', title: 'Refresh tokens rotate' })
    const m = mockApi({
      ...baseRoutes('editor'),
      'GET /api/v1/projects/acme/items/m42': [200, itemFixture()],
      'GET /api/v1/projects/acme/items/m42/edges': noEdges,
      'GET /api/v1/projects/acme/items/m42/related': [
        related([{ item: other, cos: 0.812 }]),
        related([]),
      ] as never,
      'POST /api/v1/projects/acme/items/m42/edges': [201, { id: 'e9' }],
    })
    renderApp('/projects/acme/i/m42')
    const links = await screen.findByRole('region', { name: 'Links' })
    expect(await within(links).findByText('Suggested links')).toBeInTheDocument()
    expect(await within(links).findByText('similar 0.81')).toBeInTheDocument()
    await userEvent.selectOptions(within(links).getByLabelText('Relation kind for m30'), 'supports')
    await userEvent.click(within(links).getByRole('button', { name: 'Link m30' }))
    await waitFor(() => expect(m.find('POST', '/api/v1/projects/acme/items/m42/edges')).toHaveLength(1))
    expect(m.find('POST', '/api/v1/projects/acme/items/m42/edges')[0]?.body).toEqual({
      kind: 'supports',
      to: 'm30',
    })
    expect(await within(links).findByText('No suggestions yet')).toBeInTheDocument()
  })

  it('shows readers the suggestions without controls, and the pending note when empty', async () => {
    const other = itemFixture({ id: 'id-30', handle: 'm30', title: 'Refresh tokens rotate' })
    mockApi({
      ...baseRoutes('viewer'),
      'GET /api/v1/projects/acme/items/m42': [200, itemFixture()],
      'GET /api/v1/projects/acme/items/m42/edges': noEdges,
      'GET /api/v1/projects/acme/items/m42/related': related([{ item: other, cos: 0.75 }]),
    })
    renderApp('/projects/acme/i/m42')
    const links = await screen.findByRole('region', { name: 'Links' })
    expect(await within(links).findByText('similar 0.75')).toBeInTheDocument()
    expect(within(links).queryByRole('button', { name: /^Link / })).not.toBeInTheDocument()
  })

  it('renders the embedding pending note', async () => {
    mockApi({
      ...baseRoutes('viewer'),
      'GET /api/v1/projects/acme/items/m42': [200, itemFixture()],
      'GET /api/v1/projects/acme/items/m42/edges': noEdges,
      'GET /api/v1/projects/acme/items/m42/related': related(
        [],
        'embedding pending: related items appear once the item is embedded',
      ),
    })
    renderApp('/projects/acme/i/m42')
    expect(await screen.findByText(/embedding pending/)).toBeInTheDocument()
  })

  it('shows one muted line with Retry when suggestions fail, and retries', async () => {
    const other = itemFixture({ id: 'id-30', handle: 'm30', title: 'Refresh tokens rotate' })
    const m = mockApi({
      ...baseRoutes('viewer'),
      'GET /api/v1/projects/acme/items/m42': [200, itemFixture()],
      'GET /api/v1/projects/acme/items/m42/edges': noEdges,
      'GET /api/v1/projects/acme/items/m42/related': [
        [400, { error: 'invalid_input', request_id: 'r1', message: 'bad' }],
        related([{ item: other, cos: 0.75 }]),
      ] as never,
    })
    renderApp('/projects/acme/i/m42')
    const links = await screen.findByRole('region', { name: 'Links' })
    expect(await within(links).findByText(/Suggestions unavailable/)).toBeInTheDocument()
    expect(within(links).queryByRole('alert')).not.toBeInTheDocument()
    await userEvent.click(within(links).getByRole('button', { name: 'Retry' }))
    expect(await within(links).findByText('similar 0.75')).toBeInTheDocument()
    expect(m.find('GET', '/api/v1/projects/acme/items/m42/related')).toHaveLength(2)
  })

  it('keeps a row disabled after its own successful link, so a double click sends one edge', async () => {
    const other = itemFixture({ id: 'id-30', handle: 'm30', title: 'Refresh tokens rotate' })
    const m = mockApi({
      ...baseRoutes('editor'),
      'GET /api/v1/projects/acme/items/m42': [200, itemFixture()],
      'GET /api/v1/projects/acme/items/m42/edges': noEdges,
      // the refetch still returns the row: the button must stay disabled regardless
      'GET /api/v1/projects/acme/items/m42/related': related([{ item: other, cos: 0.8 }]),
      'POST /api/v1/projects/acme/items/m42/edges': [201, { id: 'e9' }],
    })
    renderApp('/projects/acme/i/m42')
    const links = await screen.findByRole('region', { name: 'Links' })
    const btn = await within(links).findByRole('button', { name: 'Link m30' })
    await userEvent.click(btn)
    await waitFor(() => expect(btn).toBeDisabled())
    await userEvent.click(btn)
    expect(m.find('POST', '/api/v1/projects/acme/items/m42/edges')).toHaveLength(1)
  })

  it('hides conflicts_with when either side is a library page', async () => {
    const lib = itemFixture({ id: 'id-31', handle: 'L3', space: 'library', title: 'Style guide' })
    mockApi({
      ...baseRoutes('editor'),
      'GET /api/v1/projects/acme/items/m42': [200, itemFixture()],
      'GET /api/v1/projects/acme/items/m42/edges': noEdges,
      'GET /api/v1/projects/acme/items/m42/related': related([{ item: lib, cos: 0.8 }]),
    })
    renderApp('/projects/acme/i/m42')
    const links = await screen.findByRole('region', { name: 'Links' })
    const select = await within(links).findByLabelText('Relation kind for L3')
    expect(within(select).queryByRole('option', { name: /conflicts/i })).not.toBeInTheDocument()
    expect(within(select).getAllByRole('option').length).toBeGreaterThan(0)
  })

  it('hides conflicts_with when the current item is a library page', async () => {
    const other = itemFixture({ id: 'id-30', handle: 'm30', title: 'Refresh tokens rotate' })
    mockApi({
      ...baseRoutes('admin'),
      'GET /api/v1/projects/acme/items/m42': [200, itemFixture({ space: 'library' })],
      'GET /api/v1/projects/acme/items/m42/edges': noEdges,
      'GET /api/v1/projects/acme/items/m42/related': related([{ item: other, cos: 0.8 }]),
    })
    renderApp('/projects/acme/i/m42')
    const links = await screen.findByRole('region', { name: 'Links' })
    const select = await within(links).findByLabelText('Relation kind for m30')
    expect(within(select).queryByRole('option', { name: /conflicts/i })).not.toBeInTheDocument()
  })

  it('sends a shared candidate as to: S:...', async () => {
    const shared = itemFixture({ id: 'id-s3', handle: 'S:m3', project: '_shared', title: 'Org rule' })
    const m = mockApi({
      ...baseRoutes('editor'),
      'GET /api/v1/projects/acme/items/m42': [200, itemFixture()],
      'GET /api/v1/projects/acme/items/m42/edges': noEdges,
      'GET /api/v1/projects/acme/items/m42/related': related([{ item: shared, cos: 0.8 }]),
      'POST /api/v1/projects/acme/items/m42/edges': [201, { id: 'e9' }],
    })
    renderApp('/projects/acme/i/m42')
    const links = await screen.findByRole('region', { name: 'Links' })
    await userEvent.click(await within(links).findByRole('button', { name: 'Link S:m3' }))
    await waitFor(() => expect(m.find('POST', '/api/v1/projects/acme/items/m42/edges')).toHaveLength(1))
    expect(m.find('POST', '/api/v1/projects/acme/items/m42/edges')[0]?.body).toEqual({
      kind: 'refines',
      to: 'S:m3',
    })
  })

  it('says "No suggestions yet" when there are none and no note', async () => {
    mockApi({
      ...baseRoutes('viewer'),
      'GET /api/v1/projects/acme/items/m42': [200, itemFixture()],
      'GET /api/v1/projects/acme/items/m42/edges': noEdges,
      'GET /api/v1/projects/acme/items/m42/related': related([]),
    })
    renderApp('/projects/acme/i/m42')
    expect(await screen.findByText('No suggestions yet')).toBeInTheDocument()
  })
})
