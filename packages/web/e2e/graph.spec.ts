/**
 * The project map against the real stack (built server and SPA, fresh database, fake embedding model): the
 * admin logs in, seeds a project with a decision, a memory that refines it and a dangling wikilink through the
 * API, then opens the map, sees the nodes and the edge, opens a node's side card, zooms and pans the canvas,
 * switches to the list view and asks the server for unlinked items only.
 */
import { expect, type Page, test } from '@playwright/test'
import { ADMIN } from './support/env'

const SLUG = 'mapdemo'

/** A same-origin JSON call from inside the page, so the session cookie and the Origin header come along. */
async function call<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const res = await page.evaluate(
    async ({ method, path, body }) => {
      const r = await fetch(`/api/v1${path}`, {
        method,
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: r.status, json: await r.json().catch(() => null) }
    },
    { method, path, body },
  )
  expect(res.status, `${method} ${path}: ${JSON.stringify(res.json)}`).toBeLessThan(300)
  return res.json as T
}

test('the map shows nodes, an edge, the side card and the list view', async ({ page }) => {
  test.setTimeout(90_000)
  await page.goto('/login')
  await page.getByLabel('Email').fill(ADMIN.email)
  await page.getByLabel('Password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible()

  await call(page, 'POST', '/projects', { name: 'Map demo', slug: SLUG })
  type Write = { item: { handle: string } }
  const adr = await call<Write>(page, 'POST', `/projects/${SLUG}/spaces/decisions/items`, {
    title: 'Per-user API tokens',
    body: 'Every user gets their own token.',
  })
  const mem = await call<Write>(page, 'POST', `/projects/${SLUG}/spaces/memories/items`, {
    title: 'Tokens are hashed with argon2id',
    body: 'Only the hash is stored. See [[token-rotation]].',
    type: 'fact',
    relations: [{ kind: 'refines', to: adr.item.handle }],
    allow_duplicate: true,
  })

  await page.goto(`/projects/${SLUG}`)
  await page.getByRole('navigation', { name: 'Project' }).getByRole('link', { name: 'Map' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Map' })).toBeVisible()

  const memNode = page.getByRole('button', { name: new RegExp(`^${mem.item.handle} Tokens are hashed`) })
  await expect(memNode).toBeVisible()
  await expect(
    page.getByRole('button', { name: new RegExp(`^${adr.item.handle} Per-user API tokens`) }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /^\[\[token-rotation\]\], no such item/ })).toBeVisible()
  await expect(page.locator('line[data-edge-kind="refines"]')).toHaveCount(1)
  await expect(page.locator('line[data-edge-kind="wikilink"]')).toHaveCount(1)

  await memNode.click()
  const card = page.getByRole('complementary', { name: /Tokens are hashed/ })
  await expect(card).toBeVisible()
  await expect(card.getByText('Refines', { exact: true })).toBeVisible()
  await expect(card.getByRole('region', { name: 'Suggested links' })).toBeVisible()
  await expect(card.getByRole('link', { name: 'Open item' })).toHaveAttribute(
    'href',
    `/projects/${SLUG}/i/${mem.item.handle}`,
  )

  // keyboard: Escape closes the card, Enter on a focused node opens it again
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden()
  await memNode.focus()
  await page.keyboard.press('Enter')
  await expect(card).toBeVisible()

  // the wheel zooms: the view box width changes
  const svg = page.locator('figure > svg')
  const viewBox = async () => ((await svg.getAttribute('viewBox')) ?? '').split(' ').map(Number)
  const w0 = (await viewBox())[2]
  const rect = await svg.boundingBox()
  if (!rect) throw new Error('the map has no box')
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await page.mouse.wheel(0, 200)
  await expect.poll(async () => (await viewBox())[2]).not.toBe(w0)

  // a drag on the background pans and keeps the card open
  const corner = { x: rect.x + 12, y: rect.y + 12 }
  const [x1, y1] = await viewBox()
  await page.mouse.move(corner.x, corner.y)
  await page.mouse.down()
  await page.mouse.move(corner.x + 60, corner.y + 30, { steps: 5 })
  await page.mouse.move(corner.x + 120, corner.y + 60, { steps: 5 })
  await page.mouse.up()
  const [x2, y2] = await viewBox()
  expect(x2).toBeLessThan(x1 ?? 0)
  expect(y2).toBeLessThan(y1 ?? 0)
  await expect(card).toBeVisible()

  // a click on the background closes the card
  await page.mouse.click(corner.x, corner.y)
  await expect(card).toBeHidden()
  await memNode.click()
  await expect(card).toBeVisible()

  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'List' }).click()
  const links = page.getByRole('table', { name: /^Links/ })
  await expect(links.getByRole('row').filter({ hasText: 'refines' })).toHaveCount(1)

  // "Unlinked only" is a server filter; every seeded item has a link
  const unlinked = page.waitForResponse(
    (r) =>
      r.url().includes(`/projects/${SLUG}/graph`) && new URL(r.url()).searchParams.get('unlinked') === 'true',
  )
  // the checked state comes back through the URL, so click (not check) and wait for it
  const toggle = page.getByRole('checkbox', { name: 'Unlinked only' })
  await toggle.click()
  expect((await unlinked).status()).toBe(200)
  await expect(toggle).toBeChecked()
  await expect(page.getByText('No items without links')).toBeVisible()

  // the item page links back to its neighbourhood
  await page.goto(`/projects/${SLUG}/i/${adr.item.handle}`)
  await page.getByRole('link', { name: 'Open in map' }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${SLUG}/graph\\?focus=${adr.item.handle}&depth=2`))
  await expect(page.getByRole('complementary', { name: /Per-user API tokens/ })).toBeVisible()
})
