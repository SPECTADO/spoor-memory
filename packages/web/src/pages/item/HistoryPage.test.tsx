import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { mockApi, renderApp } from '../../test/utils'
import { frontmatterDiff } from './frontmatterDiff'
import { baseRoutes, itemFixture } from './testFixtures'

vi.mock('../../ui/MarkdownEditorImpl', () => ({
  default: ({ value, label = 'Editor' }: { value: string; label?: string }) => (
    <textarea aria-label={label} value={value} readOnly />
  ),
}))

const actor = { user_id: 'u1', label: 'ann@example.com', via: 'web', client_name: null }
const summary = (n: number, change: string) => ({
  revision: n,
  title: n === 1 ? 'Sessions in memory' : 'Sessions live in Redis',
  status: 'active',
  change,
  actor: n === 2 ? { ...actor, label: 'agent:claude', via: 'mcp', client_name: 'claude-code/2.1' } : actor,
  created_at: `2026-10-0${n}T10:00:00Z`,
})
const snapshot = (n: number, body: string, tags: string[]) => ({
  ...summary(n, n === 1 ? 'create' : 'update'),
  body,
  frontmatter: { spoor_id: 'id-42', title: summary(n, '').title, tags, anchors: ['src/auth/'], type: 'fact' },
})

function routes() {
  return {
    ...baseRoutes('editor'),
    'GET /api/v1/projects/acme/items/m42': [200, itemFixture()] as [number, unknown],
    'GET /api/v1/projects/acme/items/m42/revisions': [
      200,
      { items: [summary(3, 'update'), summary(2, 'update'), summary(1, 'create')], next_cursor: null },
    ] as [number, unknown],
    'GET /api/v1/projects/acme/items/m42/revisions/1': [200, snapshot(1, 'Line a\nLine b\n', ['auth'])] as [
      number,
      unknown,
    ],
    'GET /api/v1/projects/acme/items/m42/revisions/2': [
      200,
      snapshot(2, 'Line a\nLine B\n', ['auth', 'redis']),
    ] as [number, unknown],
    'GET /api/v1/projects/acme/items/m42/revisions/3': [
      200,
      snapshot(3, 'Line a\nLine B\nLine c\n', ['redis']),
    ] as [number, unknown],
  }
}

describe('history', () => {
  it('lists revisions, diffs the latest against the previous, lets you pick both, and restores one', async () => {
    mockApi(routes())
    const { router } = renderApp('/projects/acme/i/m42/history')
    const user = userEvent.setup()
    const nav = await screen.findByRole('navigation', { name: 'Revisions' })
    const entries = await within(nav).findAllByRole('button')
    expect(entries.map((b) => b.textContent?.slice(0, 2))).toEqual(['r3', 'r2', 'r1'])
    expect(entries[0]).toHaveAttribute('aria-current', 'true')
    expect(entries[1]).toHaveTextContent('agent:claude via mcp (claude-code/2.1)')

    // r3 against r2 by default
    const body = () => screen.getByRole('region', { name: 'Body' })
    await waitFor(() => expect(body()).toHaveTextContent('added: Line c'))
    const fm = screen.getByRole('region', { name: 'Metadata' })
    expect(fm).toHaveTextContent('tags: −auth')
    // the current revision cannot be "restored"
    expect(screen.queryByRole('button', { name: 'Restore this version' })).not.toBeInTheDocument()

    // pick r2, compare it with r1
    await user.click(entries[1] as HTMLElement)
    await waitFor(() => expect(router.state.location.search).toBe('?rev=2'))
    await waitFor(() => expect(body()).toHaveTextContent('removed: Line b'))
    expect(screen.getByText('Sessions in memory')).toBeInTheDocument() // title old → new
    await user.selectOptions(screen.getByLabelText('Compare with'), 'none')
    await waitFor(() => expect(router.state.location.search).toBe('?rev=2&base=none'))

    await user.click(screen.getByRole('button', { name: 'Restore this version' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/acme/i/m42/edit'))
    expect(await screen.findByText(/Loaded r2 into the form/)).toBeInTheDocument()
    expect(screen.getByLabelText('Editor')).toHaveValue('Line a\nLine B\n')
    expect(within(screen.getByRole('list', { name: 'Tags' })).getByText('redis')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(screen.getByText(/editing r3/)).toBeInTheDocument()
  })
})

describe('frontmatterDiff', () => {
  it('reports added, removed and changed keys, and tags/anchors as sets', () => {
    expect(
      frontmatterDiff(
        { spoor_id: 'x', title: 'a', tags: ['a', 'b'], type: 'fact', owner: 'x' },
        { spoor_id: 'x', title: 'b', tags: ['b', 'c'], type: 'procedure', expires: '2026-11-01' },
      ),
    ).toEqual([
      { key: 'expires', kind: 'added', value: '2026-11-01' },
      { key: 'owner', kind: 'removed', value: 'x' },
      { key: 'tags', kind: 'set', added: ['c'], removed: ['a'] },
      { key: 'type', kind: 'changed', from: 'fact', to: 'procedure' },
    ])
  })
})
