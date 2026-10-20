import type { ReactNode } from 'react'
import { useMe, useProject } from '../api/hooks'
import { useCurrentProjectSlug } from '../lib/paths'
import { type Gate, passes } from '../lib/roles'
import { Forbidden, SkeletonRows } from '../ui'

/**
 * Route-level role gate (web-ui.md §2.1): renders `Forbidden` instead of a blank page when the user lacks
 * the role. `gate="ia"` needs no project; the others read the effective role of the current project.
 * Inside a page, prefer hiding the controls with `useCan(gate)`.
 */
export function RequireRole({ gate, children }: { gate: Gate; children: ReactNode }) {
  const { allowed, pending } = useCan(gate)
  if (pending) return <SkeletonRows />
  return allowed ? children : <Forbidden />
}

/** Whether the current user passes `gate` in the current project (or instance-wide for `ia`). */
export function useCan(gate: Gate, slugOverride?: string): { allowed: boolean; pending: boolean } {
  const me = useMe()
  const current = useCurrentProjectSlug()
  const slug = gate === 'ia' ? undefined : (slugOverride ?? current ?? undefined)
  const project = useProject(slug)
  if (me.isPending || (slug && project.isPending)) return { allowed: false, pending: true }
  return {
    allowed: passes(gate, me.data, project.data?.role, project.data?.can_edit_library === true),
    pending: false,
  }
}
