import { lazy, Suspense } from 'react'
import { SkeletonRows } from '../../ui'

const Users = lazy(() => import('./UsersPage').then((m) => ({ default: m.UsersPage })))
const Invites = lazy(() => import('./InvitesPage').then((m) => ({ default: m.InvitesPage })))
const Projects = lazy(() => import('./ProjectsAdminPage').then((m) => ({ default: m.ProjectsAdminPage })))
const Audit = lazy(() => import('./AuditPage').then((m) => ({ default: m.AuditPage })))
const Jobs = lazy(() => import('./JobsPage').then((m) => ({ default: m.JobsPage })))

const fallback = <SkeletonRows rows={4} />

/** Route elements of `/admin/*` (instance admin); each page is its own chunk. */
export function AdminUsersPage() {
  return (
    <Suspense fallback={fallback}>
      <Users />
    </Suspense>
  )
}
export function AdminInvitesPage() {
  return (
    <Suspense fallback={fallback}>
      <Invites />
    </Suspense>
  )
}
export function AdminProjectsPage() {
  return (
    <Suspense fallback={fallback}>
      <Projects />
    </Suspense>
  )
}
export function AdminJobsPage() {
  return (
    <Suspense fallback={fallback}>
      <Jobs />
    </Suspense>
  )
}
export function AdminAuditPage() {
  return (
    <Suspense fallback={fallback}>
      <Audit />
    </Suspense>
  )
}
