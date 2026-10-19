import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { apiError, json, meFixture, mockApi, renderInRouter } from '../../test/utils'
import { ExportImportPanel } from './ExportImportPanel'

const lc = (active: number) => ({ active, stale: 0, archived: 0 })
const dashboard = (items: number) => ({
  counts: { memories: lc(items), decisions: lc(0), docs: lc(0) },
  review: { stale: 0, archived: 0, expiring: 0, conflicts: 0, push_conflicts: 0 },
  recent: [],
})
const result = {
  project: { slug: 'acme' },
  counts: { items: 3, revisions: 3, edges: 1, audit: 0 },
  remapped: false,
  appended_revisions: [],
  dangling_edges: [{ from: 'd1', dst_ref: 'missing-page' }],
  notes: [],
}

function setup(items: number, importReply: Response) {
  const api = mockApi({
    'GET /api/v1/me': [200, meFixture({ is_admin: true })],
    'GET /api/v1/projects/acme/dashboard': [200, dashboard(items)],
    'POST /api/v1/projects/acme/import': () => importReply,
  })
  renderInRouter(<ExportImportPanel slug="acme" />, '/projects/acme/settings')
  return api
}

const zip = () => new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'notes.zip', { type: 'application/zip' })

describe('ExportImportPanel', () => {
  it('export: a download link, with or without history', async () => {
    setup(0, json(200, result))
    const link = await screen.findByRole('link', { name: 'Download export' })
    expect(link.getAttribute('href')).toMatch(/\/api\/v1\/projects\/acme\/export/)
    await userEvent.click(screen.getByLabelText('Without history'))
    expect(screen.getByRole('link', { name: 'Download export' }).getAttribute('href')).toContain('history=0')
  })

  it('empty project: uploads the zip as multipart and shows the summary with dangling edges', async () => {
    const api = setup(0, json(200, result))
    await userEvent.upload(await screen.findByLabelText('Archive (.zip)'), zip())
    await userEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByText('Import finished')).toBeInTheDocument()
    expect(screen.getByText(/3 items, 3 revisions, 1 edges/)).toBeInTheDocument()
    expect(screen.getByText('d1 to missing-page')).toBeInTheDocument()
    const body = api.find('POST', '/api/v1/projects/acme/import')[0]?.init.body
    expect(body).toBeInstanceOf(FormData)
    expect((body as FormData).get('remap_ids')).toBe('false')
  })

  it('non-empty project: the form stays available for a Markdown-folder archive (api.md §9, gap c)', async () => {
    const api = setup(5, json(200, result))
    expect(await screen.findByText(/This project already has items/)).toBeInTheDocument()
    await userEvent.upload(screen.getByLabelText('Archive (.zip)'), zip())
    await userEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByText('Import finished')).toBeInTheDocument()
    expect(api.find('POST', '/api/v1/projects/acme/import')).toHaveLength(1)
  })

  it('non-empty project: a full export is refused by the server and the panel says why', async () => {
    setup(
      5,
      apiError(409, 'project_not_empty', {
        message: 'The target project already has items.',
        hint: 'Import into a new project, or into an empty one.',
      }),
    )
    await userEvent.upload(await screen.findByLabelText('Archive (.zip)'), zip())
    await userEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(screen.getByText('The target project already has items.')).toBeInTheDocument())
    expect(screen.getByText(/This archive is a full Spoor export/)).toBeInTheDocument()
    expect(screen.queryByText('Import finished')).not.toBeInTheDocument()
  })
})
