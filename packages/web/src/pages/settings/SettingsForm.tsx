/**
 * The project settings forms (web-ui.md §8): General, Cleanup, Digest and Duplicates, each with its own Save
 * that sends only the changed keys. Values are validated in the browser with the shared patch schema and the
 * server's `invalid_input` issues (`settings.cleanup.stale_days`) are mapped back to the same fields.
 */
import { descriptionSchema, nameSchema, type ProjectJson, projectSettingsPatch } from '@spoor/shared'
import { type FormEvent, type ReactNode, useState } from 'react'
import { isApiError } from '../../api/client'
import { usePatchProject } from '../../api/hooks'
import type { ProjectPatchRequest } from '../../api/types'
import { Alert, Button, Input, issuesByField, Textarea, useToast } from '../../ui'

type Group = 'cleanup' | 'digest' | 'dedupe'

interface NumberField {
  key: string
  label: string
  hint: string
  step?: string
  /** Allowed range, mirrored from the shared schema for the message (the schema still decides). */
  range: [number, number]
}

const GROUPS: {
  group: Group
  title: string
  note?: string
  fields: NumberField[]
}[] = [
  {
    group: 'cleanup',
    title: 'Cleanup',
    note: 'Applies at the next hourly run.',
    fields: [
      {
        key: 'stale_days',
        label: 'Stale after (days)',
        hint: 'Unverified memories turn stale. 1 to 3650.',
        range: [1, 3650],
      },
      {
        key: 'archive_days',
        label: 'Archive after (days)',
        hint: 'Stale and unused items are archived. 1 to 3650.',
        range: [1, 3650],
      },
      {
        key: 'observation_days',
        label: 'Observation lifetime (days)',
        hint: 'Observations expire after this. 1 to 365.',
        range: [1, 365],
      },
    ],
  },
  {
    group: 'digest',
    title: 'Digest',
    fields: [
      {
        key: 'default_budget',
        label: 'Default budget (tokens)',
        hint: 'Size of the session digest. 200 to 8000.',
        range: [200, 8000],
      },
      {
        key: 'decision_window_days',
        label: 'Decision window (days)',
        hint: 'Recent decisions included. 1 to 365.',
        range: [1, 365],
      },
    ],
  },
  {
    group: 'dedupe',
    title: 'Duplicates',
    fields: [
      {
        key: 'threshold',
        label: 'Duplicate threshold (cosine)',
        hint: 'A new item at least this similar to an existing one is flagged. 0.80 to 0.99.',
        step: '0.01',
        range: [0.8, 0.99],
      },
    ],
  },
]

export function SettingsForm({ project }: { project: ProjectJson }) {
  return (
    <div className="space-y-10">
      <GeneralForm project={project} />
      {GROUPS.map((g) => (
        <NumbersForm
          key={`${g.group}:${JSON.stringify(project.settings[g.group])}`}
          project={project}
          spec={g}
        />
      ))}
    </div>
  )
}

function FormSection({
  title,
  note,
  onSubmit,
  dirty,
  saving,
  error,
  children,
}: {
  title: string
  note?: string
  onSubmit: (e: FormEvent) => void
  dirty: boolean
  saving: boolean
  error: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-label={title}>
      <h2 className="text-base font-semibold">{title}</h2>
      {note && <p className="mt-0.5 text-sm text-muted">{note}</p>}
      <form onSubmit={onSubmit} noValidate className="mt-4 max-w-md space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        {children}
        <Button type="submit" variant="primary" disabled={!dirty} loading={saving}>
          Save {title.toLowerCase()}
        </Button>
      </form>
    </section>
  )
}

/** Server issues of a settings patch mapped to `group.key`; anything else becomes the banner text. */
function serverErrors(err: unknown): { fields: Record<string, string>; banner: string | null } {
  if (!err) return { fields: {}, banner: null }
  if (isApiError(err, 'invalid_input') && err.issues.length) {
    const stripped = err.issues.map((i) => ({ path: i.path.replace(/^settings\./, ''), message: i.message }))
    return { fields: issuesByField(stripped), banner: null }
  }
  return { fields: {}, banner: err instanceof Error ? err.message : 'Saving failed.' }
}

function GeneralForm({ project }: { project: ProjectJson }) {
  const patch = usePatchProject(project.slug)
  const toast = useToast()
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const dirty = name !== project.name || description !== project.description

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!nameSchema.safeParse(name).success) errs.name = 'Enter a name (1 to 100 characters).'
    if (!descriptionSchema.safeParse(description).success) errs.description = 'At most 2,000 characters.'
    setErrors(errs)
    if (Object.keys(errs).length) return
    const body: ProjectPatchRequest = {}
    if (name !== project.name) body.name = name.trim()
    if (description !== project.description) body.description = description
    patch.mutate(body, { onSuccess: () => toast.success('General settings saved.') })
  }
  const { fields, banner } = serverErrors(patch.error)
  return (
    <FormSection title="General" onSubmit={submit} dirty={dirty} saving={patch.isPending} error={banner}>
      <Input
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={errors.name ?? fields.name}
      />
      <Input
        label="Slug"
        value={project.slug}
        readOnly
        hint="The slug cannot be changed."
        inputClassName="font-mono"
      />
      <Textarea
        label="Description"
        rows={3}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        error={errors.description ?? fields.description}
      />
    </FormSection>
  )
}

function NumbersForm({ project, spec }: { project: ProjectJson; spec: (typeof GROUPS)[number] }) {
  const patch = usePatchProject(project.slug)
  const toast = useToast()
  const current = project.settings[spec.group] as Record<string, number>
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(spec.fields.map((f) => [f.key, String(current[f.key])])),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const changed = spec.fields.filter((f) => values[f.key] !== String(current[f.key]))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const group: Record<string, number> = {}
    const errs: Record<string, string> = {}
    for (const f of changed) {
      const raw = values[f.key] ?? ''
      const n = raw.trim() === '' ? Number.NaN : Number(raw)
      if (Number.isNaN(n)) errs[`${spec.group}.${f.key}`] = 'Enter a number.'
      else group[f.key] = n
    }
    if (Object.keys(errs).length === 0) {
      const parsed = projectSettingsPatch.safeParse({ [spec.group]: group })
      if (!parsed.success) {
        for (const i of parsed.error.issues) {
          const path = i.path.join('.')
          const field = spec.fields.find((f) => `${spec.group}.${f.key}` === path)
          if (!(path in errs))
            errs[path] = field ? `Enter a value from ${field.range[0]} to ${field.range[1]}.` : i.message
        }
      }
    }
    setErrors(errs)
    if (Object.keys(errs).length) return
    patch.mutate(
      { settings: { [spec.group]: group } },
      { onSuccess: () => toast.success(`${spec.title} settings saved.`, spec.note) },
    )
  }

  const { fields, banner } = serverErrors(patch.error)
  return (
    <FormSection
      title={spec.title}
      note={spec.note}
      onSubmit={submit}
      dirty={changed.length > 0}
      saving={patch.isPending}
      error={banner}
    >
      {spec.fields.map((f) => (
        <Input
          key={f.key}
          label={f.label}
          type="number"
          step={f.step ?? '1'}
          inputMode="decimal"
          value={values[f.key]}
          onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          hint={f.hint}
          error={errors[`${spec.group}.${f.key}`] ?? fields[`${spec.group}.${f.key}`]}
        />
      ))}
    </FormSection>
  )
}
