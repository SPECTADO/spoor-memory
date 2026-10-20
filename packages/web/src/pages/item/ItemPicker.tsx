/**
 * Target picker for "Add relation" and "Supersede" (web-ui.md §4.2): a title filter over one space's list
 * (`q_title`), optionally over the shared space (`S:` targets), as a radio group. A handle typed into the
 * filter (`m42`, `ADR-0007`, `S:d3`) can be used directly.
 */
import { HANDLE_KIND_SPACE, parseHandle } from '@spoor/shared'
import { useId, useState } from 'react'
import { flattenPages, useItems } from '../../api/hooks'
import type { ItemSummary, Space } from '../../api/types'
import { SHARED_SLUG } from '../../lib/paths'
import { Checkbox, Input, Select, Skeleton } from '../../ui'
import { handleText, SPACE_TITLE, useDebounced } from './common'

export interface PickedTarget {
  /** What to send as `to` / `new_id`: a handle, `S:`-prefixed for a shared item. */
  ref: string
  label: string
  /** Space of the target when known (a picked row, or a typed handle). */
  space?: Space
}

export function ItemPicker({
  slug,
  spaces,
  allowShared,
  excludeId,
  value,
  onChange,
  legend = 'Target',
}: {
  slug: string
  spaces: readonly Space[]
  allowShared: boolean
  excludeId?: string
  value: PickedTarget | null
  onChange: (t: PickedTarget | null) => void
  legend?: string
}) {
  const name = useId()
  const [space, setSpace] = useState<Space>(spaces[0] ?? 'memories')
  const [shared, setShared] = useState(false)
  const [q, setQ] = useState('')
  const term = useDebounced(q.trim(), 250)
  const handle = parseHandle(q.trim())
  const listSlug = shared ? SHARED_SLUG : slug
  const list = useItems(listSlug, space, term && !handle ? { q_title: term, limit: 20 } : { limit: 20 })
  const rows = flattenPages(list.data).filter((r) => r.id !== excludeId)

  const refOf = (r: ItemSummary) => (shared ? `S:${r.handle.replace(/^S:/, '')}` : r.handle)

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {spaces.length > 1 && (
          <Select
            label="Space"
            value={space}
            options={spaces.map((s) => ({ value: s, label: SPACE_TITLE[s] }))}
            onChange={(e) => {
              setSpace(e.target.value as Space)
              onChange(null)
            }}
          />
        )}
        <Input
          label="Find by title or type a handle"
          type="search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            const h = parseHandle(e.target.value.trim())
            onChange(
              h
                ? {
                    ref: e.target.value.trim(),
                    label: e.target.value.trim(),
                    space: HANDLE_KIND_SPACE[h.kind],
                  }
                : null,
            )
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {allowShared && (
        <Checkbox
          label="Shared knowledge (S:)"
          checked={shared}
          onChange={(e) => {
            setShared(e.target.checked)
            onChange(null)
          }}
        />
      )}
      {handle ? (
        <p className="text-sm text-muted">
          Uses <code className="font-mono">{q.trim()}</code> as typed.
        </p>
      ) : list.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">No matching items.</p>
      ) : (
        <ul className="max-h-60 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {rows.map((r) => {
            const ref = refOf(r)
            const id = `${name}-${r.id}`
            return (
              <li key={r.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                <input
                  id={id}
                  type="radio"
                  name={name}
                  className="mt-1 accent-[var(--c-accent)]"
                  checked={value?.ref === ref}
                  onChange={() => onChange({ ref, label: `${ref} ${r.title}`, space: r.space })}
                />
                <label htmlFor={id} className="min-w-0 flex-1">
                  <span className="font-mono text-xs">{shared ? `S:${handleText(r)}` : handleText(r)}</span>{' '}
                  {r.title}
                </label>
              </li>
            )
          })}
        </ul>
      )}
    </fieldset>
  )
}
