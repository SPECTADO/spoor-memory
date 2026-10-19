/** `/admin/projects` (instance admin): every project with its counts, and "New project". */
import { descriptionSchema, nameSchema, projectSlugSchema } from '@spoor/shared'
import { type FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { isApiError } from '../../api/client'
import { useCreateProject, useProjects } from '../../api/hooks'
import { projectPath } from '../../lib/paths'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  issuesByField,
  PageHeader,
  SkeletonRows,
  Table,
  TBody,
  Td,
  Textarea,
  THead,
  Th,
  Tr,
  useToast,
} from '../../ui'
import { suggestProjectSlug } from '../ProjectsPage'

export function ProjectsAdminPage() {
  const projects = useProjects()
  const [creating, setCreating] = useState(false)
  return (
    <section>
      <PageHeader
        title="Projects"
        description="Every project on this instance. Item counts exclude archived items."
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New project
          </Button>
        }
      />
      {projects.isPending ? (
        <SkeletonRows rows={4} />
      ) : projects.isError ? (
        <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
      ) : projects.data.items.length === 0 ? (
        <EmptyState title="No projects yet." />
      ) : (
        <Table caption="Projects">
          <THead>
            <tr>
              <Th>Project</Th>
              <Th className="text-right">Memories</Th>
              <Th className="text-right">Decisions</Th>
              <Th className="text-right">Docs</Th>
              <Th className="text-right">To review</Th>
              <Th>
                <span className="sr-only">Links</span>
              </Th>
            </tr>
          </THead>
          <TBody>
            {projects.data.items.map((p) => (
              <Tr key={p.slug}>
                <Td className="min-w-48">
                  <Link to={projectPath(p.slug)} className="font-medium text-accent underline">
                    {p.name}
                  </Link>
                  <div className="font-mono text-xs text-muted">{p.slug}</div>
                </Td>
                <Td className="text-right tabular-nums">{p.counts.memories}</Td>
                <Td className="text-right tabular-nums">{p.counts.decisions}</Td>
                <Td className="text-right tabular-nums">{p.counts.docs}</Td>
                <Td className="text-right tabular-nums">
                  {p.review_total > 0 ? <Badge tone="warning">{p.review_total}</Badge> : 0}
                </Td>
                <Td>
                  <Link to={projectPath(p.slug, 'settings')} className="text-accent underline">
                    Settings
                  </Link>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      )}
      <Dialog open={creating} onClose={() => setCreating(false)} title="New project">
        <CreateForm onClose={() => setCreating(false)} />
      </Dialog>
    </section>
  )
}

function CreateForm({ onClose }: { onClose: () => void }) {
  const create = useCreateProject()
  const navigate = useNavigate()
  const toast = useToast()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [touched, setTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const effective = touched ? slug : suggestProjectSlug(name)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!nameSchema.safeParse(name).success) errs.name = 'Enter a name (1 to 100 characters).'
    if (!projectSlugSchema.safeParse(effective).success)
      errs.slug =
        'Use lower-case letters, digits and inner dashes (1 to 40 characters); some words are reserved.'
    if (!descriptionSchema.safeParse(description).success) errs.description = 'At most 2,000 characters.'
    setErrors(errs)
    if (Object.keys(errs).length) return
    create.mutate(
      { slug: effective, name: name.trim(), description },
      {
        onSuccess: (p) => {
          toast.success(`Project ${p.name} created.`)
          onClose()
          navigate(projectPath(p.slug, 'settings'))
        },
        onError: (err) => {
          if (isApiError(err, 'slug_taken')) setErrors({ slug: 'This slug is taken.' })
          else if (isApiError(err, 'invalid_input')) setErrors(issuesByField(err.issues))
        },
      },
    )
  }
  const err = create.error
  const banner =
    err && !isApiError(err, 'slug_taken') && !(isApiError(err, 'invalid_input') && err.issues.length)
      ? err.message
      : null
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {banner && <Alert tone="danger">{banner}</Alert>}
      <Input
        label="Name"
        required
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={errors.name}
      />
      <Input
        label="Slug"
        required
        value={effective}
        onChange={(e) => {
          setTouched(true)
          setSlug(e.target.value.toLowerCase())
        }}
        hint="Used in URLs and by the CLI. It cannot be changed later."
        error={errors.slug}
        inputClassName="font-mono"
        spellCheck={false}
        autoComplete="off"
      />
      <Textarea
        label="Description"
        rows={3}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        error={errors.description}
      />
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          Create project
        </Button>
      </div>
    </form>
  )
}
