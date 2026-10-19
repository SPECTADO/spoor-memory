import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { mockApi, renderApp } from '../../test/utils'
import { baseRoutes, itemFixture } from './testFixtures'

const noEdges = [200, { outgoing: [], incoming: [] }] as [number, unknown]

describe('item view', () => {
  it('renders the body, the details panel, links and backlinks', async () => {
    const other = itemFixture({ id: 'id-7', handle: 'm7', title: 'Cache policy' })
    const shared = itemFixture({ id: 'id-s3', handle: 'S:m3', project: '_shared', title: 'Org rule' })
    mockApi({
      ...baseRoutes('viewer'),
      'GET /api/v1/projects/acme/items/m42': [
        200,
        itemFixture({ provenance: 'agent', source_path: 'docs/sessions.md', extra: { owner: 'team-a' } }),
      ],
      'GET /api/v1/projects/acme/items/m42/edges': [
        200,
        {
          outgoing: [
            { id: 'e1', kind: 'refines', editable: true, other: shared },
            { id: 'e2', kind: 'wikilink', editable: false, other: null, dst_ref: 'missing-page' },
          ],
          incoming: [{ id: 'e3', kind: 'wikilink', editable: false, other }],
        },
      ],
    })
    renderApp('/projects/acme/i/m42')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sessions live in Redis' }),
    ).toBeInTheDocument()
    expect(screen.getByText('m42~', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('agent-written')).toBeInTheDocument()
    expect(screen.getAllByText('docs/sessions.md').length).toBeGreaterThan(0)
    // wikilink in the body goes to the resolver
    expect(screen.getByRole('link', { name: 'm7' })).toHaveAttribute('href', '/projects/acme/w/m7')
    // tag links to the filtered list
    expect(screen.getByRole('link', { name: 'Items tagged auth' })).toHaveAttribute(
      'href',
      '/projects/acme/memories?tag=auth',
    )
    const links = await screen.findByRole('region', { name: 'Links' })
    expect(within(links).getByRole('link', { name: /S:m3.*Org rule/ })).toHaveAttribute(
      'href',
      '/shared/i/m3',
    )
    expect(within(links).getByText('Linked from')).toBeInTheDocument()
    expect(within(links).getByText(/\[\[missing-page\]\]/)).toBeInTheDocument()
    // a viewer gets no write controls
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Pin' })).not.toBeInTheDocument()
    expect(within(links).queryByRole('button', { name: /Remove relation/ })).not.toBeInTheDocument()
    expect(within(links).queryByRole('link', { name: 'create' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'History' })[0]).toHaveAttribute(
      'href',
      '/projects/acme/i/m42/history',
    )
  })

  it('accepts a proposed ADR by setting its status with the loaded revision', async () => {
    const adr = itemFixture({
      id: 'id-d',
      handle: 'ADR-0007',
      space: 'decisions',
      type: null,
      confidence: null,
      adr_number: 7,
      status: 'proposed',
      revision: 2,
    })
    const m = mockApi({
      ...baseRoutes('editor'),
      'GET /api/v1/projects/acme/items/ADR-0007': [200, adr],
      'GET /api/v1/projects/acme/items/ADR-0007/edges': noEdges,
      'PATCH /api/v1/projects/acme/items/ADR-0007': [
        200,
        { item: { ...adr, status: 'accepted', revision: 3 }, warnings: [] },
      ],
    })
    renderApp('/projects/acme/i/ADR-0007')
    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    await waitFor(() =>
      expect(m.find('PATCH', '/api/v1/projects/acme/items/ADR-0007')[0]?.body).toEqual({
        revision: 2,
        status: 'accepted',
      }),
    )
    expect(await screen.findByText('ADR-0007 accepted')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Supersede' })).not.toBeInTheDocument()
  })

  it('pins, and hard-deletes only after the handle is typed (project admin)', async () => {
    const m = mockApi({
      ...baseRoutes('admin'),
      // the refetch after the pin sees the pinned item
      'GET /api/v1/projects/acme/items/m42': [
        [200, itemFixture()],
        [200, itemFixture({ pinned: true })],
      ],
      'GET /api/v1/projects/acme/items/m42/edges': noEdges,
      'POST /api/v1/projects/acme/items/m42/pin': [200, { item: itemFixture({ pinned: true }) }],
      'DELETE /api/v1/projects/acme/items/m42': [204],
      'GET /api/v1/projects/acme/spaces/memories/items': [200, { items: [], next_cursor: null }],
    })
    const { router } = renderApp('/projects/acme/i/m42')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Pin' }))
    expect(await screen.findByRole('button', { name: 'Unpin' })).toBeInTheDocument()
    expect(m.find('POST', '/api/v1/projects/acme/items/m42/pin')).toHaveLength(1)

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete m42 permanently?' })
    const confirm = within(dialog).getByRole('button', { name: 'Delete' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText(/Type/), 'm42')
    await user.click(confirm)
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/acme/memories'))
    expect(m.find('DELETE', '/api/v1/projects/acme/items/m42')[0]?.url.searchParams.get('confirm')).toBe(
      'm42',
    )
  })

  it('an editor (not admin) cannot delete in a project; restores an expired observation as a fact', async () => {
    const obs = itemFixture({
      type: 'observation',
      lifecycle: 'archived',
      archive_reason: 'expired',
      archived_at: '2026-10-10T00:00:00Z',
      expires_at: '2026-10-09T00:00:00Z',
      revision: 4,
    })
    const m = mockApi({
      ...baseRoutes('editor'),
      'GET /api/v1/projects/acme/items/m42': [200, obs],
      'GET /api/v1/projects/acme/items/m42/edges': noEdges,
      'POST /api/v1/projects/acme/items/m42/restore': [200, { item: itemFixture({ revision: 5 }) }],
    })
    renderApp('/projects/acme/i/m42')
    const user = userEvent.setup()
    expect((await screen.findAllByText('archived (expired)')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    const dialog = await screen.findByRole('dialog', { name: 'Restore m42?' })
    await user.click(within(dialog).getByRole('button', { name: 'Promote and restore' }))
    await waitFor(() =>
      expect(m.find('POST', '/api/v1/projects/acme/items/m42/restore')[0]?.body).toEqual({
        promote_to_fact: true,
        revision: 4,
      }),
    )
  })

  it('shows the superseded-by chain', async () => {
    mockApi({
      ...baseRoutes('viewer'),
      'GET /api/v1/projects/acme/items/m42': [
        200,
        itemFixture({ status: 'superseded', superseded_by: 'm60' }),
      ],
      'GET /api/v1/projects/acme/items/m42/edges': noEdges,
      'GET /api/v1/projects/acme/items/m60': [
        200,
        itemFixture({
          id: 'id-60',
          handle: 'm60',
          title: 'Valkey',
          status: 'superseded',
          superseded_by: 'm72',
        }),
      ],
      'GET /api/v1/projects/acme/items/m72': [
        200,
        itemFixture({ id: 'id-72', handle: 'm72', title: 'Postgres' }),
      ],
    })
    renderApp('/projects/acme/i/m42')
    const banner = (await screen.findByText('Superseded', { selector: 'p' })).parentElement as HTMLElement
    await waitFor(() => expect(banner).toHaveTextContent('Superseded by m60 Valkey → m72 Postgres.'))
  })

  it('on the shared space a shared editor may delete', async () => {
    mockApi({
      ...baseRoutes('editor', '_shared'),
      'GET /api/v1/projects/_shared/items/m3': [200, itemFixture({ handle: 'm3', project: '_shared' })],
      'GET /api/v1/projects/_shared/items/m3/edges': noEdges,
    })
    renderApp('/shared/i/m3')
    expect(await screen.findByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/shared/i/m3/edit')
  })
})
