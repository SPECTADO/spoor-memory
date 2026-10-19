/**
 * `/projects`: the projects the user can see (all of them for an instance admin) with counts, review
 * badge and role, the "Shared knowledge" card, and "New project" for instance admins.
 */
import { descriptionSchema, nameSchema, projectSlugSchema, slugify } from '@spoor/shared'
import { Globe, Plus } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { isApiError } from '../api/client'
import { useCreateProject, useMe, useProjects } from '../api/hooks'
import type { ProjectListItem } from '../api/types'
import { projectPath, SHARED_SLUG } from '../lib/paths'
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
  Skeleton,
  Textarea,
  useToast,
} from '../ui'

export function ProjectsPage() {
  const me = useMe()
  const projects = useProjects()
  const [creating, setCreating] = useState(false)
  const isAdmin = me.data?.user.is_admin === true

  return (
    <section>
      <PageHeader
        title="Projects"
        actions={
          isAdmin && (
            <Button
              variant="primary"
              icon={<Plus className="size-4" aria-hidden="true" />}
              onClick={() => setCreating(true)}
            >
              New project
            </Button>
          )
        }
      />
      {projects.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" role="status">
          <span className="sr-only">Loading projects</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : projects.isError ? (
        <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <li>
            <SharedCard />
          </li>
          {projects.data.items.map((p) => (
            <li key={p.slug}>
              <ProjectCard project={p} />
            </li>
          ))}
          {projects.data.items.length === 0 && (
            <li className="sm:col-span-2">
              <EmptyState
                title="No projects yet"
                action={
                  isAdmin && (
                    <Button variant="primary" onClick={() => setCreating(true)}>
                      New project
                    </Button>
                  )
                }
              >
                {isAdmin
                  ? 'Create the first project, then invite people to it.'
                  : 'You are not a member of any project yet. Ask an admin to add you.'}
              </EmptyState>
            </li>
          )}
        </ul>
      )}
      <CreateProjectDialog open={creating} onClose={() => setCreating(false)} />
    </section>
  )
}

const cardClass = 'flex h-full flex-col rounded-lg border border-border bg-bg p-4 hover:border-border-strong'

function SharedCard() {
  return (
    <article className={`${cardClass} bg-surface`}>
      <h2 className="flex items-center gap-2 font-semibold">
        <Globe className="size-4 text-muted" aria-hidden="true" />
        <Link to={projectPath(SHARED_SLUG)} className="hover:underline">
          Shared knowledge
        </Link>
      </h2>
      <p className="mt-1 text-sm text-muted">
        Org-wide memories, decisions and docs. Every project can read them; humans edit them here.
      </p>
    </article>
  )
}

function ProjectCard({ project: p }: { project: ProjectListItem }) {
  return (
    <article className={cardClass}>
      <div className="flex items-start justify-between gap-2">
        <h2 className="min-w-0 font-semibold">
          <Link to={projectPath(p.slug)} className="break-words hover:underline">
            {p.name}
          </Link>
        </h2>
        <Badge>{p.role}</Badge>
      </div>
      <p className="font-mono text-xs text-muted">{p.slug}</p>
      {p.description && <p className="mt-2 line-clamp-2 text-sm text-muted">{p.description}</p>}
      <div className="mt-auto flex flex-wrap items-end justify-between gap-2 pt-4">
        <dl className="flex gap-4 text-sm">
          {(['memories', 'decisions', 'docs'] as const).map((space) => (
            <div key={space}>
              <dt className="text-xs text-muted capitalize">{space}</dt>
              <dd className="font-medium tabular-nums">{p.counts[space]}</dd>
            </div>
          ))}
        </dl>
        {p.review_total > 0 ? (
          <Link to={projectPath(p.slug, 'review')}>
            <Badge tone="warning">{p.review_total} to review</Badge>
          </Link>
        ) : (
          <span className="text-xs text-muted">Nothing to review</span>
        )}
      </div>
    </article>
  )
}

/** Project slug from a name: the item slugifier, cut to the 40 characters a project slug allows. */
export function suggestProjectSlug(name: string): string {
  return slugify(name).slice(0, 40).replace(/-+$/, '')
}

function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="New project">
      <CreateProjectForm onClose={onClose} />
    </Dialog>
  )
}

function CreateProjectForm({ onClose }: { onClose: () => void }) {
  const create = useCreateProject()
  const navigate = useNavigate()
  const toast = useToast()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const effectiveSlug = slugTouched ? slug : suggestProjectSlug(name)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const errs: Record<string, string> = {}
    if (!nameSchema.safeParse(name).success) errs.name = 'Enter a name (1 to 100 characters).'
    if (!projectSlugSchema.safeParse(effectiveSlug).success) {
      errs.slug =
        'Use lower-case letters, digits and inner dashes (1 to 40 characters); some words are reserved.'
    }
    if (!descriptionSchema.safeParse(description).success) errs.description = 'At most 2,000 characters.'
    setErrors(errs)
    if (Object.keys(errs).length) return
    create.mutate(
      { slug: effectiveSlug, name: name.trim(), description },
      {
        onSuccess: (p) => {
          toast.success(`Project ${p.name} created.`)
          onClose()
          navigate(projectPath(p.slug))
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
        value={effectiveSlug}
        onChange={(e) => {
          setSlugTouched(true)
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
      <p className="text-xs text-muted">
        You manage the project as an instance admin; add members from its Members page afterwards.
      </p>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          Create project
        </Button>
      </div>
    </form>
  )
}
