/**
 * The editor (web-ui.md §5), one component for `…/:space/new` and `…/i/:ref/edit`: frontmatter fields above,
 * CodeMirror Markdown with a live preview (split pane from 1024 px, Write/Preview toggle below), revision-
 * aware save (409 `revision_conflict` opens `ConflictDialog`), unsaved-changes guard, and a per-viewer draft.
 * History's "Restore this version" arrives here as navigation state (`restore`); a dangling wikilink's
 * "create" arrives as `?title=`.
 */
import { codePointLength, ITEM_LIMITS } from '@spoor/shared'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import { useBlocker, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { ApiError, isApiError } from '../../api/client'
import { revisionConflict, useCreateItem, useItem, usePatchItem } from '../../api/hooks'
import type { ItemJson, RevisionConflictDetails, Space } from '../../api/types'
import { useCan } from '../../components/RequireRole'
import { dateTime } from '../../lib/format'
import { itemPath, projectPath, useProjectSlug } from '../../lib/paths'
import {
  Alert,
  Button,
  cx,
  Dialog,
  ErrorState,
  errorText,
  Forbidden,
  MarkdownEditor,
  MarkdownView,
  NotFound,
  PageHeader,
  SkeletonRows,
  useToast,
} from '../../ui'
import { ConflictDialog } from './ConflictDialog'
import { isSpace, SPACE_LABEL, useDebounced } from './common'
import { clearDraft, type Draft, draftKey, readDraft, writeDraft } from './draft'
import {
  createBody,
  type EditorValues,
  emptyValues,
  type FieldErrors,
  type FieldName,
  fieldOfIssue,
  hasErrors,
  isChanged,
  patchBody,
  validate,
  valuesFromItem,
} from './editorModel'
import { FrontmatterFields } from './FrontmatterFields'

/** Navigation state the history page sends with "Restore this version". */
export interface RestoreState {
  revision: number
  title: string
  body: string
  tags: string[]
  anchors: string[]
}

export function EditorPageImpl({ mode }: { mode: 'create' | 'edit' }) {
  const slug = useProjectSlug()
  const params = useParams()
  const canEditor = useCan('editor')
  const canLibrary = useCan('library')
  const item = useItem(slug, mode === 'edit' ? params.ref : undefined)
  const back = <NotFound backTo={projectPath(slug)} backLabel="Back to the project" />

  if (mode === 'create' && !isSpace(params.space)) return back
  if (canEditor.pending || canLibrary.pending) return <SkeletonRows rows={6} />
  if (mode === 'create') {
    const space = params.space as Space
    if (!(space === 'library' ? canLibrary : canEditor).allowed) return <Forbidden />
    return <ItemEditor key={`new:${space}`} slug={slug} space={space} />
  }
  if (item.isPending) return <SkeletonRows rows={6} />
  if (item.error instanceof ApiError && item.error.status === 404) return back
  if (item.isError) return <ErrorState error={item.error} onRetry={() => item.refetch()} />
  if (!(item.data.space === 'library' ? canLibrary : canEditor).allowed) return <Forbidden />
  return <ItemEditor key={item.data.id} slug={slug} space={item.data.space} item={item.data} />
}

interface Base {
  /** null in create mode */
  revision: number | null
  values: EditorValues
}

function ItemEditor({ slug, space, item }: { slug: string; space: Space; item?: ItemJson }) {
  const mode = item ? 'edit' : 'create'
  const navigate = useNavigate()
  const location = useLocation()
  const [search] = useSearchParams()
  const toast = useToast()
  const restore = item ? (location.state as { restore?: RestoreState } | null)?.restore : undefined
  const key = draftKey(slug, item ? { id: item.id } : { space })

  const [base, setBase] = useState<Base>(() => ({
    revision: item?.revision ?? null,
    values: item
      ? valuesFromItem(item)
      : emptyValues({ title: (search.get('title') ?? '').replace(/[\r\n]+/g, ' ').slice(0, 200) }),
  }))
  const [values, setValues] = useState<EditorValues>(() =>
    restore
      ? {
          ...base.values,
          title: restore.title,
          body: restore.body,
          tags: restore.tags,
          anchors: restore.anchors.join('\n'),
        }
      : base.values,
  )
  const [offer, setOffer] = useState<Draft | null>(() => {
    if (restore) return null
    const d = readDraft(key)
    return d && isChanged(d.values, base.values) ? d : null
  })
  const [touched, setTouched] = useState<ReadonlySet<FieldName>>(new Set())
  const [attempted, setAttempted] = useState(false)
  const [serverErrors, setServerErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<unknown>(null)
  const [conflict, setConflict] = useState<RevisionConflictDetails | null>(null)
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  const done = useRef(false)

  const create = useCreateItem(slug, space)
  const patch = usePatchItem(slug, item?.handle ?? '')
  const saving = create.isPending || patch.isPending

  const clientErrors = validate(values, space, mode)
  const shownErrors: FieldErrors = { ...serverErrors }
  for (const [k, msg] of Object.entries(clientErrors) as [FieldName, string][]) {
    if (attempted || touched.has(k)) shownErrors[k] = msg
  }
  const dirty = isChanged(values, base.values)
  const canSave = !hasErrors(clientErrors) && (mode === 'create' || dirty) && !saving

  const onChange = (p: Partial<EditorValues>) => {
    setValues((v) => ({ ...v, ...p }))
    const keys = Object.keys(p) as FieldName[]
    setTouched((t) => new Set([...t, ...keys]))
    setServerErrors((e) => {
      const next = { ...e }
      for (const k of keys) delete next[k]
      return next
    })
  }

  // keep an unsent draft in this browser (not while a stored draft is still being offered)
  useEffect(() => {
    if (offer || done.current) return
    const t = setTimeout(() => {
      if (done.current) return
      if (dirty) writeDraft(key, values, base.revision)
      else clearDraft(key)
    }, 400)
    return () => clearTimeout(t)
  }, [values, dirty, offer, key, base.revision])

  // closing the tab with unsaved changes asks first (the draft survives anyway)
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !done.current && currentLocation.pathname !== nextLocation.pathname,
  )

  function handleError(e: unknown) {
    const fe: FieldErrors = {}
    let summary: unknown = e
    if (isApiError(e, 'invalid_input') && e.issues.length) {
      const unmapped = []
      for (const i of e.issues) {
        const f = fieldOfIssue(i.path)
        if (f && !fe[f]) fe[f] = i.message
        else if (!f) unmapped.push(i)
      }
      if (unmapped.length === 0) summary = 'Some fields need attention.'
    } else if (isApiError(e, 'slug_taken')) {
      fe.slug = e.message
      summary = null
    } else if (isApiError(e, 'already_exists') && space === 'decisions') {
      fe.adr_number = e.message
      summary = null
    } else if (isApiError(e, 'too_large')) {
      fe.body = e.message
      summary = null
    }
    setServerErrors(fe)
    setFormError(summary)
  }

  const finish = (to: string, state?: unknown) => {
    done.current = true
    clearDraft(key)
    navigate(to, state === undefined ? undefined : { state })
  }

  const sendPatch = (revision: number) => {
    if (!item) return
    patch.mutate(patchBody(values, base.values, revision, space), {
      onSuccess: (res) => {
        setConflict(null)
        const mirrored = res.warnings.some((w) => w.code === 'mirrored_item')
        toast.success(
          `Saved as r${res.item.revision}`,
          mirrored ? 'Saved in Spoor only. The repo file is unchanged.' : undefined,
        )
        finish(itemPath(slug, res.item.handle))
      },
      onError: (e) => {
        const c = revisionConflict(e)
        if (c) {
          setConflict(c)
        } else {
          setConflict(null)
          handleError(e)
        }
      },
    })
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setAttempted(true)
    if (!canSave) return
    setFormError(null)
    if (mode === 'create') {
      create.mutate(createBody(values, space), {
        onSuccess: (res) => {
          toast.success(`Created ${res.item.handle}`)
          finish(itemPath(slug, res.item.handle), { warnings: res.warnings })
        },
        onError: handleError,
      })
    } else if (base.revision !== null) {
      sendPatch(base.revision)
    }
  }

  const discardMine = () => {
    if (!conflict) return
    const cur = valuesFromItem(conflict.current)
    setBase({ revision: conflict.current.revision, values: cur })
    setValues(cur)
    setTouched(new Set())
    setServerErrors({})
    setFormError(null)
    clearDraft(key)
    setConflict(null)
    toast.success(`Loaded r${conflict.current.revision}`)
  }

  const cancelTo = item ? itemPath(slug, item.handle) : projectPath(slug, space)
  const preview = useDebounced(values.body, 200)
  const count = codePointLength(values.body)
  const writeId = useId()
  const previewId = useId()

  return (
    <section>
      <PageHeader
        title={item ? `Edit ${item.handle}` : `New ${SPACE_LABEL[space]}`}
        description={item ? item.title : undefined}
      />

      <div className="mb-4 space-y-2">
        {offer && (
          <Alert tone="info" title={`Restore unsaved draft from ${dateTime(offer.saved_at)}?`}>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setValues(offer.values)
                  if (item && offer.revision !== null && offer.revision !== base.revision)
                    setBase((b) => ({ ...b, revision: offer.revision }))
                  setOffer(null)
                }}
              >
                Restore draft
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  clearDraft(key)
                  setOffer(null)
                }}
              >
                Discard draft
              </Button>
            </div>
          </Alert>
        )}
        {restore && item && (
          <Alert tone="info">
            Loaded r{restore.revision} into the form. Saving creates a new revision on top of r{base.revision}
            .
          </Alert>
        )}
        {item?.source_path && (
          <Alert tone="warning">
            This item mirrors <code className="font-mono">{item.source_path}</code>. Edits here stay in Spoor;
            the next push from the repo is refused until a human forces it.
          </Alert>
        )}
        {formError != null && (
          <Alert
            tone="danger"
            title={typeof formError === 'string' ? formError : errorText(formError).message}
          >
            {typeof formError !== 'string' && errorText(formError).detail}
          </Alert>
        )}
      </div>

      <form onSubmit={submit} noValidate className="space-y-6">
        <FrontmatterFields
          space={space}
          mode={mode}
          values={values}
          errors={shownErrors}
          onChange={onChange}
          fixed={item ? { slug: item.slug, adr_number: item.adr_number, extra: item.extra } : undefined}
        />

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Body</h2>
            {/* biome-ignore lint/a11y/useSemanticElements: a toggle pair, not a form group */}
            <div role="group" aria-label="Body view" className="flex gap-1 lg:hidden">
              <Button
                size="sm"
                variant={tab === 'write' ? 'primary' : 'secondary'}
                aria-pressed={tab === 'write'}
                aria-controls={writeId}
                onClick={() => setTab('write')}
              >
                Write
              </Button>
              <Button
                size="sm"
                variant={tab === 'preview' ? 'primary' : 'secondary'}
                aria-pressed={tab === 'preview'}
                aria-controls={previewId}
                onClick={() => setTab('preview')}
              >
                Preview
              </Button>
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div id={writeId} className={cx(tab === 'write' ? 'block' : 'hidden', 'min-w-0 lg:block')}>
              <MarkdownEditor
                value={values.body}
                onChange={(body) => onChange({ body })}
                label="Editor"
                minHeight="20rem"
              />
              {shownErrors.body && <p className="mt-1 text-xs text-danger">{shownErrors.body}</p>}
            </div>
            <section
              id={previewId}
              aria-label="Preview"
              className={cx(
                tab === 'preview' ? 'block' : 'hidden',
                'min-h-[20rem] min-w-0 rounded-md border border-border bg-surface px-4 py-3 lg:block',
              )}
            >
              {preview.trim() ? (
                <MarkdownView
                  source={preview}
                  slug={slug}
                  from={space === 'library' ? 'library' : undefined}
                />
              ) : (
                <p className="text-sm text-muted">Nothing to preview yet.</p>
              )}
            </section>
          </div>
        </div>

        <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-bg px-4 py-3 sm:-mx-6 sm:px-6">
          <p className="text-xs text-muted">
            <span className={cx(count > ITEM_LIMITS.body && 'text-danger')}>
              {count.toLocaleString('en')} / {ITEM_LIMITS.body.toLocaleString('en')} characters
            </span>
            {base.revision !== null && <> · editing r{base.revision}</>}
            {dirty && <> · unsaved changes</>}
          </p>
          <div className="flex gap-2">
            <Button onClick={() => navigate(cancelTo)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!canSave} loading={saving}>
              Save
            </Button>
          </div>
        </div>
      </form>

      <ConflictDialog
        open={conflict !== null}
        current={conflict?.current ?? null}
        baseRevision={base.revision ?? 0}
        mine={{ title: values.title, body: values.body }}
        pending={patch.isPending}
        onKeepEditing={() => setConflict(null)}
        onOverwrite={() => conflict && sendPatch(conflict.current_revision)}
        onDiscard={discardMine}
      />

      <Dialog
        open={blocker.state === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="Leave without saving?"
        size="sm"
        footer={
          <>
            <Button onClick={() => blocker.reset?.()} autoFocus>
              Stay
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                done.current = true
                clearDraft(key)
                blocker.proceed?.()
              }}
            >
              Discard changes
            </Button>
            <Button
              onClick={() => {
                done.current = true
                writeDraft(key, values, base.revision)
                blocker.proceed?.()
              }}
            >
              Keep draft and leave
            </Button>
          </>
        }
      >
        <p className="text-sm">
          Your changes are not saved. A kept draft is offered the next time you open this editor in this
          browser.
        </p>
      </Dialog>
    </section>
  )
}
