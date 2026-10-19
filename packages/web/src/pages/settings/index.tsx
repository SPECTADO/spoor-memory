import { lazy, Suspense } from 'react'
import { SkeletonRows } from '../../ui'

const Settings = lazy(() => import('./SettingsPageImpl').then((m) => ({ default: m.SettingsPageImpl })))
const Members = lazy(() => import('./SettingsPageImpl').then((m) => ({ default: m.MembersPageImpl })))
const Tokens = lazy(() => import('./SettingsPageImpl').then((m) => ({ default: m.TokensPageImpl })))
const Audit = lazy(() => import('./SettingsPageImpl').then((m) => ({ default: m.AuditPageImpl })))

const fallback = <SkeletonRows rows={4} />

/** Route elements of the project administration pages; one lazy chunk shared by the four. */
export function SettingsPage() {
  return (
    <Suspense fallback={fallback}>
      <Settings />
    </Suspense>
  )
}
export function MembersPage() {
  return (
    <Suspense fallback={fallback}>
      <Members />
    </Suspense>
  )
}
export function TokensPage() {
  return (
    <Suspense fallback={fallback}>
      <Tokens />
    </Suspense>
  )
}
export function AuditPage() {
  return (
    <Suspense fallback={fallback}>
      <Audit />
    </Suspense>
  )
}
