import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { projectQueryOptions } from '../../api/hooks'
import type { GraphEdge, GraphNode, GraphResponse } from '../../api/types'
import { buildView, layoutGraph } from '../../lib/graphLayout'
import { projectFixture, summary } from '../../test/browseFixtures'
import { json, meFixture, mockApi, renderApp, renderInRouter } from '../../test/utils'
import { baseRoutes, itemFixture } from '../item/testFixtures'
import { GraphCanvas } from './GraphCanvas'

const base = (role: 'viewer' | 'editor' | 'admin', slug = 'acme') => ({
  'GET /api/v1/me': [200, meFixture({}, [{ project: { id: `p-${slug}`, slug, name: 'Acme' }, role }])] as [
    number,
    unknown,
  ],
  [`GET /api/v1/projects/${slug}`]: [200, projectFixture(slug, role)] as [number, unknown],
})

function node(id: string, handle: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    handle,
    project: 'acme',
    space: 'memories',
    title: `Title ${handle}`,
    type: 'fact',
    status: 'active',
    lifecycle: 'active',
    confidence: null,
    pinned: false,
    provenance: 'human',
    tags: [],
    updated_at: '2026-10-20T00:00:00Z',
    last_verified_at: '2026-10-20T00:00:00Z',
    degree_in: 0,
    degree_out: 0,
    ghost: false,
    ...over,
  }
}

const edges: GraphEdge[] = [
  { id: 'e1', kind: 'refines', src: 'n12', dst: 'n6', editable: true },
  { id: 'e2', kind: 'wikilink', src: 'n12', dst: 'nL3', editable: false },
  { id: 'e3', kind: 'wikilink', src: 'n12', dst: null, dst_ref: 'auth-flow', editable: false },
  { id: 'e4', kind: 'conflicts_with', src: 'n6', dst: 'n7', editable: true },
]

function graph(over: Partial<GraphResponse['meta']> = {}): GraphResponse {
  return {
    nodes: [
      node('n12', 'm12', {
        title: 'Tokens are hashed',
        pinned: true,
        provenance: 'agent',
        tags: ['auth'],
        degree_out: 3,
      }),
      node('n6', 'ADR-0006', {
        space: 'decisions',
        title: 'Per-user tokens',
        type: null,
        degree_in: 1,
        degree_out: 1,
      }),
      node('n7', 'm7', { title: 'Shared secrets', lifecycle: 'stale', degree_in: 1 }),
      node('n9', 'm9', { title: 'Lonely fact' }),
      node('nL3', 'S:L3', {
        project: '_shared',
        space: 'library',
        title: 'Security baseline',
        ghost: true,
        degree_in: 1,
      }),
    ],
    edges,
    meta: {
      truncated: false,
      node_cap: 1500,
      total_nodes: 5,
      unlinked_count: 1,
      dangling_count: 1,
      ...over,
    },
  }
}

const settled = (router: ReturnType<typeof renderApp>['router']) =>
  waitFor(() => expect(router.state.navigation.state).toBe('idle'))

const nodeButton = (name: RegExp) => screen.findByRole('button', { name })

