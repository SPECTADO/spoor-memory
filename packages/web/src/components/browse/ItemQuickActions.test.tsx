import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { summary } from '../../test/browseFixtures'
import { apiError, mockApi, renderWithProviders } from '../../test/utils'
import { ItemQuickActions } from './ItemQuickActions'

const ok = (over = {}) => [
  200,
  {
    item: {
      ...summary(),
      body: '',
      extra: {},
      created_by: { id: null, label: 'x' },
      superseded_by: null,
      ...over,
    },
  },
]

describe('ItemQuickActions', () => {
  it('pins, verifies and archives through the item actions', async () => {
    const m = mockApi({
      'POST /api/v1/projects/acme/items/m1/pin': ok({ pinned: true }) as [number, unknown],
      'POST /api/v1/projects/acme/items/m1/verify': ok() as [number, unknown],
      'POST /api/v1/projects/acme/items/m1/archive': ok({ lifecycle: 'archived' }) as [number, unknown],
    })
    renderWithProviders(<ItemQuickActions slug="acme" item={summary()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Pin m1' }))
    expect(await screen.findByText('Pinned m1')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Verify m1' }))
    expect(await screen.findByText('Verified m1')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Archive m1' }))
    expect(await screen.findByText('Archived m1')).toBeInTheDocument()
    expect(m.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      '/api/v1/projects/acme/items/m1/pin',
      '/api/v1/projects/acme/items/m1/verify',
      '/api/v1/projects/acme/items/m1/archive',
    ])
  })

  it('offers Unpin for a pinned item and no verify or archive for an archived one', () => {
    renderWithProviders(
      <ItemQuickActions slug="acme" item={summary({ pinned: true, lifecycle: 'archived' })} />,
    )
    expect(screen.getByRole('button', { name: 'Unpin m1' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Verify m1' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Archive m1' })).not.toBeInTheDocument()
  })

  it('shows the server error and keeps the buttons', async () => {
    mockApi({
      'POST /api/v1/projects/acme/items/m1/verify': [
        apiError(403, 'forbidden', { message: 'Not allowed here.' }),
      ] as never,
    })
    renderWithProviders(<ItemQuickActions slug="acme" item={summary()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Verify m1' }))
    expect(await screen.findByText('Not allowed here.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verify m1' })).toBeEnabled()
  })
})
