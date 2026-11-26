import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { projectFixture } from '../test/browseFixtures'
import { meFixture, mockApi, renderApp } from '../test/utils'

const restoredFrom = {
  backup_id: '20261120T030000Z-auto',
  source_slug: 'acme',
  restored_at: '2026-11-26T10:00:00Z',
}

const setup = (restored: unknown, admin = true) =>
  mockApi({
    'GET /api/v1/me': [
      200,
      meFixture({ is_admin: admin }, [
        { project: { id: 'p-acme', slug: 'acme-r20261120', name: 'Acme copy' }, role: 'admin' },
      ]),
    ],
    'GET /api/v1/projects/acme-r20261120': [
      200,
      { ...projectFixture('acme-r20261120', 'admin'), restored_from: restored },
    ],
    'GET /api/v1/projects/acme-r20261120/dashboard': [200, { counts: {}, review: {}, recent: [] }],
  })

describe('ProjectScope restored-copy banner', () => {
  it('shows "Restored copy, delete when done" with a link to the danger zone for an instance admin', async () => {
    setup(restoredFrom)
    renderApp('/projects/acme-r20261120')
    expect(await screen.findByText('Restored copy, delete when done')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Delete it in the danger zone' })).toHaveAttribute(
      'href',
      '/projects/acme-r20261120/settings?tab=danger',
    )
  })

  it('shows nothing on a normal project', async () => {
    setup(null)
    renderApp('/projects/acme-r20261120')
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByText('Restored copy, delete when done')).not.toBeInTheDocument()
  })
})
