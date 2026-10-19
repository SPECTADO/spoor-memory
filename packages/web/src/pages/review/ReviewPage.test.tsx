import { QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import { createQueryClient } from '../../queryClient'
import { json, meFixture, mockApi } from '../../test/utils'
import { ToastProvider } from '../../ui'
import { ReviewPageImpl } from './ReviewPageImpl'

const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: `id${n}`,
  handle: `m${n}`,
  project: 'acme',
  space: 'memories',
  number: n,
  adr_number: null,
  slug: `m-${n}`,
  title: `Memory ${n}`,
  type: 'fact',
  status: 'active',
  lifecycle: 'stale',
  confidence: 'medium',
  tags: [],
  anchors: [],
  pinned: false,
  revision: 2,
  provenance: 'agent',
  decided_on: null,
  source_path: null,
  push_conflict_at: null,
  last_verified_at: '2026-08-01T00:00:00Z',
  last_used_at: null,
  expires_at: null,
  stale_since: '2026-09-01T00:00:00Z',
  archived_at: null,
  archive_reason: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  updated_by: 'ann@example.com',
  client_name: null,
  ...over,
})

const project = (role: string) => ({
  id: 'p1',
  slug: 'acme',
  name: 'Acme',
  description: '',
  kind: 'project',
  settings: {
    cleanup: { stale_days: 30, archive_days: 90, observation_days: 7 },
    digest: { default_budget: 1500, decision_window_days: 30 },
    dedupe: { threshold: 0.92 },
    embedding: { provider: 'local' },
  },
  role,
  embedding: { model: 'x', target: null, remaining: 0 },
  created_at: '2026-10-01T00:00:00Z',
})

const counts = (over: Record<string, number> = {}) => ({
  counts: { stale: 0, archived: 0, expiring: 0, conflicts: 0, push_conflicts: 0, ...over },
})

function renderReview(path: string) {
  const qc = createQueryClient()
  const router = createMemoryRouter([{ path: '/projects/:slug/review', element: <ReviewPageImpl /> }], {
    initialEntries: [path],
  })
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>,
  )
}

const base: Record<string, [number, unknown]> = {
  'GET /api/v1/me': [200, meFixture()],
}

