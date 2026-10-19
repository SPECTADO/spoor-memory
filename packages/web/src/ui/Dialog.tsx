/**
 * Modal dialog on the native `<dialog>` (focus trap, Esc, backdrop and inertness come from the browser).
 * The content is mounted only while open, so forms inside start fresh each time. Focus returns to the
 * element that had it when the dialog opened.
 */
import { X } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Button, IconButton } from './Button'
import { cx } from './cx'
import { Input } from './Field'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  /** Buttons row; right-aligned. */
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  /** When false, Esc and the close button do nothing (a "shown once" secret before it was copied). */
  dismissible?: boolean
}

const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' }

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const returnTo = useRef<HTMLElement | null>(null)
  const titleId = useId()
  const descId = useId()

  // Open the native dialog first, THEN mount the content, so `autoFocus` inside lands in an open modal
  // (showModal() itself would focus the first focusable element, the close button).
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      returnTo.current = document.activeElement as HTMLElement | null
      if (typeof d.showModal === 'function') d.showModal()
      else d.setAttribute('open', '')
      setReady(true)
    } else if (!open && d.open) {
      if (typeof d.close === 'function') d.close()
      else d.removeAttribute('open')
      setReady(false)
      returnTo.current?.focus?.()
    }
  }, [open])

  // unmounting while open (route change) must still release the modal state
  useEffect(() => () => ref.current?.close?.(), [])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault()
        if (dismissible) onClose()
      }}
      className={cx(
        'm-auto w-[calc(100%-2rem)] rounded-lg border border-border bg-bg p-0 text-fg shadow-xl',
        widths[size],
      )}
    >
      {open && ready && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-3">
            <div>
              <h2 id={titleId} className="text-base font-semibold">
                {title}
              </h2>
              {description && (
                <p id={descId} className="mt-0.5 text-sm text-muted">
                  {description}
                </p>
              )}
            </div>
            {dismissible && (
              <IconButton
                label="Close"
                icon={<X className="size-4" aria-hidden="true" />}
                onClick={onClose}
              />
            )}
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && (
            <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
          )}
        </div>
      )}
    </dialog>
  )
}

export interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: ReactNode
  children?: ReactNode
  confirmLabel?: string
  danger?: boolean
  pending?: boolean
  /** When set, the user must type this exact text (a handle, slug or email) before confirming. */
  typeToConfirm?: string
  error?: ReactNode
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel = 'Confirm',
  danger = false,
  pending = false,
  typeToConfirm,
  error,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} title={title} size="sm">
      <ConfirmBody {...{ onClose, onConfirm, confirmLabel, danger, pending, typeToConfirm, error }}>
        {children}
      </ConfirmBody>
    </Dialog>
  )
}

function ConfirmBody({
  onClose,
  onConfirm,
  confirmLabel,
  danger,
  pending,
  typeToConfirm,
  error,
  children,
}: Omit<ConfirmDialogProps, 'open' | 'title'>) {
  const [typed, setTyped] = useState('')
  const ok = typeToConfirm === undefined || typed === typeToConfirm
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (ok && !pending) onConfirm()
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      {children && <div className="text-sm">{children}</div>}
      {typeToConfirm !== undefined && (
        <Input
          label={
            <>
              Type <code className="font-mono">{typeToConfirm}</code> to confirm
            </>
          }
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose} autoFocus={typeToConfirm === undefined}>
          Cancel
        </Button>
        <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={!ok} loading={pending}>
          {confirmLabel}
        </Button>
      </div>
    </form>
  )
}
