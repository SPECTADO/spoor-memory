import type { ReactNode } from 'react'
import { cx } from './cx'

/** A link off the app (GitHub): a new tab, no referrer. */
export function ExternalLink({
  href,
  className,
  children,
}: {
  href: string
  className?: string
  children: ReactNode
}) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cx('hover:underline', className)}>
      {children}
    </a>
  )
}
