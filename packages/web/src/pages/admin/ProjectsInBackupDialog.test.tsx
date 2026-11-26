import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { apiError, mockApi, renderInRouter } from '../../test/utils'
import { ProjectsInBackupDialog } from './ProjectsInBackupDialog'

const backup = {
  id: '20261120T030000Z-auto',
  kind: 'auto' as const,
  created_at: '2026-11-20T03:00:12.000Z',
  size_bytes: 1000,
  pinned: false,
  verified_at: null,
  spoor_version: '0.8.0',
  migration: { count: 11, last_tag: '0010_backups' },
  pg_server_version: '17.6',
  projects: 3,
  projects_skipped: 1,
  restorable: true,
  protected: false,
}

const proj = (id: string, slug: string, over: Record<string, unknown> = {}) => ({
  id,
  slug,
  name: slug.toUpperCase(),
  kind: 'project',
  items: 12,
  history: true,
  restorable: true,
  skipped_reason: null,
  live: { slug, name: slug.toUpperCase() },
  can_overwrite: true,
  suggested_slug: `${slug}-r20261120`,
  suggested_name: `${slug.toUpperCase()} (restored 2026-11-20)`,
  ...over,
})

const listing = {
  backup_id: backup.id,
  created_at: backup.created_at,
  projects: [
    proj('p1', 'acme'),
    proj('p2', 'big', { restorable: false, skipped_reason: 'too_large', can_overwrite: false }),
    proj('p3', '_shared', { kind: 'shared', can_overwrite: false }),
  ],
}

const task = (status: string, over: Record<string, unknown> = {}) => ({
  task: {
    id: 't1',
    format: 'markdown',
    status,
    source: 'backup',
    project: null,
    backup_id: backup.id,
    source_project: { id: 'p1', slug: 'acme' },
    requested_by: { id: 'u1', label: 'Ann' },
    file_name: 'spoor-acme-markdown-20261126.zip',
    size_bytes: 1500,
    sha256: null,
    error: null,
    created_at: '2026-11-26T10:00:00Z',
    finished_at: null,
    expires_at: null,
    download_url: status === 'ready' ? '/api/v1/exports/t1/download' : null,
    ...over,
  },
})

const BASE = '/api/v1/backups/20261120T030000Z-auto'
const open = () => renderInRouter(<ProjectsInBackupDialog backup={backup} onClose={() => {}} />)

describe('ProjectsInBackupDialog', () => {
  it('lists projects; one without a zip says to use the full restore', async () => {
    mockApi({ [`GET ${BASE}/projects`]: [200, listing] })
    open()
    expect(await screen.findByText('ACME')).toBeInTheDocument()
    expect(screen.getByText('Not restorable per project; use full restore')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Overwrite ACME' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Overwrite _SHARED' })).toBeDisabled()
  })

  it('Download Markdown queues a task and shows a plain download link when ready', async () => {
    const api = mockApi({
      [`GET ${BASE}/projects`]: [200, listing],
      [`POST ${BASE}/projects/p1/exports`]: [202, task('queued')],
      'GET /api/v1/exports/t1': [200, task('ready')],
    })
    open()
    await userEvent.click(await screen.findByRole('button', { name: 'Download Markdown of ACME' }))
    const link = await screen.findByRole('link', { name: /spoor-acme-markdown-20261126\.zip/ })
    expect(link).toHaveAttribute('href', '/api/v1/exports/t1/download')
    expect(link).toHaveAttribute('download')
    expect(api.find('POST', `${BASE}/projects/p1/exports`)[0]?.body).toEqual({ format: 'markdown' })
  })

  it('Restore as copy sends the editable slug and name and links to the new project', async () => {
    const api = mockApi({
      [`GET ${BASE}/projects`]: [200, listing],
      [`POST ${BASE}/projects/p1/restore`]: [
        200,
        {
          mode: 'new',
          project: { id: 'n1', slug: 'acme-copy', name: 'Acme copy' },
          counts: { items: 12, revisions: 14, edges: 3, audit: 0 },
          safety_archive: null,
          restored_from: null,
          notes: [],
        },
      ],
    })
    open()
    await userEvent.click(await screen.findByRole('button', { name: 'Restore ACME as copy' }))
    const slug = screen.getByLabelText('Slug of the copy')
    expect(slug).toHaveValue('acme-r20261120')
    await userEvent.clear(slug)
    await userEvent.type(slug, 'acme-copy')
    await userEvent.click(screen.getByRole('button', { name: 'Restore as copy' }))
    expect(await screen.findByText('Restored as a new project')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Acme copy' })).toHaveAttribute('href', '/projects/acme-copy')
    expect(api.find('POST', `${BASE}/projects/p1/restore`)[0]?.body).toEqual({
      mode: 'new',
      slug: 'acme-copy',
      name: 'ACME (restored 2026-11-20)',
    })
  })

  it('a taken slug is shown on the field', async () => {
    mockApi({
      [`GET ${BASE}/projects`]: [200, listing],
      [`POST ${BASE}/projects/p1/restore`]: apiError(409, 'slug_taken', { message: 'Slug taken.' }),
    })
    open()
    await userEvent.click(await screen.findByRole('button', { name: 'Restore ACME as copy' }))
    await userEvent.click(screen.getByRole('button', { name: 'Restore as copy' }))
    expect(await screen.findByText('This slug is taken: choose another.')).toBeInTheDocument()
  })

  it('Overwrite needs the typed slug and the password', async () => {
    const api = mockApi({
      [`GET ${BASE}/projects`]: [200, listing],
      [`POST ${BASE}/projects/p1/restore`]: [
        200,
        {
          mode: 'overwrite',
          project: { id: 'p1', slug: 'acme', name: 'ACME' },
          counts: { items: 12, revisions: 14, edges: 3, audit: 0 },
          safety_archive: 'safety-acme-20261126T100000Z.zip',
          restored_from: null,
          notes: [],
        },
      ],
    })
    open()
    await userEvent.click(await screen.findByRole('button', { name: 'Overwrite ACME' }))
    const form = screen.getByRole('form', { name: 'Overwrite ACME form' })
    const go = within(form).getByRole('button', { name: 'Overwrite project' })
    expect(go).toBeDisabled()
    await userEvent.type(within(form).getByLabelText(/to confirm/), 'acme')
    await userEvent.type(within(form).getByLabelText('Your password'), 'pw')
    await userEvent.click(go)
    expect(await screen.findByText('Project overwritten from the backup')).toBeInTheDocument()
    expect(screen.getByText(/safety-acme-20261126T100000Z\.zip/)).toBeInTheDocument()
    await waitFor(() =>
      expect(api.find('POST', `${BASE}/projects/p1/restore`)[0]?.body).toEqual({
        mode: 'overwrite',
        password: 'pw',
        confirm: 'acme',
      }),
    )
  })
})
