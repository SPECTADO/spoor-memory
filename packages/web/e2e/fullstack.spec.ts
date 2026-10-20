/**
 * Full stack, no mocks: BRIEF.md definition of done item 4 ("the web UI lists, searches, renders, edits (with
 * history) and administers everything above") plus the browser half of the device login, against the built
 * server and SPA (playwright.config.ts). Also covers the smoke test of web-ui.md §10.
 *
 * Walk: bootstrap admin logs in → creates a project and an invite → the invitee accepts in a second browser
 * context → the admin adds them as a member → memory, decision and doc are written in the editor → search
 * finds all three → the dashboard previews the digest → an edit shows up in the history with a diff → a stale save meets the revision conflict
 * dialog → an item made old in SQL goes stale through the cleanup job and shows in the review queue →
 * Verify clears it → a token is shown once → the device page approves a code requested through the public
 * API → the export downloads a zip → it re-imports into a new, empty project from the settings page.
 */
import { readFileSync } from 'node:fs'
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test'
import { sql } from './support/db'
import { ADMIN, BASE_URL } from './support/env'

const SLUG = 'acme'
const DEV = { email: 'dev@example.com', name: 'Dev Eloper', password: 'dev-password-e2e-1' }
// one rare word in all three items, so the search hits exactly them
const WORD = 'zephyrine'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

let admin: Page
let devContext: BrowserContext
let dev: Page

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  admin = await (await browser.newContext({ baseURL: BASE_URL, acceptDownloads: true })).newPage()
  devContext = await browser.newContext({ baseURL: BASE_URL })
  dev = await devContext.newPage()
})

test.afterAll(async () => {
  await admin?.context().close()
  await devContext?.close()
})

/** Type into the CodeMirror editor (web-ui.md §5.1: the smoke test types into `.cm-content`). */
async function typeBody(page: Page, text: string, replace = false) {
  const editor = page.locator('.cm-content')
  await editor.click()
  if (replace) {
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('Delete')
  } else {
    await page.keyboard.press('ControlOrMeta+End')
  }
  await page.keyboard.type(text)
}

async function createItem(
  page: Page,
  space: 'memories' | 'decisions' | 'docs',
  title: string,
  body: string,
): Promise<string> {
  await page.goto(`/projects/${SLUG}/${space}`)
  const label = { memories: 'New memory', decisions: 'New decision', docs: 'New doc' }[space]
  await page.getByRole('link', { name: label }).click()
  await page.getByLabel('Title').fill(title)
  await typeBody(page, body)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  const handle = decodeURIComponent(page.url().split('/i/')[1] ?? '')
  expect(handle).not.toBe('')
  return handle
}

const handles: Record<'memory' | 'decision' | 'doc', string> = { memory: '', decision: '', doc: '' }
let exportFile = ''

