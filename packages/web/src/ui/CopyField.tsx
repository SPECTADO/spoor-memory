import { Check, Copy } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { Button } from './Button'
import { cx } from './cx'
import { controlClass } from './Field'

/** Read-only value with a Copy button (invite links, token secrets, commands). */
export function CopyField({
  label,
  value,
  hint,
  className,
}: {
  label: string
  value: string
  hint?: string
  className?: string
}) {
  const id = useId()
  const ref = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      ref.current?.select()
      document.execCommand?.('copy')
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2_000)
  }
  return (
    <div className={cx('space-y-1', className)}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          ref={ref}
          id={id}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className={cx(controlClass, 'h-9 font-mono')}
        />
        <Button
          onClick={copy}
          icon={
            copied ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )
          }
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      )}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to the clipboard' : ''}
      </span>
    </div>
  )
}
