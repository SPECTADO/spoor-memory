/**
 * Editor flows through the real router: the revision conflict dialog (web-ui.md §5.3) and the frontmatter
 * form validation (§5.1). CodeMirror is replaced by a textarea here; Playwright covers the real editor.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiError, mockApi, renderApp } from '../../test/utils'
import { baseRoutes, itemFixture } from './testFixtures'

vi.mock('../../ui/MarkdownEditorImpl', () => ({
  default: ({
    value,
    onChange,
    label = 'Editor',
  }: {
    value: string
    onChange: (v: string) => void
    label?: string
  }) => <textarea aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />,
}))

beforeEach(() => {
  window.localStorage.clear()
})

const theirs = itemFixture({
  revision: 7,
  title: 'Sessions live in Valkey',
  body: 'Sessions moved to Valkey.\n',
  updated_by: 'bob@example.com',
  client_name: 'claude-code/2.1.303',
})
const conflict = () =>
  apiError(409, 'revision_conflict', {
    message: 'Item m42 is at revision 7, request was based on 3.',
    details: { current_revision: 7, current: theirs },
  })

function editRoutes(patchReplies: unknown[]) {
  return {
    ...baseRoutes('editor'),
    'GET /api/v1/projects/acme/items/m42': [200, itemFixture()] as [number, unknown],
    'GET /api/v1/projects/acme/items/m42/edges': [200, { outgoing: [], incoming: [] }] as [number, unknown],
    'PATCH /api/v1/projects/acme/items/m42': patchReplies as never,
  }
}

async function openEditorAndChangeTitle() {
  const user = userEvent.setup()
  const title = await screen.findByLabelText(/^Title/)
  expect(title).toHaveValue('Sessions live in Redis')
  const save = screen.getByRole('button', { name: 'Save' })
  expect(save).toBeDisabled()
  expect(screen.getByText(/editing r3/)).toBeInTheDocument()
  await user.type(title, ' 7')
  expect(save).toBeEnabled()
  await user.click(save)
  return user
}

describe('editor: revision conflict', () => {
  it('shows who saved the newer revision, compares, and saves my changes over it', async () => {
    const m = mockApi(
      editRoutes([
        conflict(),
        [200, { item: itemFixture({ revision: 8, title: 'Sessions live in Redis 7' }), warnings: [] }],
      ]),
    )
    const { router } = renderApp('/projects/acme/i/m42/edit')
    const user = await openEditorAndChangeTitle()

    const dialog = await screen.findByRole('dialog', { name: 'Someone saved a newer version' })
    expect(dialog).toHaveTextContent(
      /m42 is now r7, saved by bob@example\.com via claude-code\/2\.1\.303 .*You were editing r3\./,
    )
    expect(m.find('PATCH', '/api/v1/projects/acme/items/m42')[0]?.body).toEqual({
      revision: 3,
      title: 'Sessions live in Redis 7',
    })

    await user.click(within(dialog).getByRole('button', { name: 'Compare' }))
    expect(within(dialog).getByText('Sessions moved to Valkey.')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Save my version over r7' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/acme/i/m42'))
    // only my change, on top of r7
    expect(m.find('PATCH', '/api/v1/projects/acme/items/m42')[1]?.body).toEqual({
      revision: 7,
      title: 'Sessions live in Redis 7',
    })
    expect(await screen.findByText('Saved as r8')).toBeInTheDocument()
  })

  it('"Discard mine" reloads the newer revision into the form', async () => {
    const m = mockApi(editRoutes([conflict()]))
    renderApp('/projects/acme/i/m42/edit')
    const user = await openEditorAndChangeTitle()
    const dialog = await screen.findByRole('dialog', { name: 'Someone saved a newer version' })
    await user.click(within(dialog).getByRole('button', { name: 'Discard mine' }))

    await waitFor(() => expect(screen.getByLabelText(/^Title/)).toHaveValue('Sessions live in Valkey'))
    expect(screen.getByLabelText('Editor')).toHaveValue('Sessions moved to Valkey.\n')
    expect(screen.getByText(/editing r7/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(m.find('PATCH', '/api/v1/projects/acme/items/m42')).toHaveLength(1)
  })

  it('"Keep editing" keeps my text on the old base, so the next save conflicts again', async () => {
    const m = mockApi(editRoutes([conflict(), conflict()]))
    renderApp('/projects/acme/i/m42/edit')
    const user = await openEditorAndChangeTitle()
    const dialog = await screen.findByRole('dialog', { name: 'Someone saved a newer version' })
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Sessions live in Redis 7')

    await user.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('dialog', { name: 'Someone saved a newer version' })
    const patches = m.find('PATCH', '/api/v1/projects/acme/items/m42')
    expect(patches).toHaveLength(2)
    expect(patches[1]?.body).toMatchObject({ revision: 3 })
  })
})

describe('editor: frontmatter form', () => {
  it('validates title, tags and anchors as you type and sends a clean create body', async () => {
    const created = itemFixture({ id: 'id-43', handle: 'm43', number: 43, title: 'Use Redis', revision: 1 })
    const m = mockApi({
      ...baseRoutes('editor'),
      'POST /api/v1/projects/acme/spaces/memories/items': [
        201,
        {
          item: created,
          warnings: [{ code: 'near_duplicate', handle: 'm7', cos: 0.951, title: 'Redis it is' }],
        },
      ],
      'GET /api/v1/projects/acme/items/m43': [200, created],
      'GET /api/v1/projects/acme/items/m43/edges': [200, { outgoing: [], incoming: [] }],
    })
    const { router } = renderApp('/projects/acme/memories/new')
    const user = userEvent.setup()
    const title = await screen.findByLabelText(/^Title/)
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()

    await user.type(title, 'Use Redis')
    expect(save).toBeEnabled()
    expect(screen.getByLabelText('Slug')).toHaveAttribute('placeholder', 'use-redis')

    // tags: checked against the shared pattern while typing
    const tags = screen.getByLabelText('Tags')
    await user.type(tags, 'Bad Tag!')
    expect(tags).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(/Not a valid tag/)).toBeInTheDocument()
    await user.clear(tags)
    await user.type(tags, 'API{Enter}')
    expect(within(screen.getByRole('list', { name: 'Tags' })).getByText('api')).toBeInTheDocument()
    expect(tags).toHaveValue('')

    // anchors: the shared normaliser; a ".." segment blocks saving
    const anchors = screen.getByLabelText('Anchors')
    await user.type(anchors, '../secrets')
    expect(screen.getByText(/^Line 1: must be a repo-relative path/)).toBeInTheDocument()
    expect(anchors).toHaveAttribute('aria-invalid', 'true')
    expect(save).toBeDisabled()
    await user.clear(anchors)
    await user.type(anchors, './src//cache/')
    expect(save).toBeEnabled()

    await user.selectOptions(screen.getByLabelText('Type'), 'procedure')
    await user.type(screen.getByLabelText('Editor'), 'Use the shared pool.')
    await user.click(save)

    await waitFor(() => expect(router.state.location.pathname).toBe('/projects/acme/i/m43'))
    expect(m.find('POST', '/api/v1/projects/acme/spaces/memories/items')[0]?.body).toEqual({
      title: 'Use Redis',
      body: 'Use the shared pool.',
      tags: ['api'],
      anchors: ['src/cache/'],
      type: 'procedure',
      confidence: 'medium',
    })
    const banner = await screen.findByText('A similar item exists')
    expect(banner.parentElement).toHaveTextContent('m7 Redis it is (cos 0.95)')
  })

  it('maps server invalid_input issues to their fields', async () => {
    mockApi({
      ...baseRoutes('editor'),
      'POST /api/v1/projects/acme/spaces/docs/items': apiError(400, 'invalid_input', {
        message: 'Invalid input.',
        details: { issues: [{ path: 'tags.0', message: 'tag is reserved' }] },
      }),
    })
    renderApp('/projects/acme/docs/new')
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText(/^Title/), 'Runbook')
    await user.type(screen.getByLabelText('Tags'), 'ops{Enter}')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('tag is reserved')).toBeInTheDocument()
    expect(screen.getByText('Some fields need attention.')).toBeInTheDocument()
  })

  it('a viewer gets the no-access page instead of the editor', async () => {
    mockApi({ ...baseRoutes('viewer') })
    renderApp('/projects/acme/memories/new')
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeInTheDocument()
  })
})

describe('library editor gate', () => {
  it('shows Forbidden on /library/new to an editor without the library right', async () => {
    mockApi(baseRoutes('editor', 'acme', { can_edit_library: false }))
    renderApp('/projects/acme/library/new')
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeInTheDocument()
  })

  it('opens the docs form for a viewer holding the library right', async () => {
    mockApi(baseRoutes('viewer', 'acme', { can_edit_library: true }))
    renderApp('/projects/acme/library/new')
    expect(await screen.findByLabelText(/^Title/)).toBeInTheDocument()
    expect(screen.getByLabelText('Slug')).toBeInTheDocument()
    expect(screen.queryByLabelText('Type')).not.toBeInTheDocument()
  })

  it('does not let the editor role alone edit a library page', async () => {
    mockApi({
      ...baseRoutes('editor', 'acme', { can_edit_library: false }),
      'GET /api/v1/projects/acme/items/L3': [200, itemFixture({ handle: 'L3', space: 'library' })],
      'GET /api/v1/projects/acme/items/L3/edges': [200, { outgoing: [], incoming: [] }],
    })
    renderApp('/projects/acme/i/L3/edit')
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeInTheDocument()
  })
})