test('the bootstrap admin logs in and sees the project list', async () => {
  await admin.goto('/projects/acme')
  await expect(admin).toHaveURL(/\/login\?next=/)
  await admin.getByLabel('Email').fill(ADMIN.email)
  await admin.getByLabel('Password').fill(ADMIN.password)
  await admin.getByRole('button', { name: 'Log in' }).click()
  // `next` pointed at a project that does not exist yet: Not found, inside the shell
  await expect(admin.getByRole('heading', { name: 'Not found' })).toBeVisible()
  await admin.goto('/projects')
  await expect(admin.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible()
  await expect(admin.getByRole('main').getByText('Shared knowledge').first()).toBeVisible()
})

test('creates a project', async () => {
  await admin.getByRole('button', { name: 'New project' }).first().click()
  const dialog = admin.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Acme')
  await expect(dialog.getByLabel('Slug')).toHaveValue(SLUG)
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(admin).toHaveURL(`/projects/${SLUG}`)
  await expect(admin.getByRole('navigation', { name: 'Project' })).toBeVisible()
})

test('invites a user who accepts in a second browser, then adds them as a member', async () => {
  await admin.goto('/admin/invites')
  await admin.getByRole('button', { name: 'New invite' }).click()
  await admin.getByLabel('Email (optional)').fill(DEV.email)
  await admin.getByRole('button', { name: 'Create invite' }).click()
  const link = await admin.getByLabel('Invite link').inputValue()
  expect(link).toMatch(new RegExp(`^${BASE_URL}/invite#spi_`))
  await admin.getByRole('button', { name: 'Done' }).click()
  await expect(admin.getByRole('cell', { name: DEV.email })).toBeVisible()

  await dev.goto(link)
  await expect(dev.getByRole('heading', { name: 'Accept your invite' })).toBeVisible()
  await dev.getByLabel('Name').fill(DEV.name)
  await expect(dev.getByLabel('Email')).toHaveValue(DEV.email)
  await dev.getByLabel(/^Password/).fill(DEV.password)
  await dev.getByLabel('Repeat the password').fill(DEV.password)
  await dev.getByRole('button', { name: 'Create account' }).click()
  await expect(dev).toHaveURL('/projects')
  await expect(dev.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible()

  await admin.goto(`/projects/${SLUG}/members`)
  await admin.getByLabel('Add member by email').fill(DEV.email)
  await admin.getByLabel('Role', { exact: true }).selectOption('editor')
  await admin.getByRole('button', { name: 'Add member' }).click()
  await expect(admin.getByLabel(`Role of ${DEV.email}`)).toHaveValue('editor')

  // the new member now sees the project
  await dev.reload()
  await expect(dev.getByRole('link', { name: /Acme/ }).first()).toBeVisible()
})

test('creates a memory, a decision and a doc in the editor and renders them', async () => {
  handles.memory = await createItem(
    admin,
    'memories',
    `Sessions use ${WORD} cookies`,
    `Session cookies are signed with the ${WORD} key.\nRotate it **yearly**.`,
  )
  await expect(admin.getByRole('region', { name: 'Body' }).locator('strong')).toHaveText('yearly')

  handles.decision = await createItem(
    admin,
    'decisions',
    `Adopt ${WORD} for session signing`,
    `We sign sessions with ${WORD}. See [[${handles.memory}]].`,
  )
  expect(handles.decision).toMatch(/^ADR-\d{4}$/)
  await expect(admin.getByText('proposed').first()).toBeVisible()

  handles.doc = await createItem(
    admin,
    'docs',
    `${WORD} runbook`,
    `How to rotate the ${WORD} key. Background: [[${handles.decision}]].`,
  )
  // the wikilink renders as a link through the resolver and lands on the decision
  await admin.getByRole('region', { name: 'Body' }).getByRole('link', { name: handles.decision }).click()
  await expect(
    admin.getByRole('heading', { level: 1, name: `Adopt ${WORD} for session signing` }),
  ).toBeVisible()
  await expect(admin).toHaveURL(new RegExp(`/i/${handles.decision}$`))

  // the space lists show them
  await admin.goto(`/projects/${SLUG}/memories`)
  await expect(admin.getByRole('link', { name: `Sessions use ${WORD} cookies` })).toBeVisible()
})

test('search finds all three', async () => {
  await admin.getByRole('searchbox', { name: 'Search this project' }).fill(WORD)
  await admin.keyboard.press('Enter')
  await expect(admin).toHaveURL(new RegExp(`/search\\?q=${WORD}`))
  const results = admin.getByRole('list', { name: 'Search results' })
  await expect(results.getByRole('listitem')).toHaveCount(3)
  for (const title of [
    `Sessions use ${WORD} cookies`,
    `Adopt ${WORD} for session signing`,
    `${WORD} runbook`,
  ]) {
    await expect(results.getByRole('link', { name: title })).toBeVisible()
  }
})

test('the dashboard counts the items and previews the digest', async () => {
  await admin.goto(`/projects/${SLUG}`)
  await expect(admin.getByRole('link', { name: `Sessions use ${WORD} cookies` })).toBeVisible()
  await admin.getByRole('button', { name: 'Preview digest' }).click()
  const dialog = admin.getByRole('dialog', { name: 'Digest preview' })
  await dialog.getByLabel(/Query/).fill(WORD)
  await dialog.getByRole('button', { name: 'Show digest' }).click()
  const digest = dialog.getByRole('region', { name: 'Digest' })
  await expect(digest).toContainText(/About \d+ of 1,500 tokens/)
  await expect(digest.locator('pre')).toContainText(handles.memory)
  await admin.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('an edit is saved as a new revision and shows in the history with a diff', async () => {
  await admin.goto(`/projects/${SLUG}/i/${handles.memory}`)
  await admin.getByRole('link', { name: 'Edit' }).click()
  await expect(admin.getByText('editing r1')).toBeVisible()
  await typeBody(admin, '\nAlso rotate after an incident.')
  await admin.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(admin.getByRole('status').getByText('Saved as r2')).toBeVisible()
  await expect(admin.getByRole('region', { name: 'Body' })).toContainText('Also rotate after an incident.')

  await admin.getByRole('link', { name: 'History' }).first().click()
  const revisions = admin.getByRole('navigation', { name: 'Revisions' })
  await expect(revisions.getByRole('button')).toHaveCount(2)
  await expect(revisions.getByRole('button', { name: /r2/ })).toHaveAttribute('aria-current', 'true')
  await expect(admin.getByRole('group').getByText('Also rotate after an incident.')).toBeVisible()
})

test('a stale save meets the revision conflict dialog', async () => {
  await admin.goto(`/projects/${SLUG}/i/${handles.memory}/edit`)
  await expect(admin.getByText('editing r2')).toBeVisible()

  // meanwhile the other user saves r3 (the SPA's own API, with their session)
  const res = await dev.request.patch(`/api/v1/projects/${SLUG}/items/${handles.memory}`, {
    headers: { origin: BASE_URL },
    data: { revision: 2, title: `Sessions use ${WORD} cookies (signed)` },
  })
  expect(res.status(), await res.text()).toBe(200)

  await typeBody(admin, '\nKeys live in the vault.')
  await admin.getByRole('button', { name: 'Save', exact: true }).click()
  const dialog = admin.getByRole('dialog', { name: 'Someone saved a newer version' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(`${handles.memory} is now r3, saved by ${DEV.email}`)
  await expect(dialog).toContainText('You were editing r2')
  // field-level merge: their title stays, my body goes on top of r3
  await dialog.getByRole('button', { name: 'Save my version over r3' }).click()
  await expect(admin.getByRole('status').getByText('Saved as r4')).toBeVisible()
  await expect(admin.getByRole('heading', { level: 1 })).toHaveText(`Sessions use ${WORD} cookies (signed)`)
  await expect(admin.getByRole('region', { name: 'Body' })).toContainText('Keys live in the vault.')
})

test('an unverified memory goes stale and shows in the review queue; Verify clears it', async () => {
  await admin.goto(`/projects/${SLUG}/review`)
  await expect(admin.getByText('Nothing needs review.')).toBeVisible()

  // 40 days without verification, change or use (the default stale_days is 30)
  const updated = await sql(
    `UPDATE items SET last_verified_at = now() - interval '40 days', updated_at = now() - interval '40 days',
       last_used_at = NULL
     WHERE project_id = (SELECT id FROM projects WHERE slug = $1) AND space = 'memories' AND number = $2`,
    [SLUG, Number(handles.memory.replace(/^m/, ''))],
  )
  expect(updated.rowCount).toBe(1)

  // the cleanup job, started from the admin's jobs page
  await admin.goto('/admin/jobs')
  await admin.getByRole('button', { name: 'Run cleanup now' }).click()
  await expect(
    admin.getByRole('status').getByText(/cleanup (started|did not start: it is already running)/),
  ).toBeVisible()

  const row = admin.getByRole('row', { name: new RegExp(handles.memory) })
  await expect(async () => {
    await admin.goto(`/projects/${SLUG}/review`)
    await expect(row).toBeVisible({ timeout: 2_000 })
  }).toPass({ timeout: 30_000 })
  await expect(admin.getByRole('navigation', { name: 'Review sections' })).toContainText(/Stale\D*1/)
  await expect(row).toContainText(`Sessions use ${WORD} cookies (signed)`)

  await row.getByRole('button', { name: 'Verify' }).click()
  await expect(admin.getByRole('status').getByText(`Verified ${handles.memory}.`)).toBeVisible()
  await expect(admin.getByText('Nothing needs review.')).toBeVisible()
  const lifecycle = await sql(
    `SELECT lifecycle FROM items WHERE project_id = (SELECT id FROM projects WHERE slug = $1) AND number = $2
       AND space = 'memories'`,
    [SLUG, Number(handles.memory.replace(/^m/, ''))],
  )
  expect(lifecycle.rows[0]?.lifecycle).toBe('active')
})

test('a new token is shown exactly once', async () => {
  await admin.goto(`/projects/${SLUG}/tokens`)
  await admin.getByRole('button', { name: 'New token' }).click()
  const create = admin.getByRole('dialog', { name: 'New token' })
  await create.getByLabel('Name').fill('laptop')
  await create.getByRole('button', { name: 'Create token' }).click()

  const shown = admin.getByRole('dialog', { name: 'Token created' })
  await expect(shown).toContainText('This is the only time you can see it')
  const secret = await shown.getByLabel('Token').inputValue()
  expect(secret).toMatch(/^spr_/)
  // cannot be dismissed before "I have copied it"
  await expect(shown.getByRole('button', { name: 'Done' })).toBeDisabled()
  await admin.keyboard.press('Escape')
  await expect(shown).toBeVisible()
  await shown.getByLabel('I have copied it').check()
  await shown.getByRole('button', { name: 'Done' }).click()
  await expect(shown).toBeHidden()

  await expect(admin.getByRole('button', { name: 'Revoke laptop' })).toBeVisible()
  await expect(admin.locator('body')).not.toContainText(secret)
  // the secret works for the CLI's bearer API
  const whoami = await admin.request.get(`/p/${SLUG}/api/whoami`, {
    headers: { authorization: `Bearer ${secret}` },
  })
  expect(whoami.status()).toBe(200)
  expect((await whoami.json()).token.name).toBe('laptop')
})

test('the device page approves a code requested through the public API', async () => {
  const code = await admin.request.post(`/p/${SLUG}/device/code`, { data: { client_name: 'spoor-cli/e2e' } })
  expect(code.status()).toBe(200)
  const { device_code, user_code } = (await code.json()) as { device_code: string; user_code: string }

  const poll = () =>
    admin.request.post(`/p/${SLUG}/device/token`, {
      data: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code },
    })
  const pending = await poll()
  expect(pending.status()).toBe(400)
  expect((await pending.json()).error).toBe('authorization_pending')

  // the developer approves in their own browser session
  await dev.goto('/device')
  await dev.getByLabel('Code').fill(user_code)
  await dev.getByRole('button', { name: 'Continue' }).click()
  await expect(dev.getByText('spoor-cli/e2e')).toBeVisible()
  await expect(dev.getByText('reported by the requester (unverified)', { exact: false })).toBeVisible()
  await dev.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(dev.getByText('Approved for Acme')).toBeVisible()

  // the next poll gets the token, which carries the approver's role
  await expect(async () => {
    const res = await poll()
    expect(res.status(), await res.text()).toBe(200)
    const body = await res.json()
    expect(body.access_token).toMatch(/^spr_/)
    expect(body.project).toBe(SLUG)
    expect(body.role).toBe('editor')
  }).toPass({ timeout: 15_000, intervals: [1_000, 5_000] })
})

test('the export downloads a zip', async () => {
  await admin.goto(`/projects/${SLUG}/settings?tab=data`)
  const [download] = await Promise.all([
    admin.waitForEvent('download'),
    admin.getByRole('link', { name: 'Download export' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(new RegExp(`^spoor-${SLUG}-\\d{8}\\.zip$`))
  const file = await download.path()
  expect(readFileSync(file).subarray(0, 2).toString('latin1')).toBe('PK')
  exportFile = file
})

test('the export re-imports into a new, empty project from the settings page (DoD 6 in the UI)', async () => {
  await admin.goto('/projects')
  await admin.getByRole('button', { name: 'New project' }).first().click()
  const dialog = admin.getByRole('dialog', { name: 'New project' })
  await dialog.getByLabel('Name').fill('Acme copy')
  await expect(dialog.getByLabel('Slug')).toHaveValue('acme-copy')
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(admin).toHaveURL('/projects/acme-copy')
  await admin.goto('/projects/acme-copy/settings?tab=data')
  await admin.getByLabel('Archive (.zip)').setInputFiles(exportFile)
  // the ids already exist in acme, so the lossless import needs new ones
  await admin.getByLabel('Re-create ids').check()
  await admin.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(admin.getByText('Import finished')).toBeVisible()
  await expect(admin.getByText(/ids re-created/)).toBeVisible()
  await admin.goto('/projects/acme-copy/memories')
  await expect(admin.getByRole('link', { name: new RegExp(WORD, 'i') }).first()).toBeVisible()
})

// ---------------------------------------------------------------- library (ADR-0014) ----

const LIB_WORD = 'quillfeather'
const ADMIN2 = { email: 'admin2@example.com', name: 'Second Admin', password: 'admin2-password-e2e-1' }
let admin2Context: BrowserContext
let admin2: Page

test('the admin creates a library page and sees it in the nav, the list, the search and four dashboard cards', async () => {
  await admin.goto(`/projects/${SLUG}`)
  await admin.getByRole('navigation', { name: 'Project' }).getByRole('link', { name: 'Library' }).click()
  await expect(admin).toHaveURL(`/projects/${SLUG}/library`)
  await expect(admin.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible()
  await admin.getByRole('link', { name: 'New page' }).first().click()
  await admin.getByLabel('Title').fill(`Graphics ${LIB_WORD} guide`)
  await typeBody(admin, `Use the ${LIB_WORD} palette for every diagram.`)
  await admin.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(admin.getByRole('heading', { level: 1, name: `Graphics ${LIB_WORD} guide` })).toBeVisible()
  const handle = decodeURIComponent(admin.url().split('/i/')[1] ?? '')
  expect(handle).toMatch(/^L\d+$/)
  // no pin or verify on a library page
  await expect(admin.getByRole('button', { name: 'Pin' })).toHaveCount(0)
  await expect(admin.getByRole('button', { name: 'Verify' })).toHaveCount(0)

  await admin.goto(`/projects/${SLUG}/library`)
  await expect(admin.getByRole('link', { name: `Graphics ${LIB_WORD} guide` })).toBeVisible()

  await admin.getByRole('searchbox', { name: 'Search this project' }).fill(LIB_WORD)
  await admin.keyboard.press('Enter')
  const results = admin.getByRole('list', { name: 'Search results' })
  await expect(results.getByRole('link', { name: `Graphics ${LIB_WORD} guide` })).toBeVisible()

  await admin.goto(`/projects/${SLUG}`)
  const cards = admin.getByRole('region', { name: 'Items per space' })
  await expect(cards.getByRole('listitem')).toHaveCount(4)
  // the card's text runs together ("Library1activenever stale..."), so assert on the active-count line itself
  const libCard = cards
    .getByRole('listitem')
    .filter({ has: admin.getByRole('link', { name: 'Library', exact: true }) })
  await expect(libCard.locator('p').first()).toHaveText(/^1\s*active$/)
})

test('an editor without the library flag sees the page but no New button', async () => {
  await dev.goto(`/projects/${SLUG}/library`)
  await expect(dev.getByRole('link', { name: `Graphics ${LIB_WORD} guide` })).toBeVisible()
  await expect(dev.getByRole('link', { name: 'New page' })).toHaveCount(0)
})

test('after the admin ticks the Library editor flag the editor sees New', async () => {
  await admin.goto(`/projects/${SLUG}/members`)
  const saved = admin.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().includes('/members/') && r.ok(),
  )
  await admin.getByLabel(`Library editor ${DEV.email}`).click()
  await saved
  await expect(admin.getByLabel(`Library editor ${DEV.email}`)).toBeChecked()
  await dev.reload()
  await expect(dev.getByRole('link', { name: 'New page' })).toBeVisible()
})

test('demoting a second admin to editor removes New for that user', async ({ browser }) => {
  // the last project admin cannot be demoted (even by an instance admin), so the project needs two
  async function inviteAdmin(who: { email: string; name: string; password: string }) {
    const invite = await admin.request.post('/api/v1/invites', {
      headers: { origin: BASE_URL },
      data: { email: who.email, grants: [{ project: SLUG, role: 'admin' }] },
    })
    expect(invite.status()).toBe(201)
    const { token } = (await invite.json()) as { token: string }
    const context = await browser.newContext({ baseURL: BASE_URL })
    const accepted = await context.request.post('/api/v1/invites/accept', {
      headers: { origin: BASE_URL },
      data: { token, name: who.name, password: who.password },
    })
    expect(accepted.status()).toBe(201)
    return context
  }
  const keeper = await inviteAdmin({
    email: 'admin3@example.com',
    name: 'Third Admin',
    password: 'admin3-password-e2e-1',
  })
  await keeper.close()
  admin2Context = await inviteAdmin(ADMIN2)
  admin2 = await admin2Context.newPage()
  await admin2.goto(`/projects/${SLUG}/library`)
  await expect(admin2.getByRole('link', { name: 'New page' })).toBeVisible()

  await admin.goto(`/projects/${SLUG}/members`)
  const demoted = admin.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().includes('/members/') && r.ok(),
  )
  await admin.getByLabel(`Role of ${ADMIN2.email}`).selectOption('editor')
  await demoted
  await expect(admin.getByLabel(`Role of ${ADMIN2.email}`)).toHaveValue('editor')
  await expect(admin.getByLabel(`Library editor ${ADMIN2.email}`)).not.toBeChecked()

  await admin2.reload()
  await expect(admin2.getByRole('link', { name: `Graphics ${LIB_WORD} guide` })).toBeVisible()
  await expect(admin2.getByRole('link', { name: 'New page' })).toHaveCount(0)
  await admin2Context.close()
})
