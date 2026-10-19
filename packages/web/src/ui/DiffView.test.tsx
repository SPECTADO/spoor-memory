import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { DiffView } from './DiffView'

const text = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

describe('DiffView', () => {
  it('marks changes in text, folds context and expands it', async () => {
    render(<DiffView oldText={text(20)} newText={text(20).replace('line 10', 'line ten')} />)
    expect(screen.getByText('removed:', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('line ten')).toBeInTheDocument()
    expect(screen.queryByText('line 1')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show 6 unchanged lines' }))
    expect(screen.getByText('line 1')).toBeInTheDocument()
  })

  it('word-level toggle highlights only the changed words', async () => {
    const { container } = render(<DiffView oldText={'the old value\n'} newText={'the new value\n'} />)
    await userEvent.click(screen.getByLabelText('Highlight changed words'))
    expect(container.querySelector('.bg-diff-add-strong')?.textContent).toBe('new')
    expect(container.querySelector('.bg-diff-del-strong')?.textContent).toBe('old')
  })

  it('shows the first revision whole and says when nothing changed', () => {
    const { rerender } = render(<DiffView oldText={null} newText={'hello\nworld'} />)
    expect(screen.getByText(/hello/)).toBeInTheDocument()
    rerender(<DiffView oldText="same" newText="same" />)
    expect(screen.getByText('The text is identical.')).toBeInTheDocument()
  })
})
