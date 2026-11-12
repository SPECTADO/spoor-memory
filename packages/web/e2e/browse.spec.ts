/**
 * Dashboard, space list and search in a real browser against the Vite dev server, `/api/v1` mocked in the page.
 * The mock list honours the `tag` filter and the pin action so the flow is exercised end to end.
 */
import { expect, type Page, test } from '@playwright/test'

const item = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  handle: 'm1',
  project: 'acme',
  space: 'memories',
  number: 1,
  adr_number: null,
  slug: 'use-utc',
  title: 'Use UTC everywhere',
  type: 'fact',
  status: 'active',
  lifecycle: 'active',
  confidence: 'medium',
  tags: ['time'],
  anchors: [],
  pinned: false,
  revision: 1,
  provenance: 'human',
  decided_on: null,
  source_path: null,
  push_conflict_at: null,
  last_verified_at: '2026-10-18T10:00:00Z',
  last_used_at: null,
  expires_at: null,
  stale_since: null,
  archived_at: null,
  archive_reason: null,
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-18T10:00:00Z',
  updated_by: 'ann@example.com',
  client_name: null,
  ...over,
})

async function mockApi(page: Page) {
  let pinned = false
  const lists: string[] = []
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const key = `${route.request().method()} ${url.pathname}`
    const json = (status: number, body?: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body ?? {}) })
    switch (key) {
      case 'GET /api/v1/me':
        return json(200, {
          user: { id: 'u1', email: 'ann@example.com', name: 'Ann', is_admin: true, shared_editor: false },
          memberships: [],
        })
      case 'GET /api/v1/projects':
        return json(200, { items: [] })
      case 'GET /api/v1/projects/acme':
        return json(200, {
          slug: 'acme',
          name: 'Acme',
          description: 'Main app',
          kind: 'project',
          role: 'admin',
          settings: {},
        })
      case 'GET /api/v1/projects/acme/review':
        return json(200, { counts: { stale: 1, archived: 0, expiring: 0, conflicts: 0, push_conflicts: 0 } })
      case 'GET /api/v1/projects/acme/dashboard':
        return json(200, {
          counts: {
            memories: { active: 2, stale: 1, archived: 0 },
            decisions: { active: 1, stale: 0, archived: 0 },
            docs: { active: 0, stale: 0, archived: 0 },
            library: { active: 0, stale: 0, archived: 0 },
          },
          review: { stale: 1, archived: 0, expiring: 0, conflicts: 0, push_conflicts: 0 },
          recent: [
            {
              item: item(),
              change: 'create',
              actor: { user_id: 'u1', label: 'ann@example.com', via: 'web', client_name: null },
              at: '2026-10-19T08:00:00Z',
            },
          ],
          links: { unlinked_items: 0, dangling_refs: 0 },
          last_requests: { read: null, write: null },
          stats: {
            window: { days: 14, from: '2026-10-06', to: '2026-10-19' },
            per_day: Array.from({ length: 14 }, (_, i) => ({
              day: `2026-10-${String(6 + i).padStart(2, '0')}`,
              reads: i,
              writes: i % 2,
              changes: i % 3,
            })),
            requests: { today: 13, last_7_days: 60, agents_14_days: 2 },
            people_14_days: 1,
            items_changed_7_days: 2,
            last_cleanup_at: null,
          },
          activity: [
            {
              id: 1,
              at: '2026-10-19T08:00:00Z',
              kind: 'write',
              surface: 'mcp',
              operation: 'spoor_remember_with_a_rather_long_tool_name',
              actor: {
                label: 'someone.with.a.long.address@example-company.com',
                client_name: 'claude-code/2.1.303',
                token_name: 'laptop',
              },
              outcome: 'conflict',
            },
          ],
        })
      case 'GET /api/v1/projects/acme/spaces/memories/items': {
        lists.push(url.search)
        const tags = url.searchParams.getAll('tag')
        const all = [
          item({ pinned }),
          item({ id: 'i2', handle: 'm2', title: 'Retry with jitter', tags: ['net'] }),
        ]
        return json(200, {
          items: tags.length ? all.filter((i) => tags.every((t) => (i.tags as string[]).includes(t))) : all,
          next_cursor: null,
        })
      }
      case 'POST /api/v1/projects/acme/items/m1/pin':
        pinned = true
        return json(200, { item: item({ pinned: true }) })
      case 'GET /api/v1/projects/acme/search':
        return json(200, {
          items: [
            { item: item({ lifecycle: 'stale' }), score: 0.03, snippet: 'always store timestamps in UTC' },
          ],
          notes: [],
        })
      default:
        return json(404, { error: 'not_found', request_id: 'r' })
    }
  })
  return { lists }
}

test('the dashboard fits a phone screen', async ({ page }) => {
  await mockApi(page)
  await page.setViewportSize({ width: 375, height: 800 })
  await page.goto('/projects/acme')
  await expect(page.getByRole('region', { name: 'Status' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Latest agent requests' })).toBeVisible()
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )
  expect(fits).toBe(true)
})

test('dashboard to a filtered, pinnable memory list and a search', async ({ page }) => {
  await mockApi(page)
  await page.goto('/projects/acme')
  await expect(page.getByRole('heading', { name: 'Acme', level: 1 })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Use UTC everywhere' })).toBeVisible()
  const status = page.getByRole('region', { name: 'Status' })
  await expect(status.getByRole('img', { name: /Agent requests per day/ })).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Latest activity' }).getByText('Latest agent requests'),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Install guide (install.md)' })).toHaveAttribute(
    'href',
    '/p/acme/install.md',
  )

  await page.getByRole('region', { name: 'Items per space' }).getByRole('link', { name: 'Memories' }).click()
  await expect(page).toHaveURL(/\/projects\/acme\/memories$/)
  await expect(page.getByRole('link', { name: 'Retry with jitter' })).toBeVisible()

  await page.getByRole('button', { name: 'Filter by tag net' }).click()
  await expect(page).toHaveURL(/tag=net/)
  await expect(page.getByRole('link', { name: 'Use UTC everywhere' })).toHaveCount(0)
  await page.getByRole('button', { name: /Clear filters/ }).click()

  await page.getByRole('button', { name: 'Pin m1' }).click()
  await expect(page.getByRole('button', { name: 'Unpin m1' })).toBeVisible()

  await page.goto('/projects/acme/search')
  await page.getByLabel('Query').fill('utc')
  await expect(page.getByText('always store timestamps in UTC')).toBeVisible()
  await expect(page.getByText('stale', { exact: true })).toBeVisible()
})
