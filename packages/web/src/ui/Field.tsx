/**
 * Form controls with their label, hint and error wired up (`aria-describedby`, `aria-invalid`). Every
 * control takes a visible `label`; `hideLabel` keeps it for screen readers only (search boxes, table cells).
 */
import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from 'react'
import { cx } from './cx'

interface FieldBits {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  hideLabel?: boolean
  /** Classes of the wrapper. */
  className?: string
}

export const controlClass =
  'block w-full rounded-md border border-border-strong bg-bg px-3 text-sm text-fg placeholder:text-muted ' +
  'disabled:cursor-not-allowed disabled:bg-surface disabled:text-muted read-only:bg-surface ' +
  'aria-invalid:border-danger'

function useFieldIds(id: string | undefined, hint: unknown, error: unknown) {
  const auto = useId()
  const controlId = id ?? auto
  const hintId = hint ? `${controlId}-hint` : undefined
  const errorId = error ? `${controlId}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  return { controlId, hintId, errorId, describedBy }
}

function FieldShell({
  controlId,
  label,
  hint,
  hintId,
  error,
  errorId,
  hideLabel,
  className,
  required,
  children,
}: FieldBits & {
  controlId: string
  hintId?: string
  errorId?: string
  required?: boolean
  children: ReactNode
}) {
  return (
    <div className={cx('space-y-1', className)}>
      <label htmlFor={controlId} className={cx('block text-sm font-medium', hideLabel && 'sr-only')}>
        {label}
        {required && (
          <span className="text-muted" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </label>
      {children}
      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> &
  FieldBits & { inputClassName?: string }

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, hideLabel, className, inputClassName, id, ...rest },
  ref,
) {
  const ids = useFieldIds(id, hint, error)
  return (
    <FieldShell {...ids} {...{ label, hint, error, hideLabel, className }} required={rest.required}>
      <input
        ref={ref}
        id={ids.controlId}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        className={cx(controlClass, 'h-9', inputClassName)}
        {...rest}
      />
    </FieldShell>
  )
})

export type TextareaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> &
  FieldBits & { inputClassName?: string }

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, hideLabel, className, inputClassName, id, rows = 4, ...rest },
  ref,
) {
  const ids = useFieldIds(id, hint, error)
  return (
    <FieldShell {...ids} {...{ label, hint, error, hideLabel, className }} required={rest.required}>
      <textarea
        ref={ref}
        id={ids.controlId}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        className={cx(controlClass, 'py-2', inputClassName)}
        {...rest}
      />
    </FieldShell>
  )
})

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> &
  FieldBits & {
    inputClassName?: string
    options?: readonly { value: string; label: string; disabled?: boolean }[]
  }

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, error, hideLabel, className, inputClassName, id, options, children, ...rest },
  ref,
) {
  const ids = useFieldIds(id, hint, error)
  return (
    <FieldShell {...ids} {...{ label, hint, error, hideLabel, className }} required={rest.required}>
      <select
        ref={ref}
        id={ids.controlId}
        aria-invalid={error ? true : undefined}
        aria-describedby={ids.describedBy}
        className={cx(controlClass, 'h-9 pr-8', inputClassName)}
        {...rest}
      >
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {children}
      </select>
    </FieldShell>
  )
})

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> & {
  label: ReactNode
  hint?: ReactNode
  className?: string
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, hint, className, id, ...rest },
  ref,
) {
  const auto = useId()
  const controlId = id ?? auto
  return (
    <div className={cx('flex items-start gap-2', className)}>
      <input
        ref={ref}
        id={controlId}
        type="checkbox"
        aria-describedby={hint ? `${controlId}-hint` : undefined}
        className="mt-0.5 size-4 accent-[var(--c-accent)]"
        {...rest}
      />
      <div>
        <label htmlFor={controlId} className="text-sm">
          {label}
        </label>
        {hint && (
          <p id={`${controlId}-hint`} className="text-xs text-muted">
            {hint}
          </p>
        )}
      </div>
    </div>
  )
})

/** Map `invalid_input.details.issues` (`path` like `settings.cleanup.stale_days`) to a field → message map. */
export function issuesByField(issues: { path: string; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of issues) if (!(i.path in out)) out[i.path] = i.message
  return out
}
