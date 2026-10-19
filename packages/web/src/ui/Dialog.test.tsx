import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './Dialog'

function Harness({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Delete m42
      </button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={onConfirm}
        title="Delete m42?"
        typeToConfirm="m42"
        confirmLabel="Delete"
        danger
      >
        This cannot be undone.
      </ConfirmDialog>
    </>
  )
}

describe('ConfirmDialog', () => {
  it('needs the exact text before confirming and returns focus on cancel', async () => {
    const onConfirm = vi.fn()
    render(<Harness onConfirm={onConfirm} />)
    const opener = screen.getByRole('button', { name: 'Delete m42' })
    await userEvent.click(opener)
    const dialog = await screen.findByRole('dialog', { name: 'Delete m42?' })
    const confirm = screen.getByRole('button', { name: 'Delete' })
    expect(confirm).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/Type m42 to confirm/), 'm4')
    expect(confirm).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/Type m42 to confirm/), '2{Enter}')
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(dialog).not.toHaveAttribute('open')
    expect(opener).toHaveFocus()
  })
})
