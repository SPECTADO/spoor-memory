import { Outlet } from 'react-router'
import { ApiError } from '../api/client'
import { useProject } from '../api/hooks'
import { useProjectSlug } from '../lib/paths'
import { ErrorState, NotFound, SkeletonRows } from '../ui'

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
  return <Outlet />
}
