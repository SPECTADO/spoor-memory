/**
 * Item view, editor and history in a real browser against the Vite dev server, `/api/v1` mocked in the page:
 * the real CodeMirror editor and live preview, the revision conflict dialog, the history diff and restore,
 * keyboard use and phone width.
 */
import { expect, type Page, test } from '@playwright/test'

const project = {
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
    memory: { exclusive: true },
  },
  role: 'editor',
  embedding: { model: 'x', target: null, remaining: 0 },
  created_at: '2026-10-01T00:00:00Z',
}

function item(over: Record<string, unknown> = {}) {
  return {
    id: 'id-42',
    handle: 'm42',
    project: 'acme',
    space: 'memories',
    number: 42,
    adr_number: null,
    slug: 'session-store',
    title: 'Sessions live in Redis',
    type: 'fact',
    status: 'active',
    lifecycle: 'active',
    confidence: 'medium',
    tags: ['auth'],
    anchors: ['src/auth/'],
    pinned: false,
    revision: 3,
    provenance: 'human',
    decided_on: null,
    source_path: null,
    push_conflict_at: null,
    last_verified_at: '2026-10-01T00:00:00Z',
    last_used_at: null,
    expires_at: null,
    stale_since: null,
    archived_at: null,
    archive_reason: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    updated_by: 'ann@example.com',
    client_name: null,
    body: 'Sessions are stored in **Redis**.\n\nSee [[m7]].\n',
    extra: {},
    created_by: { id: 'u1', label: 'ann@example.com' },
    superseded_by: null,
    ...over,
  }
}

const actor = { user_id: 'u1', label: 'ann@example.com', via: 'web', client_name: null }

async function mockApi(
  page: Page,
  opts: { patch?: (body: Record<string, unknown>, n: number) => [number, unknown] },
) {
  const patches: Record<string, unknown>[] = []
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const key = `${req.method()} ${url.pathname}`
    const json = (status: number, body?: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: body === undefined ? '' : JSON.stringify(body),
      })
    switch (key) {
      case 'GET /api/v1/me':
        return json(200, {
          user: { id: 'u1', email: 'ann@example.com', name: 'Ann', is_admin: false, shared_editor: false },
          memberships: [],
        })
      case 'GET /api/v1/projects':
        return json(200, {
          items: [
            {
              slug: 'acme',
              name: 'Acme',
              description: '',
              role: 'editor',
              counts: { memories: 1, decisions: 0, docs: 0, library: 0 },
              review_total: 0,
            },
          ],
        })
      case 'GET /api/v1/projects/acme':
        return json(200, project)
      case 'GET /api/v1/projects/acme/review':
        return json(200, { counts: { stale: 0, archived: 0, expiring: 0, conflicts: 0, push_conflicts: 0 } })
      case 'GET /api/v1/projects/acme/items/m42':
        return json(200, item())
      case 'GET /api/v1/projects/acme/items/m42/edges':
        return json(200, { outgoing: [], incoming: [] })
      case 'PATCH /api/v1/projects/acme/items/m42': {
        const body = req.postDataJSON() as Record<string, unknown>
        patches.push(body)
        const [status, res] = opts.patch?.(body, patches.length) ?? [200, { item: item(), warnings: [] }]
        return json(status, res)
      }
      case 'GET /api/v1/projects/acme/items/m42/revisions':
        return json(200, {
          items: [
            {
              revision: 3,
              title: 'Sessions live in Redis',
              status: 'active',
              change: 'update',
              actor,
              created_at: '2026-10-03T10:00:00Z',
            },
            {
              revision: 2,
              title: 'Sessions live in Redis',
              status: 'active',
              change: 'update',
              actor,
              created_at: '2026-10-02T10:00:00Z',
            },
            {
              revision: 1,
              title: 'Sessions',
              status: 'active',
              change: 'create',
              actor,
              created_at: '2026-10-01T10:00:00Z',
            },
          ],
          next_cursor: null,
        })
      default: {
        const m = /^GET \/api\/v1\/projects\/acme\/items\/m42\/revisions\/(\d)$/.exec(key)
        if (m) {
          const n = Number(m[1])
          const bodies = ['', 'Sessions in memory.\n', 'Sessions are stored in Redis.\n', item().body]
          return json(200, {
            revision: n,
            title: n === 1 ? 'Sessions' : 'Sessions live in Redis',
            status: 'active',
            change: n === 1 ? 'create' : 'update',
            actor,
            created_at: `2026-10-0${n}T10:00:00Z`,
            body: bodies[n],
            frontmatter: { title: 'x', tags: n === 3 ? ['auth'] : [], anchors: ['src/auth/'], type: 'fact' },
          })
        }
        return json(404, { error: 'not_found', request_id: 'r' })
      }
    }
  })
  return { patches }
}

