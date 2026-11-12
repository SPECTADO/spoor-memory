import type { ProjectJson } from '@spoor/shared'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { apiError, mockApi, renderWithProviders } from '../../test/utils'
import { SettingsForm } from './SettingsForm'

const project: ProjectJson = {
  id: 'p1',
  slug: 'acme',
  name: 'Acme',
  description: 'Main app',
  kind: 'project',
  settings: {
    cleanup: { stale_days: 30, archive_days: 90, observation_days: 7 },
    digest: { default_budget: 1500, decision_window_days: 30 },
    dedupe: { threshold: 0.92, related_min_cos: 0.7, refuse_threshold: null },
    embedding: { provider: 'local' },
    memory: { exclusive: true },
  },
  role: 'admin',
  can_edit_library: true,
  embedding: { model: 'local-1', target: null, remaining: 0 },
  created_at: '2026-10-01T00:00:00Z',
}

const patchPath = 'PATCH /api/v1/projects/acme'

describe('SettingsForm', () => {
  it('keeps Save disabled until a field changes and sends only the changed keys of that section', async () => {
    const api = mockApi({ [patchPath]: [200, { ...project, settings: { ...project.settings } }] })
    renderWithProviders(<SettingsForm project={project} />)
    const save = screen.getByRole('button', { name: 'Save cleanup' })
    expect(save).toBeDisabled()
    const stale = screen.getByLabelText('Stale after (days)')
    await userEvent.clear(stale)
    await userEvent.type(stale, '45')
    expect(save).toBeEnabled()
    await userEvent.click(save)
    await waitFor(() => expect(api.find('PATCH', '/api/v1/projects/acme')).toHaveLength(1))
    expect(api.find('PATCH', '/api/v1/projects/acme')[0]?.body).toEqual({
      settings: { cleanup: { stale_days: 45 } },
    })
    expect(await screen.findByText('Cleanup settings saved.')).toBeInTheDocument()
  })

  it('shows range errors from the shared schema and does not call the server', async () => {
    const api = mockApi({})
    renderWithProviders(<SettingsForm project={project} />)
    const threshold = screen.getByLabelText('Duplicate threshold (cosine)')
    await userEvent.clear(threshold)
    await userEvent.type(threshold, '0.5')
    await userEvent.click(screen.getByRole('button', { name: 'Save duplicates' }))
    expect(await screen.findByText('Enter a value from 0.6 to 0.99.')).toBeInTheDocument()
    expect(api.find('PATCH', '/api/v1/projects/acme')).toHaveLength(0)
  })

  it('maps server issues under settings.* back to the field', async () => {
    mockApi({
      [patchPath]: [
        400,
        {
          error: 'invalid_input',
          request_id: 'r1',
          message: 'Invalid input',
          details: {
            issues: [{ path: 'settings.digest.default_budget', message: 'too large for this server' }],
          },
        },
      ],
    })
    renderWithProviders(<SettingsForm project={project} />)
    const budget = screen.getByLabelText('Default budget (tokens)')
    await userEvent.clear(budget)
    await userEvent.type(budget, '4000')
    await userEvent.click(screen.getByRole('button', { name: 'Save digest' }))
    expect(await screen.findByText('too large for this server')).toBeInTheDocument()
  })

  it('saves general fields (name, description) and shows the slug read-only', async () => {
    const api = mockApi({ [patchPath]: [200, { ...project, name: 'Acme 2' }] })
    renderWithProviders(<SettingsForm project={project} />)
    expect(screen.getByLabelText('Slug')).toHaveAttribute('readonly')
    const name = screen.getByLabelText('Name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Acme 2')
    await userEvent.click(screen.getByRole('button', { name: 'Save general' }))
    await waitFor(() => expect(api.find('PATCH', '/api/v1/projects/acme')).toHaveLength(1))
    expect(api.find('PATCH', '/api/v1/projects/acme')[0]?.body).toEqual({ name: 'Acme 2' })
  })

  it('shows a server failure as a banner', async () => {
    mockApi({ [patchPath]: apiError(403, 'forbidden', { message: 'You are not a project admin.' }) })
    renderWithProviders(<SettingsForm project={project} />)
    const days = screen.getByLabelText('Stale after (days)')
    await userEvent.clear(days)
    await userEvent.type(days, '10')
    await userEvent.click(screen.getByRole('button', { name: 'Save cleanup' }))
    expect(await screen.findByText('You are not a project admin.')).toBeInTheDocument()
  })

  it('saves the memory switch and sends only that setting', async () => {
    const api = mockApi({ [patchPath]: [200, project] })
    renderWithProviders(<SettingsForm project={project} />)
    const save = screen.getByRole('button', { name: 'Save memory' })
    expect(save).toBeDisabled()
    const box = screen.getByLabelText("Spoor is the agents' only memory")
    expect(box).toBeChecked()
    await userEvent.click(box)
    await userEvent.click(save)
    await waitFor(() => expect(api.find('PATCH', '/api/v1/projects/acme')).toHaveLength(1))
    expect(api.find('PATCH', '/api/v1/projects/acme')[0]?.body).toEqual({
      settings: { memory: { exclusive: false } },
    })
    expect(await screen.findByText('Memory settings saved.')).toBeInTheDocument()
  })

  it('renders related_min_cos with its bounds, saves it, and shows the bounds error', async () => {
    const api = mockApi({ [patchPath]: [200, project] })
    renderWithProviders(<SettingsForm project={project} />)
    const field = screen.getByLabelText('Related items minimum similarity')
    expect(field).toHaveAttribute('min', '0.4')
    expect(field).toHaveAttribute('max', '0.9')
    expect(field).toHaveAttribute('step', '0.01')
    await userEvent.clear(field)
    await userEvent.type(field, '0.95')
    await userEvent.click(screen.getByRole('button', { name: 'Save duplicates' }))
    expect(await screen.findByText('Enter a value from 0.4 to 0.9.')).toBeInTheDocument()
    expect(api.find('PATCH', '/api/v1/projects/acme')).toHaveLength(0)
    await userEvent.clear(field)
    await userEvent.type(field, '0.6')
    await userEvent.click(screen.getByRole('button', { name: 'Save duplicates' }))
    await waitFor(() => expect(api.find('PATCH', '/api/v1/projects/acme')).toHaveLength(1))
    expect(api.find('PATCH', '/api/v1/projects/acme')[0]?.body).toEqual({
      settings: { dedupe: { related_min_cos: 0.6 } },
    })
  })

  it('refuse_threshold: empty means off, a number is checked against 0.80-1.0, clearing it sends null', async () => {
    const api = mockApi({ [patchPath]: [200, project] })
    const { unmount } = renderWithProviders(<SettingsForm project={project} />)
    const field = screen.getByLabelText('Refuse near-copies from (cosine)')
    expect(field).toHaveValue(null)
    expect(screen.getByText(/Empty = off/)).toBeInTheDocument()
    await userEvent.type(field, '0.7')
    await userEvent.click(screen.getByRole('button', { name: 'Save duplicates' }))
    expect(await screen.findByText('Enter a value from 0.8 to 1.')).toBeInTheDocument()
    await userEvent.clear(field)
    await userEvent.type(field, '0.95')
    await userEvent.click(screen.getByRole('button', { name: 'Save duplicates' }))
    await waitFor(() => expect(api.find('PATCH', '/api/v1/projects/acme')).toHaveLength(1))
    expect(api.find('PATCH', '/api/v1/projects/acme')[0]?.body).toEqual({
      settings: { dedupe: { refuse_threshold: 0.95 } },
    })
    unmount()

    const on = {
      ...project,
      settings: { ...project.settings, dedupe: { ...project.settings.dedupe, refuse_threshold: 0.9 } },
    }
    renderWithProviders(<SettingsForm project={on} />)
    const set = screen.getByLabelText('Refuse near-copies from (cosine)')
    expect(set).toHaveValue(0.9)
    await userEvent.clear(set)
    await userEvent.click(screen.getByRole('button', { name: 'Save duplicates' }))
    await waitFor(() => expect(api.find('PATCH', '/api/v1/projects/acme')).toHaveLength(2))
    expect(api.find('PATCH', '/api/v1/projects/acme')[1]?.body).toEqual({
      settings: { dedupe: { refuse_threshold: null } },
    })
  })

  it('shows the server error when the cut-off is below the stored threshold', async () => {
    mockApi({
      [patchPath]: apiError(400, 'invalid_input', {
        message: 'Invalid settings.',
        details: {
          issues: [
            { path: 'settings.dedupe.refuse_threshold', message: 'must be at least dedupe.threshold' },
          ],
        },
      }),
    })
    renderWithProviders(<SettingsForm project={project} />)
    await userEvent.type(screen.getByLabelText('Refuse near-copies from (cosine)'), '0.9')
    await userEvent.click(screen.getByRole('button', { name: 'Save duplicates' }))
    expect(await screen.findByText('must be at least dedupe.threshold')).toBeInTheDocument()
  })
})
