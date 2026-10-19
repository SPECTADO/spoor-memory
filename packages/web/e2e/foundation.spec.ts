/**
 * Foundation flows in a real browser against the Vite dev server, with `/api/v1` mocked in the page
 * (no server needed). The full-stack smoke test of web-ui.md §10 lives in smoke.spec.ts (phase 5).
 */
import { expect, type Page, test } from '@playwright/test'

const me = (isAdmin = true) => ({
  user: { id: 'u1', email: 'ann@example.com', name: 'Ann', is_admin: isAdmin, shared_editor: false },
  memberships: [],
})
const projects = {
  items: [
    {
      slug: 'acme',
      name: 'Acme',
      description: 'Main app',
      role: 'admin',
      counts: { memories: 3, decisions: 1, docs: 2 },
      review_total: 1,
    },
  ],
}

async function mockApi(page: Page, opts: { loggedIn: boolean }) {
  let loggedIn = opts.loggedIn
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const key = `${route.request().method()} ${url.pathname}`
    const json = (status: number, body?: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: body === undefined ? '' : JSON.stringify(body),
      })
    switch (key) {
      case 'GET /api/v1/me':
        return loggedIn ? json(200, me()) : json(401, { error: 'unauthenticated', request_id: 'r' })
      case 'POST /api/v1/auth/login':
        loggedIn = true
        return json(200, { user: me().user })
      case 'GET /api/v1/instance':
        return json(200, {
          version: '0.1.0',
          public_url: 'http://localhost:5173',
          providers: [],
          default_provider: 'local',
        })
      case 'GET /api/v1/projects':
        return json(200, projects)
      case 'GET /api/v1/device/lookup':
        return json(200, {
          project: { slug: 'acme', name: 'Acme' },
          client_name: 'spoor-cli/0.1.0',
          requester_ip: '203.0.113.7',
          requested_at: new Date().toISOString(),
          age_s: 42,
          your_role: 'admin',
        })
      case 'POST /api/v1/device/approve':
        return json(200, { status: 'approved', role_cap: 'viewer' })
      default:
        return json(404, { error: 'not_found', request_id: 'r' })
    }
  })
}

test('log in, land on the project list, open and close the create dialog with the keyboard', async ({
  page,
}) => {
  await mockApi(page, { loggedIn: false })
  await page.goto('/projects')
  await expect(page).toHaveURL(/\/login\?next=%2Fprojects$/)
  await page.getByLabel('Email').fill('ann@example.com')
  await page.getByLabel('Password').fill('correct horse battery')
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Acme' })).toBeVisible()

  const open = page.getByRole('button', { name: 'New project' })
  await open.click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Name')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(open).toBeFocused()
})

test('approve a CLI login read-only', async ({ page }) => {
  await mockApi(page, { loggedIn: true })
  await page.goto('/device?code=WDJBMJHT')
  await expect(page.getByLabel('Code')).toHaveValue('')
  await page.getByLabel('Code').fill('wdjb-mjht')
  await page.keyboard.press('Enter')
  await expect(page.getByText('203.0.113.7')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve read-only' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Approved (read-only) for Acme')).toBeVisible()
})

test('phone width: no horizontal scroll, navigation behind a toggle', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 })
  await mockApi(page, { loggedIn: true })
  await page.goto('/projects')
  await expect(page.getByRole('link', { name: 'Acme' })).toBeVisible()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await expect(page.getByRole('navigation', { name: 'Instance administration' })).toBeHidden()
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(page.getByRole('navigation', { name: 'Instance administration' })).toBeVisible()
})

test('dark mode follows prefers-color-scheme', async ({ browser }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ colorScheme })
    const page = await ctx.newPage()
    await mockApi(page, { loggedIn: false })
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible()
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(bg).toBe(colorScheme === 'dark' ? 'rgb(17, 19, 23)' : 'rgb(255, 255, 255)')
    await ctx.close()
  }
})