describe('ReviewPage', () => {
  it('opens the first non-empty section, shows counts on the tabs and the used-since-stale badge', async () => {
    mockApi({
      ...base,
      'GET /api/v1/projects/acme': [200, project('editor')],
      'GET /api/v1/projects/acme/review': [200, counts({ archived: 1, stale: 0 })],
      'GET /api/v1/projects/acme/review/archived': [
        200,
        {
          items: [
            item(7, { lifecycle: 'archived', archive_reason: 'stale', archived_at: '2026-10-18T00:00:00Z' }),
          ],
          next_cursor: null,
        },
      ],
    })
    renderReview('/projects/acme/review')
    expect(await screen.findByRole('link', { name: /Memory 7/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Recently archived/ })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('stale', { selector: 'span' })).toBeInTheDocument()
  })

  it('shows the empty state with the current day settings', async () => {
    mockApi({
      ...base,
      'GET /api/v1/projects/acme': [200, project('editor')],
      'GET /api/v1/projects/acme/review': [200, counts()],
      'GET /api/v1/projects/acme/review/stale': [200, { items: [], next_cursor: null }],
    })
    renderReview('/projects/acme/review')
    expect(await screen.findByText('Nothing needs review.')).toBeInTheDocument()
    expect(screen.getByText(/after 30 days/)).toBeInTheDocument()
  })

  it('bulk verifies the selected rows and lists skipped ones with their reason', async () => {
    const stale = [
      { ...item(1), days_to_archive: 10, used_since_stale: true },
      { ...item(2), days_to_archive: 5, used_since_stale: false },
      { ...item(3), days_to_archive: null, used_since_stale: false },
    ]
    const api = mockApi({
      ...base,
      'GET /api/v1/projects/acme': [200, project('editor')],
      'GET /api/v1/projects/acme/review': [200, counts({ stale: 3 })],
      'GET /api/v1/projects/acme/review/stale': [200, { items: stale, next_cursor: null }],
      'POST /api/v1/projects/acme/review/bulk': [
        200,
        { done: ['m1'], skipped: [{ handle: 'm2', reason: 'archived' }] },
      ],
    })
    renderReview('/projects/acme/review?section=stale')
    expect(await screen.findByText('used since stale')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Select m1'))
    await userEvent.click(screen.getByLabelText('Select m2'))
    const bar = screen.getByRole('region', { name: 'Bulk actions' })
    expect(within(bar).getByText('2 selected')).toBeInTheDocument()
    await userEvent.click(within(bar).getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(api.find('POST', '/api/v1/projects/acme/review/bulk')).toHaveLength(1))
    expect(api.find('POST', '/api/v1/projects/acme/review/bulk')[0]?.body).toEqual({
      action: 'verify',
      refs: ['m1', 'm2'],
    })
    expect(await screen.findByText('Verified 1 item.')).toBeInTheDocument()
    expect(screen.getByText(/m2 \(archived/)).toBeInTheDocument()
  })

  it('confirms the action on the last row although its section unmounts at once', async () => {
    mockApi({
      ...base,
      'GET /api/v1/projects/acme': [200, project('editor')],
      'GET /api/v1/projects/acme/review': [
        [200, counts({ stale: 1 })],
        [200, counts()],
      ],
      'GET /api/v1/projects/acme/review/stale': [
        [200, { items: [{ ...item(1), days_to_archive: 3, used_since_stale: false }], next_cursor: null }],
        [200, { items: [], next_cursor: null }],
      ],
      // the reply arrives after the optimistic removal has unmounted the section, as over a network
      'POST /api/v1/projects/acme/items/m1/verify': async () => {
        await screen.findByText('Nothing needs review.')
        return json(200, { item: item(1, { lifecycle: 'active' }) })
      },
    })
    renderReview('/projects/acme/review?section=stale')
    await userEvent.click(await screen.findByRole('button', { name: 'Verify' }))
    expect(await screen.findByText('Verified m1.')).toBeInTheDocument()
  })

  it('puts a row back and shows the error when an action fails', async () => {
    mockApi({
      ...base,
      'GET /api/v1/projects/acme': [200, project('editor')],
      'GET /api/v1/projects/acme/review': [200, counts({ stale: 1 })],
      'GET /api/v1/projects/acme/review/stale': [
        200,
        { items: [{ ...item(1), days_to_archive: 3, used_since_stale: false }], next_cursor: null },
      ],
      'POST /api/v1/projects/acme/items/m1/verify': () =>
        json(500, { error: 'internal', message: 'Boom', request_id: 'r9' }),
    })
    renderReview('/projects/acme/review?section=stale')
    await userEvent.click(await screen.findByRole('button', { name: 'Verify' }))
    expect(await screen.findByText('Boom')).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'Memory 1' })).toBeInTheDocument()
  })

  it('hides every action for a viewer and the delete button for an editor', async () => {
    const stale = { items: [{ ...item(1), days_to_archive: 3, used_since_stale: false }], next_cursor: null }
    mockApi({
      ...base,
      'GET /api/v1/projects/acme': [200, project('viewer')],
      'GET /api/v1/projects/acme/review': [200, counts({ stale: 1 })],
      'GET /api/v1/projects/acme/review/stale': [200, stale],
    })
    renderReview('/projects/acme/review?section=stale')
    expect(await screen.findByRole('link', { name: 'Memory 1' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Select m1')).not.toBeInTheDocument()
  })

  it('offers Keep A / Keep B only for two memories of this project and supersedes the other', async () => {
    const row = (edge: string, a: object, b: object) => ({ edge_id: edge, a, b })
    const api = mockApi({
      ...base,
      'GET /api/v1/projects/acme': [200, project('editor')],
      'GET /api/v1/projects/acme/review': [200, counts({ conflicts: 2 })],
      'GET /api/v1/projects/acme/review/conflicts': [
        200,
        {
          items: [
            row('e1', item(1, { lifecycle: 'active' }), item(2, { lifecycle: 'active' })),
            row(
              'e2',
              item(3, { lifecycle: 'active' }),
              item(4, { handle: 'S:m4', project: '_shared', lifecycle: 'active' }),
            ),
          ],
          next_cursor: null,
        },
      ],
      'POST /api/v1/projects/acme/items/m2/supersede': [200, { new: item(1), old: item(2) }],
    })
    renderReview('/projects/acme/review?section=conflicts')
    expect(await screen.findAllByRole('button', { name: 'Remove relation' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: 'Keep A' })).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Keep A' }))
    await waitFor(() => expect(api.find('POST', '/api/v1/projects/acme/items/m2/supersede')).toHaveLength(1))
    expect(api.find('POST', '/api/v1/projects/acme/items/m2/supersede')[0]?.body).toEqual({ new_id: 'm1' })
  })

  it('restores an expired observation only after the promote confirmation', async () => {
    const api = mockApi({
      ...base,
      'GET /api/v1/projects/acme': [200, project('editor')],
      'GET /api/v1/projects/acme/review': [200, counts({ archived: 1 })],
      'GET /api/v1/projects/acme/review/archived': [
        200,
        {
          items: [
            item(9, {
              type: 'observation',
              lifecycle: 'archived',
              archive_reason: 'expired',
              archived_at: '2026-10-18T00:00:00Z',
              revision: 4,
            }),
          ],
          next_cursor: null,
        },
      ],
      'POST /api/v1/projects/acme/items/m9/restore': [200, { item: item(9, { lifecycle: 'active' }) }],
    })
    renderReview('/projects/acme/review?section=archived')
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    expect(await screen.findByText(/Promote it to a fact and restore\?/)).toBeInTheDocument()
    expect(api.find('POST', '/api/v1/projects/acme/items/m9/restore')).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Promote and restore' }))
    await waitFor(() => expect(api.find('POST', '/api/v1/projects/acme/items/m9/restore')).toHaveLength(1))
    expect(api.find('POST', '/api/v1/projects/acme/items/m9/restore')[0]?.body).toEqual({
      promote_to_fact: true,
      revision: 4,
    })
  })

  it('shows the push-conflict command and no action buttons', async () => {
    mockApi({
      ...base,
      'GET /api/v1/projects/acme': [200, project('editor')],
      'GET /api/v1/projects/acme/review': [200, counts({ push_conflicts: 1 })],
      'GET /api/v1/projects/acme/review/push_conflicts': [
        200,
        {
          items: [
            {
              ...item(5, {
                space: 'decisions',
                handle: 'ADR-0005',
                source_path: 'docs/adr/0005.md',
                push_conflict_at: '2026-10-18T10:00:00Z',
                lifecycle: 'active',
              }),
              edited_by: {
                label: 'ann@example.com',
                via: 'web',
                client_name: null,
                at: '2026-10-17T10:00:00Z',
              },
            },
          ],
          next_cursor: null,
        },
      ],
    })
    renderReview('/projects/acme/review?section=push_conflicts')
    expect(await screen.findByText('docs/adr/0005.md')).toBeInTheDocument()
    expect(screen.getByText(/spoor adr push --force/)).toBeInTheDocument()
    expect(screen.getByText(/via web/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument()
  })

  it('the Undrafted decisions tab lists decision memories without an ADR, read-only (gap a)', async () => {
    mockApi({
      ...base,
      'GET /api/v1/projects/acme': [200, project('viewer')],
      'GET /api/v1/projects/acme/review': [200, counts()],
      'GET /api/v1/projects/acme/decisions/undrafted': [
        200,
        {
          items: [
            {
              handle: 'm4',
              spoor_id: 'u4',
              title: 'Use Redis for the digest cache',
              body: 'why',
              tags: ['cache'],
              anchors: [],
              confidence: 'high',
              created_at: '2026-10-19T08:00:00Z',
            },
          ],
        },
      ],
    })
    renderReview('/projects/acme/review?section=undrafted')
    expect(await screen.findByText('Use Redis for the digest cache')).toBeInTheDocument()
    const tab = screen.getByRole('link', { name: /Undrafted decisions/ })
    expect(tab).toHaveAttribute('aria-current', 'page')
    expect(within(tab).getByText('1')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'm4' })).toHaveAttribute('href', '/projects/acme/i/m4')
    expect(screen.getByText(/spoor adr draft/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
