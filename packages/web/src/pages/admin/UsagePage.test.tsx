import { RESOURCE_METRICS, type ResourcePointJson, type UsageJson } from '@spoor/shared'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { qk } from '../../api/keys'
import { dayLabel } from '../../lib/format'
import { json, meFixture, mockApi, renderApp } from '../../test/utils'

const days = Array.from({ length: 14 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`)
const point = (at: string, v: number | null): ResourcePointJson =>
  ({ at, ...Object.fromEntries(RESOURCE_METRICS.map((m) => [m, v])) }) as ResourcePointJson
const summary = (current: number | null, min: number | null, max: number | null) =>
  Object.fromEntries(
    RESOURCE_METRICS.map((m) => [m, { current, min, max }]),
  ) as UsageJson['resources']['metrics']

function usage(over: Partial<UsageJson> = {}, range: '24h' | '14d' = '24h'): UsageJson {
  return {
    generated_at: '2026-11-14T10:00:00Z',
    window: { days: 14, from: '2026-11-01', to: '2026-11-14' },
    totals: {
      requests: 42,
      reads: 30,
      writes: 12,
      searches: 9,
      errors: 2,
      people: 3,
      tokens: 4,
      clients: 2,
      projects: 2,
      revisions: 15,
      items_created: 6,
    },
    per_day: days.map((day, i) => ({
      day,
      reads: i === 13 ? 30 : 0,
      writes: i === 13 ? 12 : 0,
      searches: 0,
      people: 0,
      tokens: 0,
      revisions: i === 13 ? 15 : 0,
      items_created: i === 13 ? 6 : 0,
    })),
    by_project: [
      { slug: 'acme', name: 'Acme', reads: 25, writes: 10, last_at: '2026-11-14T09:00:00Z' },
      { slug: 'beta', name: 'Beta', reads: 5, writes: 2, last_at: '2026-11-13T09:00:00Z' },
    ],
    by_operation: [
      {
        operation: 'spoor_search',
        surface: 'mcp',
        kind: 'read',
        requests: 9,
        errors: 0,
        avg_ms: 40,
        p95_ms: 90,
      },
      {
        operation: 'POST /push',
        surface: 'cli',
        kind: 'write',
        requests: 3,
        errors: 2,
        avg_ms: 12,
        p95_ms: 20,
      },
    ],
    by_client: [
      { client: 'claude-code', requests: 35, people: 2 },
      { client: null, requests: 7, people: 1 },
    ],
    by_surface: [
      { surface: 'cli', reads: 0, writes: 3 },
      { surface: 'mcp', reads: 30, writes: 9 },
    ],
    resources: {
      range,
      bucket_s: range === '24h' ? 900 : 7200,
      interval_s: 300,
      from: '2026-11-13T10:15:00Z',
      to: '2026-11-14T10:00:00Z',
      samples: 2,
      last_sample_at: new Date(Date.now() - 120_000).toISOString(),
      host: 'spoor-app',
      pool_max: 10,
      cpus: 4,
      points: [point('2026-11-14T09:30:00Z', null), point('2026-11-14T09:45:00Z', 2)],
      metrics: summary(3, 1, 5),
    },
    ...over,
  }
}

const admin = { 'GET /api/v1/me': [200, meFixture({ is_admin: true })] as [number, unknown] }

describe('AdminUsagePage', () => {
  it('shows totals, says it counts agent traffic only, and lists projects, operations and clients', async () => {
    mockApi({ ...admin, 'GET /api/v1/status/usage': [200, usage()] })
    renderApp('/admin/usage')
    const totals = await screen.findByLabelText('Totals for the last 14 days')
    expect(totals).toHaveTextContent('Requests42')
    expect(totals).toHaveTextContent('MCP 39 · CLI 3')
    expect(screen.getByText(/Web UI use is not counted/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /Agent requests per day/ })).toBeInTheDocument()
    const perDay = screen.getByRole('table', { name: 'Agent requests per day' })
    expect(within(perDay).getByRole('row', { name: /Nov 14/ })).toHaveTextContent('3012')
    const projects = screen.getByRole('table', { name: 'Requests by project' })
    expect(within(projects).getByRole('link', { name: 'Acme' })).toHaveAttribute('href', '/projects/acme')
    const ops = screen.getByRole('table', { name: 'Requests by operation' })
    expect(within(ops).getByRole('row', { name: /POST \/push/ })).toHaveTextContent('12 / 20 ms')
    const clients = screen.getByRole('table', { name: 'Requests by client' })
    expect(within(clients).getByText('unknown')).toBeInTheDocument()
  })

  it('charts each host metric with its numbers, and switches the range', async () => {
    const { find } = mockApi({
      ...admin,
      'GET /api/v1/status/usage': (req) =>
        json(200, usage({}, req.url.searchParams.get('range') === '14d' ? '14d' : '24h')),
    })
    renderApp('/admin/usage')
    const host = await screen.findByRole('region', { name: 'Host resources' })
    expect(within(host).getByText(/Sampled every 5 minutes on spoor-app/)).toBeInTheDocument()
    expect(
      within(host).getByRole('img', {
        name: 'Memory (RSS) Memory (RSS), last 24 hours: now 3 B, lowest 1 B, highest 5 B.',
      }),
    ).toBeInTheDocument()
    expect(within(host).getByText('of 10')).toBeInTheDocument()
    await userEvent.click(within(host).getByRole('button', { name: '14 days' }))
    await waitFor(() =>
      expect(find('GET', '/api/v1/status/usage').at(-1)?.url.searchParams.get('range')).toBe('14d'),
    )
    expect(await within(host).findByRole('img', { name: /Process CPU, last 14 days/ })).toBeInTheDocument()
    expect(within(host).getByRole('button', { name: '14 days' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('describes the range the charts show while the selected one loads, and marks the card busy', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    mockApi({
      ...admin,
      'GET /api/v1/status/usage': async (req) => {
        if (req.url.searchParams.get('range') !== '14d') return json(200, usage({}, '24h'))
        await gate
        return json(200, usage({}, '14d'))
      },
    })
    renderApp('/admin/usage')
    const host = await screen.findByRole('region', { name: 'Host resources' })
    await userEvent.click(within(host).getByRole('button', { name: '14 days' }))
    expect(within(host).getByRole('button', { name: '14 days' })).toHaveAttribute('aria-pressed', 'true')
    // still the 24 h payload: said so, not "last 14 days"
    expect(host).toHaveAttribute('aria-busy', 'true')
    expect(within(host).getByRole('img', { name: /Process CPU, last 24 hours/ })).toBeInTheDocument()
    expect(within(host).queryByRole('img', { name: /last 14 days/ })).not.toBeInTheDocument()
    release()
    expect(await within(host).findByRole('img', { name: /Process CPU, last 14 days/ })).toBeInTheDocument()
    expect(host).not.toHaveAttribute('aria-busy')
  })

  it('keeps the page on a failed background poll and offers to try again', async () => {
    mockApi({
      ...admin,
      'GET /api/v1/status/usage': [
        [200, usage()],
        [500, { error: 'internal', request_id: 'r' }],
      ],
    })
    const { qc } = renderApp('/admin/usage')
    expect(await screen.findByRole('region', { name: 'Host resources' })).toBeInTheDocument()
    await qc.refetchQueries({ queryKey: qk.adminUsage('24h') })
    expect(await screen.findByText('Could not refresh.')).toBeInTheDocument()
    expect(screen.getByLabelText('Totals for the last 14 days')).toHaveTextContent('Requests42')
    expect(screen.getByRole('button', { name: '14 days' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('shows empty states without traffic or samples', async () => {
    const empty = usage()
    mockApi({
      ...admin,
      'GET /api/v1/status/usage': [
        200,
        {
          ...empty,
          totals: { ...empty.totals, requests: 0 },
          by_project: [],
          resources: { ...empty.resources, samples: 0, last_sample_at: null, host: null, points: [] },
        },
      ],
    })
    renderApp('/admin/usage')
    expect(await screen.findByText('No agent requests in the last 14 days')).toBeInTheDocument()
    expect(screen.getByText('No samples yet')).toBeInTheDocument()
    expect(screen.getByText(/runs only where SPOOR_JOBS=on/)).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Requests by project' })).not.toBeInTheDocument()
  })

  it('is linked from the status page and the admin navigation', async () => {
    mockApi({ ...admin, 'GET /api/v1/status': [500, { error: 'internal', request_id: 'r' }] })
    renderApp('/admin/status')
    expect(await screen.findByRole('link', { name: 'Usage over time' })).toHaveAttribute(
      'href',
      '/admin/usage',
    )
    expect(screen.getByRole('link', { name: 'Usage' })).toHaveAttribute('href', '/admin/usage')
  })

  it('labels UTC days', () => {
    expect(dayLabel('2026-11-03')).toBe('Nov 3')
  })
})
