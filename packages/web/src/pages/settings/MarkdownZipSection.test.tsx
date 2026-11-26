import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { apiError, mockApi, renderInRouter } from '../../test/utils'
import { MarkdownZipSection } from './MarkdownZipSection'

const task = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  format: 'markdown',
  status,
  source: 'live',
  project: { id: 'p1', slug: 'acme', name: 'Acme' },
  backup_id: null,
  source_project: null,
  requested_by: { id: 'u1', label: 'Ann' },
  file_name: status === 'ready' ? 'spoor-acme-markdown-20261126.zip' : null,
  size_bytes: status === 'ready' ? 4096 : null,
  sha256: null,
  error: null,
  created_at: '2026-11-26T10:00:00Z',
  finished_at: null,
  expires_at: status === 'ready' ? '2099-01-01T00:00:00Z' : null,
  download_url: status === 'ready' ? `/api/v1/exports/${id}/download` : null,
  ...over,
})

describe('MarkdownZipSection', () => {
  it('queues a task and lists a ready one as a plain download link', async () => {
    const api = mockApi({
      'GET /api/v1/projects/acme/exports': [
        200,
        { items: [task('t2', 'ready'), task('t1', 'failed', { error: 'disk full' })] },
      ],
      'POST /api/v1/projects/acme/exports': [202, { task: task('t3', 'queued') }],
    })
    renderInRouter(<MarkdownZipSection slug="acme" />)
    const link = await screen.findByRole('link', { name: /spoor-acme-markdown-20261126\.zip/ })
    expect(link).toHaveAttribute('href', '/api/v1/exports/t2/download')
    expect(screen.getByText('disk full')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Prepare Markdown zip' }))
    await waitFor(() => expect(api.find('POST', '/api/v1/projects/acme/exports')).toHaveLength(1))
    expect(api.find('POST', '/api/v1/projects/acme/exports')[0]?.body).toEqual({ format: 'markdown' })
    await waitFor(() => expect(api.find('GET', '/api/v1/projects/acme/exports').length).toBeGreaterThan(1))
  })

  it('shows a running task and offers Cancel (deleting it)', async () => {
    const api = mockApi({
      'GET /api/v1/projects/acme/exports': [
        [200, { items: [task('t1', 'running')] }],
        [200, { items: [task('t1', 'ready')] }],
      ].map(
        ([s, b]) =>
          () =>
            new Response(JSON.stringify(b), { status: s as number }),
      ),
      'DELETE /api/v1/exports/t1': [204],
    })
    renderInRouter(<MarkdownZipSection slug="acme" />)
    expect(await screen.findByText('Building')).toBeInTheDocument()
    expect(screen.getByText(/1 in progress/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(api.find('DELETE', '/api/v1/exports/t1')).toHaveLength(1))
  })

  it('shows too_many_pending as a message', async () => {
    mockApi({
      'GET /api/v1/projects/acme/exports': [200, { items: [] }],
      'POST /api/v1/projects/acme/exports': apiError(503, 'too_many_pending', {
        message: 'Too many zips are being prepared.',
      }),
    })
    renderInRouter(<MarkdownZipSection slug="acme" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Prepare Markdown zip' }))
    expect(await screen.findByText('Too many zips are being prepared.')).toBeInTheDocument()
  })
})
