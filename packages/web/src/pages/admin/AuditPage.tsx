/** `/admin/audit` (instance admin): instance-level audit rows (users, invites, projects, jobs). */
import { PageHeader } from '../../ui'
import { InstanceAuditPanel } from '../settings/AuditPanel'

export function AuditPage() {
  return (
    <section>
      <PageHeader title="Instance audit" description="Changes to users, invites, projects and jobs." />
      <InstanceAuditPanel />
    </section>
  )
}
