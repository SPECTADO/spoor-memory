/** Empty, error, not-found and forbidden states (web-ui.md §9). */
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../api/client'
import { Button } from './Button'
import { cx } from './cx'

export function EmptyState({
  title,
  children,
  action,
  className,
}: {
  title?: ReactNode
  /** One sentence on how things get here. */
  children?: ReactNode
  /** One primary action, only if the role allows it. */
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cx('rounded-md border border-dashed border-border-strong px-4 py-8 text-center', className)}
    >
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={cx('text-sm text-muted', title && 'mt-1')}>{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  )
}

/** A failed load: the server's message and hint, plus the request id to quote to an admin. */
export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown
  onRetry?: () => void
  className?: string
}) {
  const api = error instanceof ApiError ? error : null
  const message =
    api?.code === 'network'
      ? 'The server could not be reached.'
      : api?.code === 'starting'
        ? 'The server is starting. Retrying shortly.'
        : (api?.message ?? (error instanceof Error ? error.message : 'Something went wrong.'))
  return (
    <div
      role="alert"
      className={cx('rounded-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm', className)}
    >
      <p className="font-medium">{message}</p>
      {api?.hint && <p className="mt-1">{api.hint}</p>}
      {api?.requestId && (
        <p className="mt-1 text-xs text-muted">
          Request id <code className="font-mono">{api.requestId}</code>
        </p>
      )}
      {onRetry && (
        <Button size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

export function NotFound({
  backTo = '/projects',
  backLabel = 'Back to projects',
}: {
  backTo?: string
  backLabel?: string
}) {
  return (
    <section className="mx-auto max-w-md py-12 text-center">
      <h1 className="text-xl font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-muted">This page does not exist, or you do not have access to it.</p>
      <Link to={backTo} className="mt-4 inline-block text-sm text-accent underline">
        {backLabel}
      </Link>
    </section>
  )
}

export function Forbidden() {
  return (
    <section className="mx-auto max-w-md py-12 text-center">
      <h1 className="text-xl font-semibold">No access</h1>
      <p className="mt-2 text-sm text-muted">You do not have access to this page.</p>
      <Link to="/projects" className="mt-4 inline-block text-sm text-accent underline">
        Back to projects
      </Link>
    </section>
  )
}

/** Page title row: heading, optional description and actions (wrap below on phones). */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold break-words">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}
