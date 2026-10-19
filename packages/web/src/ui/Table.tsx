/** Real tables (web-ui.md §9 accessibility baseline) with horizontal scroll on narrow screens. */
import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { cx } from './cx'

export function Table({
  caption,
  hideCaption = true,
  className,
  children,
}: {
  /** Accessible name of the table; visually hidden unless `hideCaption` is false. */
  caption: ReactNode
  hideCaption?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cx('overflow-x-auto rounded-md border border-border', className)}>
      <table className="w-full border-collapse text-sm">
        <caption className={cx('px-3 py-2 text-left text-sm font-medium', hideCaption && 'sr-only')}>
          {caption}
        </caption>
        {children}
      </table>
    </div>
  )
}

export const THead = ({ children }: { children: ReactNode }) => (
  <thead className="bg-surface text-left text-xs font-semibold tracking-wide text-muted uppercase">
    {children}
  </thead>
)

export const TBody = ({ children }: { children: ReactNode }) => (
  <tbody className="divide-y divide-border">{children}</tbody>
)

export function Tr({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cx('align-top', className)} {...rest} />
}

export function Th({ className, scope = 'col', ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope={scope} className={cx('px-3 py-2 font-semibold whitespace-nowrap', className)} {...rest} />
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cx('px-3 py-2', className)} {...rest} />
}
