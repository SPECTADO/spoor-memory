/**
 * The frontmatter part of the editor (web-ui.md §5.1): title; memories type and confidence; decisions status,
 * date and ADR number; tags, anchors; slug (create only, read-only afterwards); extra keys read-only.
 * `pinned`, verification and lifecycle are item actions, not fields.
 */
import type { Space } from '../../api/types'
import { Checkbox, Input, Select, Textarea } from '../../ui'
import {
  ADR_STATUSES,
  CONFIDENCES,
  defaultSlug,
  type EditorValues,
  type FieldErrors,
  MEMORY_TYPES,
} from './editorModel'
import { TagInput } from './TagInput'

const opts = (xs: readonly string[]) => xs.map((x) => ({ value: x, label: x }))

export interface FrontmatterFieldsProps {
  space: Space
  mode: 'create' | 'edit'
  values: EditorValues
  errors: FieldErrors
  onChange: (patch: Partial<EditorValues>) => void
  /** Edit mode: the immutable slug and ADR number, and the unknown frontmatter keys. */
  fixed?: { slug: string; adr_number: number | null; extra: Record<string, unknown> }
  disabled?: boolean
}

export function FrontmatterFields({
  space,
  mode,
  values: v,
  errors,
  onChange,
  fixed,
  disabled,
}: FrontmatterFieldsProps) {
  const extraKeys = fixed ? Object.keys(fixed.extra) : []
  return (
    <fieldset className="space-y-4" disabled={disabled}>
      <legend className="sr-only">Metadata</legend>
      <Input
        label="Title"
        required
        value={v.title}
        maxLength={400}
        onChange={(e) => onChange({ title: e.target.value.replace(/[\r\n]+/g, ' ') })}
        error={errors.title}
        autoFocus={mode === 'create'}
      />

      {space === 'memories' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Type"
            value={v.type}
            options={opts(MEMORY_TYPES)}
            onChange={(e) => onChange({ type: e.target.value as EditorValues['type'] })}
            error={errors.type}
            hint={
              v.type === 'observation'
                ? 'Observations expire after the project’s observation days.'
                : undefined
            }
          />
          <Select
            label="Confidence"
            value={v.confidence}
            options={opts(CONFIDENCES)}
            onChange={(e) => onChange({ confidence: e.target.value as EditorValues['confidence'] })}
            error={errors.confidence}
          />
        </div>
      )}

      {space === 'decisions' && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Select
            label="Status"
            value={v.status}
            options={opts(ADR_STATUSES)}
            onChange={(e) => onChange({ status: e.target.value as EditorValues['status'] })}
            error={errors.status}
          />
          <Input
            label="Date"
            type="date"
            value={v.decided_on}
            onChange={(e) => onChange({ decided_on: e.target.value })}
            error={errors.decided_on}
            hint="When it was decided."
          />
          {mode === 'create' ? (
            <Input
              label="ADR number"
              inputMode="numeric"
              value={v.adr_number}
              onChange={(e) => onChange({ adr_number: e.target.value.replace(/\D+/g, '') })}
              error={errors.adr_number}
              hint="Optional; the next free number by default."
            />
          ) : (
            <Input label="ADR number" readOnly value={fixed?.adr_number ? String(fixed.adr_number) : '—'} />
          )}
        </div>
      )}

      <TagInput
        tags={v.tags}
        onChange={(tags) => onChange({ tags })}
        error={errors.tags}
        disabled={disabled}
      />

      <Textarea
        label="Anchors"
        rows={3}
        value={v.anchors}
        onChange={(e) => onChange({ anchors: e.target.value })}
        error={errors.anchors}
        hint="Repo paths, directories or globs this applies to, one per line (src/auth/, **/*.sql)."
        inputClassName="font-mono"
        spellCheck={false}
      />

      {mode === 'create' ? (
        <Input
          label="Slug"
          value={v.slug}
          onChange={(e) => onChange({ slug: e.target.value })}
          error={errors.slug}
          placeholder={defaultSlug(v.title) || undefined}
          hint={`Defaults to ${defaultSlug(v.title) || 'the title'}. It cannot be changed later.`}
          inputClassName="font-mono"
          spellCheck={false}
          autoComplete="off"
        />
      ) : (
        <Input
          label="Slug"
          readOnly
          value={fixed?.slug ?? v.slug}
          inputClassName="font-mono"
          hint="Fixed after create."
        />
      )}

      {mode === 'create' && space !== 'decisions' && (
        <Checkbox
          label="Skip the duplicate check"
          hint="By default a very similar existing item is reported after saving."
          checked={v.allow_duplicate}
          onChange={(e) => onChange({ allow_duplicate: e.target.checked })}
        />
      )}

      {extraKeys.length > 0 && fixed && (
        <details className="rounded-md border border-border px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium">Extra metadata ({extraKeys.length})</summary>
          <p className="mt-1 text-xs text-muted">Other frontmatter keys, kept unchanged on save.</p>
          <dl className="mt-2 space-y-1">
            {extraKeys.map((k) => (
              <div key={k} className="flex flex-wrap gap-2">
                <dt className="font-mono text-xs text-muted">{k}</dt>
                <dd className="font-mono text-xs break-all">{JSON.stringify(fixed.extra[k])}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </fieldset>
  )
}