test('edit in CodeMirror with live preview, hit a conflict, save over the newer revision', async ({
  page,
}) => {
  const theirs = item({
    revision: 7,
    body: 'Sessions moved to Valkey.\n',
    updated_by: 'bob@example.com',
    client_name: 'claude-code/2.1.303',
  })
  const api = await mockApi(page, {
    patch: (_b, n) =>
      n === 1
        ? [
            409,
            {
              error: 'revision_conflict',
              message: 'conflict',
              details: { current_revision: 7, current: theirs },
              request_id: 'r',
            },
          ]
        : [200, { item: item({ revision: 8 }), warnings: [] }],
  })
  await page.goto('/projects/acme/i/m42')
  await expect(page.getByRole('heading', { level: 1, name: 'Sessions live in Redis' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'm7' })).toHaveAttribute('href', '/projects/acme/w/m7')
  await page.getByRole('link', { name: 'Edit' }).click()

  const editor = page.getByRole('textbox', { name: 'Editor' })
  await expect(editor).toBeVisible()
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type('\nA new *line*.')
  const preview = page.getByRole('region', { name: 'Preview' })
  await expect(preview.locator('em')).toHaveText('line')
  // Tab is not captured: keyboard users can leave the editor
  await page.keyboard.press('Tab')
  await expect(editor).not.toBeFocused()

  await page.getByRole('button', { name: 'Save' }).click()
  const dialog = page.getByRole('dialog', { name: 'Someone saved a newer version' })
  await expect(dialog).toContainText('m42 is now r7, saved by bob@example.com via claude-code/2.1.303')
  await dialog.getByRole('button', { name: 'Compare' }).click()
  await expect(dialog.getByText('Sessions moved to Valkey.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Save my version over r7' }).click()
  await expect(page).toHaveURL(/\/projects\/acme\/i\/m42$/)
  await expect(page.getByText('Saved as r8')).toBeVisible()
  expect(api.patches[0]?.revision).toBe(3)
  expect(api.patches[1]?.revision).toBe(7)
  expect(String(api.patches[1]?.body)).toContain('A new *line*.')
})

test('leaving the editor with unsaved changes asks first', async ({ page }) => {
  await mockApi(page, {})
  await page.goto('/projects/acme/i/m42/edit')
  const title = page.getByLabel('Title')
  await title.fill('Changed title')
  await page.getByRole('button', { name: 'Cancel' }).click()
  const dialog = page.getByRole('dialog', { name: 'Leave without saving?' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Stay' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(title).toHaveValue('Changed title')
})

test('history: diff two revisions and restore one into the editor', async ({ page }) => {
  await mockApi(page, {})
  await page.goto('/projects/acme/i/m42/history?rev=2')
  await expect(page.getByRole('heading', { name: 'History of m42' })).toBeVisible()
  const body = page.getByRole('region', { name: 'Body' })
  await expect(body).toContainText('Sessions in memory.')
  await expect(body).toContainText('Sessions are stored in Redis.')
  await page.getByRole('button', { name: 'Restore this version' }).click()
  await expect(page).toHaveURL(/\/i\/m42\/edit$/)
  await expect(page.getByText('Loaded r2 into the form')).toBeVisible()
  await expect(page.locator('.cm-content')).toContainText('Sessions are stored in Redis.')
})

test('phone width: item view and editor have no horizontal scroll; editor uses Write/Preview', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 740 })
  await mockApi(page, {})
  await page.goto('/projects/acme/i/m42')
  await expect(page.getByRole('heading', { level: 1, name: 'Sessions live in Redis' })).toBeVisible()
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(await overflow()).toBeLessThanOrEqual(0)
  await page.goto('/projects/acme/i/m42/edit')
  await expect(page.getByRole('textbox', { name: 'Editor' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Preview' })).toBeHidden()
  await page.getByRole('button', { name: 'Preview' }).click()
  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Preview' }).locator('strong')).toHaveText('Redis')
  expect(await overflow()).toBeLessThanOrEqual(0)
})

test('a library page shows Edit but no Pin or Verify controls', async ({ page }) => {
  await mockApi(page, {})
  // routes registered later win over mockApi's catch-all
  await page.route('**/api/v1/projects/acme', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...project, role: 'viewer', can_edit_library: true }),
    }),
  )
  await page.route('**/api/v1/projects/acme/items/L1', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        item({
          id: 'id-l1',
          handle: 'L1',
          space: 'library',
          number: 1,
          slug: 'graphics-guide',
          title: 'Graphics guide',
          type: null,
          confidence: null,
          body: 'Use the brand palette.\n',
        }),
      ),
    }),
  )
  await page.route('**/api/v1/projects/acme/items/L1/edges', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ outgoing: [], incoming: [] }),
    }),
  )
  await page.goto('/projects/acme/i/L1')
  await expect(page.getByRole('heading', { level: 1, name: 'Graphics guide' })).toBeVisible()
  await expect(page.getByText('Library · human-maintained')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Edit' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pin' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Unpin' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Verify' })).toHaveCount(0)
})
