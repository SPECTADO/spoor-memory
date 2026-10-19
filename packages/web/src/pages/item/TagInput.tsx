/**
 * `TagInput` (web-ui.md §5.1): chips plus a text box. Enter or "," adds the typed tag (lower-cased), which is
 * checked against the shared tag pattern as you type; Backspace in an empty box removes the last chip; leaving
 * the box adds a valid pending tag so it is not lost on Save.
 */
import { ITEM_LIMITS } from '@spoor/shared'
import { X } from 'lucide-react'
import { type KeyboardEvent, useId, useState } from 'react'
import { controlClass, cx } from '../../ui'
import { normalizeTag, TAG_HINT } from './editorModel'

export function TagInput({
  tags,
  onChange,
  error,
  disabled,
}: {
  tags: string[]
  onChange: (tags: string[]) => void
  error?: string
  disabled?: boolean
}) {
  const id = useId()
  const [text, setText] = useState('')
  const pending = text.trim()
  const tag = pending ? normalizeTag(pending) : null
  const full = tags.length >= ITEM_LIMITS.tags
  const typingError = !pending
    ? null
    : tag === null
      ? `Not a valid tag. ${TAG_HINT}`
      : full && !tags.includes(tag)
        ? `At most ${ITEM_LIMITS.tags} tags.`
        : null
  const shownError = typingError ?? error

  const add = () => {
    if (!tag || typingError) return false
    if (!tags.includes(tag)) onChange([...tags, tag])
    setText('')
    return true
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      if (pending) {
        e.preventDefault()
        add()
      } else if (e.key === ',') e.preventDefault()
    } else if (e.key === 'Backspace' && text === '' && tags.length) {
      onChange(tags.slice(0, -1))
    }
  }

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        Tags
      </label>
      {tags.length > 0 && (
        <ul aria-label="Tags" className="flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <li
              key={t}
              className="inline-flex items-center gap-0.5 rounded bg-surface-2 py-0.5 pr-0.5 pl-1.5 text-xs"
            >
              <span>{t}</span>
              <button
                type="button"
                aria-label={`Remove tag ${t}`}
                title={`Remove tag ${t}`}
                disabled={disabled}
                onClick={() => onChange(tags.filter((x) => x !== t))}
                className="rounded p-0.5 text-muted hover:bg-surface hover:text-fg"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        id={id}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => {
          if (tag && !typingError) add()
        }}
        placeholder={tags.length ? 'Add another tag' : 'Type a tag and press Enter'}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={shownError ? true : undefined}
        aria-describedby={`${id}-hint`}
        className={cx(controlClass, 'h-9')}
      />
      <p id={`${id}-hint`} className={cx('text-xs', shownError ? 'text-danger' : 'text-muted')}>
        {shownError ?? 'Press Enter or "," to add a tag.'}
      </p>
    </div>
  )
}
