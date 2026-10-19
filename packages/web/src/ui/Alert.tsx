import type { ReactNode } from 'react'
import { cx } from './cx'

export type AlertTone = 'info' | 'success' | 'warning' | 'danger'

const tones: Record<AlertTone, string> = {
  info: 'border-accent/40 bg-accent-soft',
  success: 'border-success/40 bg-success-soft',
  warning: 'border-warning/40 bg-warning-soft',
  danger: 'border-danger/40 bg-danger-soft',
}

/** Inline banner: form error summaries, warnings on a page. `danger` is announced (role="alert"). */
export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: AlertTone
  title?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cx('rounded-md border px-3 py-2 text-sm', tones[tone], className)}
    >
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={cx(title && 'mt-0.5')}>{children}</div>}
    </div>
  )
}
