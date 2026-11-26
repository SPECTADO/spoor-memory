import { Link, Outlet } from 'react-router'
import { ApiError } from '../api/client'
import { useMe, useProject } from '../api/hooks'
import { dateTime } from '../lib/format'
import { useProjectSlug } from '../lib/paths'
import { Alert, ErrorState, NotFound, SkeletonRows } from '../ui'

/**
 * Element of `/projects/:slug` and `/shared`: loads `GET /projects/:slug` once for every page below
 * (effective role, settings). A project the user cannot see is 404 from the API and renders Not found.
 */
export function ProjectScope() {
  const slug = useProjectSlug()
  const project = useProject(slug)
  if (project.isPending) return <SkeletonRows rows={4} />
  if (project.error instanceof ApiError && project.error.status === 404) return <NotFound />
  if (project.isError && !project.data)
    return <ErrorState error={project.error} onRetry={() => project.refetch()} />
  const restored = project.data?.restored_from
  return (
    <>
      {restored && <RestoredCopyBanner slug={slug} from={restored} />}
      <Outlet />
    </>
  )
}

/** A project made by "Restore as copy" from a backup: a temporary copy to look at (ADR-0038). */
function RestoredCopyBanner({
  slug,
  from,
}: {
  slug: string
  from: { backup_id: string; source_slug: string; restored_at: string }
}) {
  const me = useMe()
  return (
    <Alert tone="warning" title="Restored copy, delete when done" className="mb-4">
      <p>
        A copy of <span className="font-mono">{from.source_slug}</span> from backup {from.backup_id}, restored{' '}
        {dateTime(from.restored_at)}.
        {me.data?.user.is_admin && (
          <>
            {' '}
            <Link
              className="text-accent underline"
              to={`/projects/${encodeURIComponent(slug)}/settings?tab=danger`}
            >
              Delete it in the danger zone
            </Link>
            .
          </>
        )}
      </p>
    </Alert>
  )
}
