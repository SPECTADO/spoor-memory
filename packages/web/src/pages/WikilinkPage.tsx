/**
 * `…/w/:ref` (web-ui.md §2): resolves wikilink text the way stored edges do (`GET …/resolve`), then replaces
 * itself with the item page. A miss shows "No item called …" with "Create doc" for editors, or, for a link from a
 * library page (`?from=library`), "Create library page" for holders of the library right: only a library page
 * can resolve a library page's dangling link (ADR-0014).
 */
import { Navigate, useParams, useSearchParams } from 'react-router'
import { isApiError } from '../api/client'
import { useResolve } from '../api/hooks'
import { useCan } from '../components/RequireRole'
import { projectPath, useProjectSlug } from '../lib/paths'
import { ButtonLink, EmptyState, ErrorState, PageHeader, SkeletonRows } from '../ui'
import { summaryPath } from './item/common'

export function WikilinkPage() {
  const slug = useProjectSlug()
  const ref = useParams().ref ?? ''
  const from = useSearchParams()[0].get('from') ?? undefined
  const resolved = useResolve(slug, ref, from)
  const fromLibrary = from === 'library'
  const editor = useCan(fromLibrary ? 'library' : 'editor')

  if (resolved.isPending) return <SkeletonRows rows={3} />
  if (resolved.data) return <Navigate to={summaryPath(resolved.data.item)} replace />
  if (!isApiError(resolved.error, 'not_found')) {
    return <ErrorState error={resolved.error} onRetry={() => resolved.refetch()} />
  }
  // a `shared:` target cannot be created from a project page
  const creatable = editor.allowed && !/^shared:/i.test(ref)
  return (
    <section>
      <PageHeader title="Wikilink" />
      <EmptyState
        title={
          <>
            No item called <span className="font-mono">{ref}</span>.
          </>
        }
        action={
          creatable ? (
            <ButtonLink
              variant="primary"
              to={projectPath(
                slug,
                `${fromLibrary ? 'library' : 'docs'}/new?title=${encodeURIComponent(ref)}`,
              )}
            >
              {fromLibrary ? 'Create library page' : 'Create doc'}
            </ButtonLink>
          ) : undefined
        }
      >
        The link points to nothing yet.
      </EmptyState>
    </section>
  )
}