describe('GraphPage', () => {
  it('draws nodes with accessible labels, ghosts, the dangling ref and the edges by kind', async () => {
    const api = mockApi({ ...base('viewer'), 'GET /api/v1/projects/acme/graph': [200, graph()] })
    const { container } = renderApp('/projects/acme/graph')
    expect(await screen.findByRole('heading', { level: 1, name: 'Map' })).toBeInTheDocument()
    expect(await nodeButton(/^m12~ Tokens are hashed, memory, pinned, 3 links/)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^ADR-0006 Per-user tokens, decision, 2 links/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^m7 Shared secrets, memory, stale, 1 link$/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: /^S:L3 Security baseline, library page, in the shared space, 1 link/,
      }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '[[auth-flow]], no such item, 1 link' })).toBeInTheDocument()

    const lines = [...container.querySelectorAll('line[data-edge-kind]')]
    expect(lines.map((l) => l.getAttribute('data-edge-kind'))).toEqual([
      'refines',
      'wikilink',
      'wikilink',
      'conflicts_with',
    ])
    const conflict = lines[3] as SVGLineElement
    expect(conflict.getAttribute('marker-start')).toMatch(/^url\(#/)
    expect(conflict.getAttribute('stroke')).toBe('var(--c-danger)')
    expect(lines[0]?.getAttribute('marker-start')).toBeNull()

    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          el.textContent === '5 items · 4 links · 1 item without links · 1 dangling reference',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'View' })).toBeInTheDocument()
    expect(screen.getByText('Legend')).toBeInTheDocument()
    expect(screen.queryByText('The map is cut short')).not.toBeInTheDocument()
    // the default map sends no filters
    expect(api.find('GET', '/api/v1/projects/acme/graph')[0]?.url.search).toBe('')
  })

  it('sends filter toggles as query params and keeps them in the URL', async () => {
    const api = mockApi({ ...base('viewer'), 'GET /api/v1/projects/acme/graph': [200, graph()] })
    const user = userEvent.setup()
    const { router } = renderApp('/projects/acme/graph')
    await nodeButton(/^m12~/)
    const filters = screen.getByRole('search', { name: 'Filter the map' })
    await user.click(within(filters).getByRole('checkbox', { name: 'Library' }))
    await settled(router)
    await user.click(within(filters).getByRole('checkbox', { name: 'wikilink' }))
    await settled(router)
    await user.click(within(filters).getByRole('checkbox', { name: 'Archived' }))
    await settled(router)
    await user.click(within(filters).getByRole('checkbox', { name: 'Include superseded and deprecated' }))
    await settled(router)
    await waitFor(() => {
      const last = api.find('GET', '/api/v1/projects/acme/graph').at(-1)?.url.searchParams
      expect(last?.get('spaces')).toBe('memories,decisions,docs')
      expect(last?.get('kinds')).toBe('refines,supports,depends_on,conflicts_with,supersedes,drafted_from')
      expect(last?.get('lifecycle')).toBe('active,stale,archived')
      expect(last?.get('include_superseded')).toBe('true')
      expect(last?.has('depth')).toBe(false)
    })
    const sp = new URLSearchParams(router.state.location.search)
    expect(sp.get('spaces')).toBe('memories,decisions,docs')
    expect(sp.get('superseded')).toBe('1')
  })

  it('sends unlinked only to the server, keeps the text highlight client-side and counts unlinked items', async () => {
    const lonely: GraphResponse = {
      nodes: [node('n9', 'm9', { title: 'Lonely fact' })],
      edges: [],
      // the server counts before the cap: 40 unlinked items, 1 of them sent
      meta: { truncated: true, node_cap: 1, total_nodes: 40, unlinked_count: 40, dangling_count: 0 },
    }
    const api = mockApi({
      ...base('viewer'),
      'GET /api/v1/projects/acme/graph': (req) =>
        json(200, req.url.searchParams.get('unlinked') === 'true' ? lonely : graph()),
    })
    const user = userEvent.setup()
    const { router } = renderApp('/projects/acme/graph?q=tokens')
    expect(await nodeButton(/^m12~ .*, matches the text filter$/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^ADR-0006 .*, matches the text filter$/ })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^m7 Shared secrets, memory, stale, 1 link$/ }),
    ).toBeInTheDocument()
    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && !!el.textContent?.endsWith('· 2 matches')),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'Unlinked only' }))
    await settled(router)
    // the previous map (with m9 in it) stays up until the server answers
    await waitFor(() => expect(screen.queryByRole('button', { name: /^m12~/ })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: /^m9 Lonely fact/ })).toBeInTheDocument()
    expect(new URLSearchParams(router.state.location.search).get('unlinked')).toBe('1')
    const calls = api.find('GET', '/api/v1/projects/acme/graph')
    expect(calls.at(-1)?.url.searchParams.get('unlinked')).toBe('true')
    expect(calls[0]?.url.searchParams.has('unlinked')).toBe(false)
    for (const c of calls) expect(c.url.searchParams.has('q')).toBe(false)
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'P' &&
          el.textContent === '1 item · 0 links · 40 items without links · 0 dangling references · 0 matches',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText(/Showing 1 of 40 items/)).toBeInTheDocument()
  })

  it('unlinked only is off in a neighbourhood: disabled and never sent with focus', async () => {
    const api = mockApi({
      ...base('viewer'),
      'GET /api/v1/projects/acme/graph': [200, graph()],
      'GET /api/v1/projects/acme/items/ADR-0006': [200, itemFixture({ id: 'n6', handle: 'ADR-0006' })],
      'GET /api/v1/projects/acme/items/ADR-0006/related': [200, { items: [] }],
      'GET /api/v1/projects/acme/items/m12': [200, itemFixture({ id: 'n12', handle: 'm12' })],
      'GET /api/v1/projects/acme/items/m12/related': [200, { items: [] }],
    })
    const user = userEvent.setup()
    const { router } = renderApp('/projects/acme/graph?focus=ADR-0006&unlinked=1')
    await nodeButton(/^ADR-0006 .*, focus$/)
    const box = screen.getByRole('checkbox', { name: 'Unlinked only' })
    expect(box).toBeDisabled()
    expect(box).not.toBeChecked()
    expect(screen.getByText('Whole project only')).toBeInTheDocument()
    expect(api.find('GET', '/api/v1/projects/acme/graph')[0]?.url.searchParams.has('unlinked')).toBe(false)

    // "Focus here" drops unlinked from the URL
    await user.click(screen.getByRole('button', { name: /^m12~/ }))
    await user.click(
      within(await screen.findByRole('complementary', { name: /m12/ })).getByRole('button', {
        name: 'Focus here',
      }),
    )
    await settled(router)
    const sp = new URLSearchParams(router.state.location.search)
    expect(sp.get('focus')).toBe('m12')
    expect(sp.has('unlinked')).toBe(false)
  })

  it('an empty unlinked-only map says so, but never claims every item is linked when cut short', async () => {
    const empty = (truncated: boolean): GraphResponse => ({
      nodes: [],
      edges: [],
      meta: { truncated, node_cap: 1500, total_nodes: 0, unlinked_count: 0, dangling_count: 0 },
    })
    mockApi({ ...base('viewer'), 'GET /api/v1/projects/acme/graph': [200, empty(false)] })
    const view = renderApp('/projects/acme/graph?unlinked=1')
    expect(await screen.findByText('No items without links')).toBeInTheDocument()
    expect(screen.getByText(/Every item these filters keep has a link/)).toBeInTheDocument()
    view.unmount()

    mockApi({ ...base('viewer'), 'GET /api/v1/projects/acme/graph': [200, empty(true)] })
    renderApp('/projects/acme/graph?unlinked=1')
    expect(await screen.findByText('No items match these filters')).toBeInTheDocument()
    expect(screen.queryByText(/has a link/)).not.toBeInTheDocument()
  })

  it('never shows the map of the previous project under a new slug and drops the selection', async () => {
    let release: (r: Response) => void = () => {}
    const betaGraph = new Promise<Response>((r) => {
      release = r
    })
    const memberships = ['acme', 'beta'].map((slug) => ({
      project: { id: `p-${slug}`, slug, name: slug },
      role: 'viewer' as const,
    }))
    mockApi({
      'GET /api/v1/me': [200, meFixture({}, memberships)],
      'GET /api/v1/projects/acme': [200, projectFixture('acme', 'viewer')],
      'GET /api/v1/projects/beta': [200, projectFixture('beta', 'viewer')],
      'GET /api/v1/projects/acme/graph': [200, graph()],
      'GET /api/v1/projects/beta/graph': () => betaGraph,
      'GET /api/v1/projects/acme/items/m12': [200, itemFixture({ id: 'n12', handle: 'm12' })],
      'GET /api/v1/projects/acme/items/m12/related': [200, { items: [] }],
    })
    const user = userEvent.setup()
    const { router, qc } = renderApp('/projects/acme/graph')
    await user.click(await nodeButton(/^m12~/))
    expect(await screen.findByRole('complementary', { name: /m12/ })).toBeInTheDocument()

    // beta is known already (as after the project switcher), so the map page stays mounted across the switch
    await qc.fetchQuery(projectQueryOptions('beta'))
    await act(() => router.navigate('/projects/beta/graph'))
    expect(await screen.findByText('Loading the map')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^m12~/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: /m12/ })).not.toBeInTheDocument()

    // same node id in the new project: the old selection must not carry over
    release(
      json(200, {
        nodes: [node('n12', 'm12', { project: 'beta', title: 'Beta twelve' })],
        edges: [],
        meta: { truncated: false, node_cap: 1500, total_nodes: 1, unlinked_count: 1, dangling_count: 0 },
      }),
    )
    expect(await nodeButton(/^m12 Beta twelve/)).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: /m12/ })).not.toBeInTheDocument()
  })

  it('draws /shared/graph from the _shared project and links its items under /shared', async () => {
    mockApi({
      ...base('viewer', '_shared'),
      'GET /api/v1/projects/_shared/graph': [
        200,
        {
          nodes: [
            node('nL3', 'L3', {
              project: '_shared',
              space: 'library',
              title: 'Security baseline',
              degree_in: 1,
            }),
            node('nd2', 'd2', { project: '_shared', space: 'docs', title: 'Auth overview', degree_out: 1 }),
          ],
          edges: [{ id: 'e1', kind: 'wikilink', src: 'nd2', dst: 'nL3', editable: false }],
          meta: { truncated: false, node_cap: 1500, total_nodes: 2, unlinked_count: 0, dangling_count: 0 },
        } satisfies GraphResponse,
      ],
    })
    const user = userEvent.setup()
    const { router } = renderApp('/shared/graph')
    expect(await nodeButton(/^L3 Security baseline, library page, 1 link/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^d2 Auth overview/ })).toBeInTheDocument()
    await user.click(
      within(screen.getByRole('group', { name: 'View' })).getByRole('button', { name: 'List' }),
    )
    await settled(router)
    const items = await screen.findByRole('table', { name: 'Nodes on the map (2)' })
    expect(within(items).getByRole('link', { name: 'L3 Security baseline' })).toHaveAttribute(
      'href',
      '/shared/i/L3',
    )
    expect(within(items).getByRole('link', { name: 'd2 Auth overview' })).toHaveAttribute(
      'href',
      '/shared/i/d2',
    )
  })

  it('shows the truncated notice from meta', async () => {
    mockApi({
      ...base('viewer'),
      'GET /api/v1/projects/acme/graph': [200, graph({ truncated: true, total_nodes: 2345 })],
    })
    renderApp('/projects/acme/graph')
    expect(await screen.findByText('The map is cut short')).toBeInTheDocument()
    expect(screen.getByText(/Showing 1,500 of 2,345 items/)).toBeInTheDocument()
  })

  it('lists nodes and edges as tables in the list view', async () => {
    mockApi({ ...base('viewer'), 'GET /api/v1/projects/acme/graph': [200, graph()] })
    const user = userEvent.setup()
    const { router } = renderApp('/projects/acme/graph')
    await nodeButton(/^m12~/)
    await user.click(
      within(screen.getByRole('group', { name: 'View' })).getByRole('button', { name: 'List' }),
    )
    await settled(router)
    const items = await screen.findByRole('table', { name: 'Nodes on the map (6)' })
    const shared = within(items).getByRole('link', { name: 'S:L3 Security baseline' })
    expect(shared).toHaveAttribute('href', '/shared/i/L3')
    const row = shared.closest('tr') as HTMLElement
    expect(within(row).getByText('in the shared space')).toBeInTheDocument()
    const links = screen.getByRole('table', { name: 'Links (4)' })
    const conflictRow = within(links).getByText('conflicts with').closest('tr') as HTMLElement
    expect(within(conflictRow).getByRole('link', { name: 'ADR-0006 Per-user tokens' })).toBeInTheDocument()
    expect(within(conflictRow).getByRole('link', { name: 'm7 Shared secrets' })).toBeInTheDocument()
    expect(within(links).getByText('[[auth-flow]]')).toBeInTheDocument()
    expect(new URLSearchParams(router.state.location.search).get('view')).toBe('list')
    expect(screen.queryByRole('button', { name: /^m12~/ })).not.toBeInTheDocument()
  })

  it('opens the card with links and suggested links; a writer links a suggestion in one click', async () => {
    const api = mockApi({
      ...base('editor'),
      'GET /api/v1/projects/acme/graph': [200, graph()],
      'GET /api/v1/projects/acme/items/m12': [
        200,
        itemFixture({ id: 'n12', handle: 'm12', title: 'Tokens are hashed', pinned: true }),
      ],
      'GET /api/v1/projects/acme/items/m12/related': [
        200,
        {
          items: [
            { item: summary({ id: 'n30', handle: 'm30', title: 'Refresh tokens rotate' }), cos: 0.812 },
            {
              item: summary({
                id: 'nd2',
                handle: 'S:d2',
                project: '_shared',
                space: 'docs',
                title: 'Auth overview',
              }),
              cos: 0.744,
            },
          ],
        },
      ],
      'POST /api/v1/projects/acme/items/m12/edges': [201, { edge: {} }],
    })
    const user = userEvent.setup()
    renderApp('/projects/acme/graph')
    await user.click(await nodeButton(/^m12~/))
    const card = await screen.findByRole('complementary', { name: /Tokens are hashed/ })
    expect(within(card).getByText(/3 links/)).toBeInTheDocument()
    expect(within(card).getByText('Refines')).toBeInTheDocument()
    expect(within(card).getByText('Links to')).toBeInTheDocument()
    expect(
      within(card).getByRole('button', { name: 'Show ADR-0006 Per-user tokens on the map' }),
    ).toBeInTheDocument()
    expect(within(card).getByRole('button', { name: 'Show [[auth-flow]] on the map' })).toBeInTheDocument()
    expect(await within(card).findByText('pinned')).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Open item' })).toHaveAttribute(
      'href',
      '/projects/acme/i/m12',
    )
    expect(within(card).getByRole('button', { name: 'Add relation' })).toBeInTheDocument()

    const suggested = within(card).getByRole('region', { name: 'Suggested links' })
    expect(
      await within(suggested).findByRole('link', { name: 'm30 Refresh tokens rotate' }),
    ).toBeInTheDocument()
    expect(within(suggested).getByText('similarity 0.81')).toBeInTheDocument()
    expect(within(suggested).getByRole('link', { name: 'S:d2 Auth overview' })).toHaveAttribute(
      'href',
      '/shared/i/d2',
    )
    await user.selectOptions(
      within(suggested).getByRole('combobox', { name: 'Link kind for m30' }),
      'supports',
    )
    await user.click(within(suggested).getByRole('button', { name: 'Link m12 supports m30' }))
    await waitFor(() =>
      expect(api.find('POST', '/api/v1/projects/acme/items/m12/edges')[0]?.body).toEqual({
        kind: 'supports',
        to: 'm30',
      }),
    )
    expect(await screen.findByText('m12 supports m30')).toBeInTheDocument()

    // a link in the card selects that node; Escape closes the card
    await user.click(within(card).getByRole('button', { name: 'Show ADR-0006 Per-user tokens on the map' }))
    expect(await screen.findByRole('complementary', { name: /Per-user tokens/ })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('complementary', { name: /Per-user tokens/ }), { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('complementary', { name: /Per-user tokens/ })).not.toBeInTheDocument(),
    )
  })

  it('the card shows one muted line with Retry when suggestions fail, and retries', async () => {
    const api = mockApi({
      ...base('viewer'),
      'GET /api/v1/projects/acme/graph': [200, graph()],
      'GET /api/v1/projects/acme/items/m12': [
        200,
        itemFixture({ id: 'n12', handle: 'm12', title: 'Tokens are hashed' }),
      ],
      'GET /api/v1/projects/acme/items/m12/related': [
        [400, { error: 'invalid_input', request_id: 'r1', message: 'bad' }],
        [
          200,
          {
            items: [
              { item: summary({ id: 'n30', handle: 'm30', title: 'Refresh tokens rotate' }), cos: 0.75 },
            ],
          },
        ],
      ] as never,
    })
    const user = userEvent.setup()
    renderApp('/projects/acme/graph')
    await user.click(await nodeButton(/^m12~/))
    const card = await screen.findByRole('complementary', { name: /Tokens are hashed/ })
    const suggested = within(card).getByRole('region', { name: 'Suggested links' })
    expect(await within(suggested).findByText(/Suggestions unavailable/)).toBeInTheDocument()
    expect(within(suggested).queryByRole('alert')).not.toBeInTheDocument()
    await user.click(within(suggested).getByRole('button', { name: 'Retry' }))
    expect(await within(suggested).findByText('similarity 0.75')).toBeInTheDocument()
    expect(api.find('GET', '/api/v1/projects/acme/items/m12/related')).toHaveLength(2)
  })

  it('the card keeps a suggestion disabled after its own link, so a double click sends one edge', async () => {
    const api = mockApi({
      ...base('editor'),
      'GET /api/v1/projects/acme/graph': [200, graph()],
      'GET /api/v1/projects/acme/items/m12': [
        200,
        itemFixture({ id: 'n12', handle: 'm12', title: 'Tokens are hashed' }),
      ],
      // the refetch still returns the row: the button must stay disabled regardless
      'GET /api/v1/projects/acme/items/m12/related': [
        200,
        {
          items: [{ item: summary({ id: 'n30', handle: 'm30', title: 'Refresh tokens rotate' }), cos: 0.8 }],
        },
      ],
      'POST /api/v1/projects/acme/items/m12/edges': [201, { edge: {} }],
    })
    const user = userEvent.setup()
    renderApp('/projects/acme/graph')
    await user.click(await nodeButton(/^m12~/))
    const card = await screen.findByRole('complementary', { name: /Tokens are hashed/ })
    const btn = await within(card).findByRole('button', { name: 'Link m12 refines m30' })
    await user.click(btn)
    await waitFor(() => expect(btn).toBeDisabled())
    await user.click(btn)
    expect(api.find('POST', '/api/v1/projects/acme/items/m12/edges')).toHaveLength(1)
  })

  it('hides write controls from viewers and opens a shared ghost in /shared', async () => {
    mockApi({
      ...base('viewer'),
      'GET /api/v1/projects/acme/graph': [200, graph()],
      'GET /api/v1/projects/_shared/items/L3': [
        200,
        itemFixture({
          id: 'nL3',
          handle: 'L3',
          project: '_shared',
          space: 'library',
          title: 'Security baseline',
        }),
      ],
      'GET /api/v1/projects/acme/items/m12': [200, itemFixture({ id: 'n12', handle: 'm12' })],
      'GET /api/v1/projects/acme/items/m12/related': [
        200,
        {
          items: [{ item: summary({ id: 'n30', handle: 'm30', title: 'Refresh tokens rotate' }), cos: 0.8 }],
        },
      ],
    })
    const user = userEvent.setup()
    renderApp('/projects/acme/graph')
    await user.click(await nodeButton(/^m12~/))
    const card = await screen.findByRole('complementary', { name: /Tokens are hashed|Sessions live/ })
    expect(await within(card).findByRole('link', { name: 'm30 Refresh tokens rotate' })).toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: /^Link / })).not.toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Add relation' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^S:L3 Security baseline/ }))
    const ghost = await screen.findByRole('complementary', { name: /Security baseline/ })
    expect(within(ghost).getByRole('link', { name: 'Open item' })).toHaveAttribute('href', '/shared/i/L3')
    expect(within(ghost).getByRole('link', { name: 'Focus here' })).toHaveAttribute(
      'href',
      '/shared/graph?focus=L3&depth=2',
    )
    expect(within(ghost).queryByRole('region', { name: 'Suggested links' })).not.toBeInTheDocument()
  })

  it('focus mode sends focus and depth, opens the focused card and goes back to the whole project', async () => {
    const api = mockApi({
      ...base('viewer'),
      'GET /api/v1/projects/acme/graph': [200, graph()],
      'GET /api/v1/projects/acme/items/ADR-0006': [
        200,
        itemFixture({ id: 'n6', handle: 'ADR-0006', space: 'decisions', title: 'Per-user tokens' }),
      ],
      'GET /api/v1/projects/acme/items/ADR-0006/related': [200, { items: [], note: 'embedding pending' }],
      'GET /api/v1/projects/acme/items/m12': [200, itemFixture({ id: 'n12', handle: 'm12' })],
      'GET /api/v1/projects/acme/items/m12/related': [200, { items: [] }],
    })
    const user = userEvent.setup()
    const { router } = renderApp('/projects/acme/graph?focus=ADR-0006&depth=1')
    expect(await nodeButton(/^ADR-0006 .*, focus$/)).toBeInTheDocument()
    const first = api.find('GET', '/api/v1/projects/acme/graph')[0]?.url.searchParams
    expect(first?.get('focus')).toBe('ADR-0006')
    expect(first?.get('depth')).toBe('1')
    const card = await screen.findByRole('complementary', { name: /Per-user tokens/ })
    expect(await within(card).findByText('embedding pending')).toBeInTheDocument()
    expect(screen.getByText('Neighbourhood of')).toBeInTheDocument()

    await user.selectOptions(screen.getByRole('combobox', { name: 'Depth' }), '2')
    await settled(router)
    await waitFor(() =>
      expect(api.find('GET', '/api/v1/projects/acme/graph').at(-1)?.url.searchParams.get('depth')).toBe('2'),
    )

    // "Focus here" on another node refocuses the map
    await user.click(screen.getByRole('button', { name: /^m12~/ }))
    await user.click(
      within(await screen.findByRole('complementary', { name: /m12/ })).getByRole('button', {
        name: 'Focus here',
      }),
    )
    await settled(router)
    expect(new URLSearchParams(router.state.location.search).get('focus')).toBe('m12')

    await user.click(screen.getByRole('button', { name: 'Show whole project' }))
    await settled(router)
    const sp = new URLSearchParams(router.state.location.search)
    expect(sp.has('focus')).toBe(false)
    expect(sp.has('depth')).toBe(false)
  })

  it('shows empty states for an empty project and for filters', async () => {
    const empty = {
      nodes: [],
      edges: [],
      meta: { ...graph().meta, total_nodes: 0, unlinked_count: 0, dangling_count: 0 },
    }
    mockApi({ ...base('viewer'), 'GET /api/v1/projects/acme/graph': [200, empty] })
    const view = renderApp('/projects/acme/graph')
    expect(await screen.findByText('Nothing to map yet')).toBeInTheDocument()
    view.unmount()

    mockApi({ ...base('viewer'), 'GET /api/v1/projects/acme/graph': [200, empty] })
    renderApp('/projects/acme/graph?spaces=docs')
    expect(await screen.findByText('No items match these filters')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset filters' })).toBeInTheDocument()
  })

  it('shows the server error and works under /shared', async () => {
    mockApi({
      ...base('viewer', '_shared'),
      'GET /api/v1/projects/_shared/graph': [
        404,
        { error: 'not_found', message: 'No such item: m99', request_id: 'r1' },
      ],
    })
    renderApp('/shared/graph?focus=m99')
    expect(await screen.findByText('No such item: m99')).toBeInTheDocument()
  })
})

