/**
 * Item view `…/i/:ref` (web-ui.md §4.2): header with handle, title and badges; banners (new-item warnings,
 * stale, archived, superseded, expiring, mirrored, push refused); rendered Markdown; the details panel;
 * links and backlinks; actions by role. Reading never bumps `last_used_at`.
 */
import { CheckCheck, Pencil, Pin, PinOff } from 'lucide-react'
import { useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { ApiError, isApiError } from '../../api/client'
import {
  revisionConflict,
  useDeleteItem,
  useItem,
  useItemAction,
  usePatchItem,
  useRestoreItem,
} from '../../api/hooks'
import type { ItemAction, ItemJson, ItemWarning } from '../../api/types'
import { useCan } from '../../components/RequireRole'
import { dateTime, fromNow, plural } from '../../lib/format'
import { isShared, itemPath, projectPath, useProjectSlug } from '../../lib/paths'
import {
  Alert,
  Button,
  ButtonLink,
  ConfirmDialog,
  ErrorState,
  errorText,
  MarkdownView,
  NotFound,
  Skeleton,
  useToast,
} from '../../ui'
import { handleText, ItemBadges, SPACE_LABEL } from './common'
import { PromoteRestoreDialog, SupersedeDialog } from './ItemDialogs'
import { ItemMeta, SupersededChain } from './ItemMeta'
import { LinksPanel } from './LinksPanel'

export function ItemPageImpl() {
  const slug = useProjectSlug()
  const { ref = '' } = useParams()
  const item = useItem(slug, ref)
  if (item.isPending) {
    return (
      <div className="space-y-4" role="status">
        <span className="sr-only">Loading item</span>
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (item.error instanceof ApiError && item.error.status === 404)
    return <NotFound backTo={projectPath(slug)} backLabel="Back to the project" />
  if (item.isError) return <ErrorState error={item.error} onRetry={() => item.refetch()} />
  return <ItemView slug={slug} item={item.data} refetch={() => item.refetch()} />
}

const isExpired = (item: ItemJson) =>
  item.type === 'observation' && !!item.expires_at && Date.parse(item.expires_at) <= Date.now()

function ItemView({ slug, item, refetch }: { slug: string; item: ItemJson; refetch: () => void }) {
  const location = useLocation()
  const canWrite = useCan('editor').allowed
  const isAdmin = useCan('admin').allowed
  // shared space: IA or shared editor (both pass the editor gate there); projects: project admin
  const canDelete = isShared(slug) ? canWrite : isAdmin
  const initialWarnings = ((location.state as { warnings?: ItemWarning[] } | null)?.warnings ?? []).filter(
    (w) => w.code === 'near_duplicate',
  )
  const [warnings, setWarnings] = useState(initialWarnings)

  return (
    <article>
      <header className="mb-4 space-y-2">
        <p className="text-sm text-muted">
          <Link to={projectPath(slug, item.space)} className="hover:underline">
            {SPACE_LABEL[item.space]}
          </Link>{' '}
          · <span className="font-mono">{handleText(item)}</span> · r{item.revision}
        </p>
        <h1 className="text-xl font-semibold break-words">{item.title}</h1>
        <ItemBadges item={item} />
      </header>

      <ItemActions slug={slug} item={item} canWrite={canWrite} canDelete={canDelete} refetch={refetch} />

      <div className="mt-4 space-y-2">
        {warnings.length > 0 && (
          <Alert tone="warning" title="A similar item exists">
            <ul>
              {warnings.map((w) => (
                <li key={`${w.handle}`}>
                  {w.handle ? (
                    <Link to={itemPath(slug, w.handle)} className="underline">
                      {w.handle}
                      {w.title ? ` ${w.title}` : ''}
                    </Link>
                  ) : (
                    'an existing item'
                  )}
                  {typeof w.cos === 'number' && <> (cos {w.cos.toFixed(2)})</>}
                </li>
              ))}
            </ul>
            <Button size="sm" className="mt-2" onClick={() => setWarnings([])}>
              Dismiss
            </Button>
          </Alert>
        )}
        <Banners slug={slug} item={item} canWrite={canWrite} />
      </div>

      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <section aria-label="Body" className="min-w-0">
            {item.body.trim() ? (
              <MarkdownView source={item.body} slug={slug} />
            ) : (
              <p className="text-sm text-muted">This item has no body.</p>
            )}
          </section>
          <LinksPanel slug={slug} item={item} canWrite={canWrite} />
        </div>
        <aside className="min-w-0">
          <ItemMeta slug={slug} item={item} />
        </aside>
      </div>
    </article>
  )
}

function Banners({ slug, item, canWrite }: { slug: string; item: ItemJson; canWrite: boolean }) {
  const action = useItemAction(slug)
  const toast = useToast()
  const out = []
  if (item.lifecycle === 'stale') {
    const days = Math.floor((Date.now() - Date.parse(item.last_verified_at)) / 86_400_000)
    out.push(
      <Alert key="stale" tone="warning" title={`Unverified for ${plural(days, 'day')}`}>
        Stale since {dateTime(item.stale_since)}. Verify it if it is still true.
        {canWrite && (
          <div className="mt-2">
            <Button
              size="sm"
              loading={action.isPending}
              onClick={() =>
                action.mutate(
                  { ref: item.handle, action: 'verify' },
                  {
                    onSuccess: () => toast.success(`Verified ${item.handle}`),
                    onError: (e) => toast.error(e),
                  },
                )
              }
            >
              Verify
            </Button>
          </div>
        )}
      </Alert>,
    )
  }
  if (item.lifecycle === 'archived') {
    out.push(
      <Alert key="archived" tone="danger" title={`Archived ${fromNow(item.archived_at)}`}>
        Reason: {item.archive_reason ?? 'unknown'}. Archived items stay out of search and the digest.
      </Alert>,
    )
  }
  if (item.superseded_by) {
    out.push(
      <Alert key="superseded" tone="warning" title="Superseded">
        Superseded by <SupersededChain slug={slug} handle={item.superseded_by} seen={[item.handle]} />.
      </Alert>,
    )
  }
  if (item.type === 'observation' && item.expires_at && item.lifecycle !== 'archived') {
    out.push(
      <Alert key="expires" tone="info">
        This observation {isExpired(item) ? 'expired' : 'expires'} {fromNow(item.expires_at)}. Promote it to a
        fact by editing its type to keep it.
      </Alert>,
    )
  }
  if (item.push_conflict_at) {
    out.push(
      <Alert key="push" tone="danger" title={`Push refused ${fromNow(item.push_conflict_at)}`}>
        The repo file <code className="font-mono">{item.source_path}</code> was pushed after this item was
        edited in Spoor, so the push was refused. To let the repo win, run{' '}
        <code className="font-mono">
          spoor {item.space === 'decisions' ? 'adr' : 'docs'} push --force {item.source_path}
        </code>
        ; or bring the file in line with Spoor and push.{' '}
        <Link to={itemPath(slug, item.handle, 'history')} className="underline">
          Compare in history
        </Link>
      </Alert>,
    )
  } else if (item.source_path) {
    out.push(
      <Alert key="mirror" tone="info">
        Mirrors <code className="font-mono">{item.source_path}</code>. Edits here stay in Spoor; the next push
        from the repo is refused until a human forces it.
      </Alert>,
    )
  }
  return <>{out}</>
}

function ItemActions({
  slug,
  item,
  canWrite,
  canDelete,
  refetch,
}: {
  slug: string
  item: ItemJson
  canWrite: boolean
  canDelete: boolean
  refetch: () => void
}) {
  const navigate = useNavigate()
  const toast = useToast()
  const action = useItemAction(slug)
  const restore = useRestoreItem(slug)
  const patch = usePatchItem(slug, item.handle)
  const del = useDeleteItem(slug)
  const [dialog, setDialog] = useState<null | 'supersede' | 'promote' | 'delete' | 'archive'>(null)
  const archived = item.lifecycle === 'archived'
  const busy = action.isPending || restore.isPending || patch.isPending

  const run = (a: ItemAction, done: string) =>
    action.mutate(
      { ref: item.handle, action: a },
      {
        onSuccess: () => {
          toast.success(done)
          if (dialog === 'archive') setDialog(null)
        },
        onError: (e) => toast.error(e),
      },
    )

  const doRestore = () => {
    if (isExpired(item)) {
      setDialog('promote')
      return
    }
    restore.mutate(
      { ref: item.handle },
      {
        onSuccess: () => toast.success(`Restored ${item.handle}`),
        onError: (e) => {
          if (isApiError(e, 'promote_required')) setDialog('promote')
          else toast.error(e)
        },
      },
    )
  }

  const accept = () =>
    patch.mutate(
      { revision: item.revision, status: 'accepted' },
      {
        onSuccess: (res) => toast.success(`${res.item.handle} accepted`, `Saved as r${res.item.revision}`),
        onError: (e) => {
          if (revisionConflict(e)) {
            toast.error('This decision changed meanwhile. It was reloaded; check it and accept again.')
            refetch()
          } else toast.error(e)
        },
      },
    )

  return (
    <div className="flex flex-wrap gap-2">
      {canWrite && (
        <>
          <ButtonLink to={itemPath(slug, item.handle, 'edit')} variant="primary" size="sm">
            <Pencil className="size-4" aria-hidden="true" />
            Edit
          </ButtonLink>
          {item.space === 'decisions' && item.status === 'proposed' && (
            <Button size="sm" onClick={accept} loading={patch.isPending}>
              Accept
            </Button>
          )}
          <Button
            size="sm"
            disabled={busy}
            icon={
              item.pinned ? (
                <PinOff className="size-4" aria-hidden="true" />
              ) : (
                <Pin className="size-4" aria-hidden="true" />
              )
            }
            onClick={() =>
              run(
                item.pinned ? 'unpin' : 'pin',
                item.pinned ? `Unpinned ${item.handle}` : `Pinned ${item.handle}`,
              )
            }
          >
            {item.pinned ? 'Unpin' : 'Pin'}
          </Button>
          {!archived && (
            <Button
              size="sm"
              disabled={busy}
              icon={<CheckCheck className="size-4" aria-hidden="true" />}
              onClick={() => run('verify', `Verified ${item.handle}`)}
            >
              Verify
            </Button>
          )}
          {archived ? (
            <Button size="sm" disabled={busy} onClick={doRestore}>
              Restore
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => setDialog('archive')}>
              Archive
            </Button>
          )}
          {item.space === 'memories' && !archived && item.status !== 'superseded' && (
            <Button size="sm" disabled={busy} onClick={() => setDialog('supersede')}>
              Supersede
            </Button>
          )}
        </>
      )}
      <ButtonLink to={itemPath(slug, item.handle, 'history')} size="sm" variant="ghost">
        History
      </ButtonLink>
      {canDelete && (
        <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDialog('delete')}>
          Delete
        </Button>
      )}

      <ConfirmDialog
        open={dialog === 'archive'}
        onClose={() => setDialog(null)}
        onConfirm={() => run('archive', `Archived ${item.handle}`)}
        title={`Archive ${item.handle}?`}
        confirmLabel="Archive"
        pending={action.isPending}
      >
        It leaves search and the digest. You can restore it later.
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        onConfirm={() =>
          del.mutate(
            { handle: item.handle },
            {
              onSuccess: () => {
                setDialog(null)
                toast.success(`Deleted ${item.handle}`)
                navigate(projectPath(slug, item.space), { replace: true })
              },
            },
          )
        }
        title={`Delete ${item.handle} permanently?`}
        confirmLabel="Delete"
        danger
        pending={del.isPending}
        typeToConfirm={item.handle}
        error={del.isError ? errorText(del.error).message : undefined}
      >
        The item, its revisions and its links are removed. The audit log keeps a record. This cannot be
        undone; archiving is usually enough.
      </ConfirmDialog>
      <SupersedeDialog
        open={dialog === 'supersede'}
        onClose={() => setDialog(null)}
        slug={slug}
        item={item}
      />
      <PromoteRestoreDialog
        open={dialog === 'promote'}
        onClose={() => setDialog(null)}
        slug={slug}
        item={item}
      />
    </div>
  )
}