describe('item page', () => {
  it('has an "Open in map" link to the item\'s neighbourhood', async () => {
    mockApi({
      ...baseRoutes('viewer'),
      'GET /api/v1/projects/acme/items/m42': [200, itemFixture()],
      'GET /api/v1/projects/acme/items/m42/edges': [200, { outgoing: [], incoming: [] }],
      'GET /api/v1/projects/acme/items/m42/related': [200, { items: [] }],
    })
    renderApp('/projects/acme/i/m42')
    expect(await screen.findByRole('link', { name: 'Open in map' })).toHaveAttribute(
      'href',
      '/projects/acme/graph?focus=m42&depth=2',
    )
  })
})

describe('GraphCanvas', () => {
  const viewBox = (c: HTMLElement) =>
    (c.querySelector('figure > svg')?.getAttribute('viewBox') ?? '').split(' ').map(Number) as [
      number,
      number,
      number,
      number,
    ]
  const routes = () => ({
    ...base('viewer'),
    'GET /api/v1/projects/acme/graph': [200, graph()] as [number, unknown],
    'GET /api/v1/projects/acme/items/m12': [200, itemFixture({ id: 'n12', handle: 'm12' })] as [
      number,
      unknown,
    ],
    'GET /api/v1/projects/acme/items/m12/related': [200, { items: [] }] as [number, unknown],
  })

  it('a background drag pans and keeps the card; a background click closes it', async () => {
    mockApi(routes())
    const user = userEvent.setup()
    const { container } = renderApp('/projects/acme/graph')
    await user.click(await nodeButton(/^m12~/))
    const card = await screen.findByRole('complementary', { name: /m12/ })
    const [x0, y0, w0] = viewBox(container)
    const svg = container.querySelector('figure > svg') as SVGSVGElement

    // a press on a node is not a drag
    fireEvent.pointerDown(screen.getByRole('button', { name: /^m7 / }), { button: 0, clientX: 5, clientY: 5 })
    fireEvent.pointerMove(svg, { clientX: 60, clientY: 60 })
    fireEvent.pointerUp(svg, { clientX: 60, clientY: 60 })
    expect(viewBox(container)).toEqual([x0, y0, w0, expect.any(Number)])
    expect(card).toBeInTheDocument()

    fireEvent.pointerDown(svg, { button: 0, clientX: 100, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(svg, { clientX: 130, clientY: 80, pointerId: 1 })
    fireEvent.pointerUp(svg, { clientX: 130, clientY: 80, pointerId: 1 })
    const [x1, y1, w1] = viewBox(container)
    expect(x1).toBeCloseTo(x0 - 30)
    expect(y1).toBeCloseTo(y0 + 20)
    expect(w1).toBe(w0)
    expect(card).toBeInTheDocument()

    // a jitter under the threshold still counts as a click
    fireEvent.pointerDown(svg, { button: 0, clientX: 50, clientY: 50, pointerId: 1 })
    fireEvent.pointerMove(svg, { clientX: 51, clientY: 51, pointerId: 1 })
    fireEvent.pointerUp(svg, { clientX: 51, clientY: 51, pointerId: 1 })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: /m12/ })).not.toBeInTheDocument())
  })

  it('pans with the arrow keys, zooms with + and -, fits with 0 and opens a node with Enter', async () => {
    mockApi(routes())
    const { container } = renderApp('/projects/acme/graph')
    const m12 = await nodeButton(/^m12~/)
    const fit = viewBox(container)
    const [x0, y0, w0, h0] = fit

    fireEvent.keyDown(m12, { key: 'ArrowRight' })
    expect(viewBox(container)[0]).toBeCloseTo(x0 + w0 * 0.1)
    fireEvent.keyDown(m12, { key: 'ArrowDown' })
    expect(viewBox(container)[1]).toBeCloseTo(y0 + h0 * 0.1)
    fireEvent.keyDown(m12, { key: '0' })
    expect(viewBox(container)).toEqual(fit)

    fireEvent.keyDown(m12, { key: '+' })
    expect(viewBox(container)[2]).toBeCloseTo(w0 * 0.8)
    fireEvent.keyDown(m12, { key: '-' })
    expect(viewBox(container)[2]).toBeCloseTo(w0)
    // modified keys belong to the browser
    fireEvent.keyDown(m12, { key: '+', ctrlKey: true })
    expect(viewBox(container)[2]).toBeCloseTo(w0)

    fireEvent.keyDown(m12, { key: 'Enter' })
    expect(await screen.findByRole('complementary', { name: /m12/ })).toBeInTheDocument()
  })

  it('pan and zoom change only the view box: the node and edge layers do not re-render', () => {
    const view = buildView(graph())
    const layout = layoutGraph(view.nodes, view.edges)
    const radius = vi.fn(() => 6)
    const { container } = renderInRouter(
      <GraphCanvas
        slug="acme"
        view={view}
        layout={layout}
        radius={radius}
        selected={null}
        focusId={null}
        matches={null}
        onSelect={() => {}}
      />,
    )
    const calls = radius.mock.calls.length
    expect(calls).toBeGreaterThan(0)
    const node = screen.getByRole('button', { name: /^m12~/ })
    fireEvent.keyDown(node, { key: '+' })
    expect(viewBox(container)[2]).toBeCloseTo(layout.bounds.width * 0.8)
    fireEvent.keyDown(node, { key: 'ArrowLeft' })
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(viewBox(container)[0]).not.toBe(layout.bounds.x)
    expect(radius.mock.calls.length).toBe(calls)
  })
})
