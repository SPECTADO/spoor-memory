/**
 * Sidebar navigation. `ProjectNav` is role-aware: Request log, Members and Settings only for project admins
 * (Settings on the shared space: instance admins), Tokens, Request log and Members never on the shared space. The Review entry shows
 * the open review count as text, not just a colour.
 */
import {
  Activity,
  BookOpen,
  Briefcase,
  ClipboardCheck,
  FileText,
  History,
  KeyRound,
  LayoutDashboard,
  Library,
  type LucideIcon,
  Mail,
  Scale,
  Search,
  Settings,
  StickyNote,
  Timer,
  Users,
} from 'lucide-react'
import { NavLink } from 'react-router'
import { useMe, useProject, useReviewCounts } from '../api/hooks'
import { isShared, projectPath } from '../lib/paths'
import { passes } from '../lib/roles'
import { Badge, cx } from '../ui'

interface Entry {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
  badge?: number
}

function NavList({ label, title, entries }: { label: string; title: string; entries: Entry[] }) {
  return (
    <nav aria-label={label} className="mb-6">
      <h2 className="mb-1 truncate px-2 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h2>
      <ul className="space-y-0.5">
        {entries.map((e) => (
          <li key={e.to}>
            <NavLink
              to={e.to}
              end={e.end}
              className={({ isActive }) =>
                cx(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2',
                  isActive && 'bg-accent-soft font-medium text-accent',
                )
              }
            >
              <e.icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex-1 truncate">{e.label}</span>
              {e.badge ? ' ' : null}
              {e.badge ? (
                <Badge tone="warning">
                  {e.badge}
                  <span className="sr-only"> to review</span>
                </Badge>
              ) : null}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export function ProjectNav({ slug }: { slug: string }) {
  const me = useMe()
  const project = useProject(slug)
  const review = useReviewCounts(project.data ? slug : undefined)
  if (!project.data) return null
  const role = project.data.role
  const shared = isShared(slug)
  const reviewTotal = review.data ? Object.values(review.data.counts).reduce((a, b) => a + b, 0) : 0
  const p = (rest: string) => projectPath(slug, rest)
  const entries: Entry[] = [
    { to: p(''), label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: p('memories'), label: 'Memories', icon: StickyNote },
    { to: p('decisions'), label: 'Decisions', icon: Scale },
    { to: p('docs'), label: 'Docs', icon: BookOpen },
    { to: p('library'), label: 'Library', icon: Library },
    { to: p('search'), label: 'Search', icon: Search },
    { to: p('review'), label: 'Review', icon: ClipboardCheck, badge: reviewTotal },
    { to: p('audit'), label: 'Audit log', icon: History },
  ]
  if (!shared) entries.push({ to: p('tokens'), label: 'Tokens', icon: KeyRound })
  if (!shared && passes('admin', me.data, role)) {
    entries.push({ to: p('requests'), label: 'Request log', icon: Activity })
    entries.push({ to: p('members'), label: 'Members', icon: Users })
  }
  if (shared ? passes('ia', me.data, role) : passes('admin', me.data, role)) {
    entries.push({ to: p('settings'), label: 'Settings', icon: Settings })
  }
  return <NavList label="Project" title={shared ? 'Shared knowledge' : project.data.name} entries={entries} />
}

export function AdminNav() {
  return (
    <NavList
      label="Instance administration"
      title="Instance"
      entries={[
        { to: '/admin/projects', label: 'Projects', icon: Briefcase },
        { to: '/admin/users', label: 'Users', icon: Users },
        { to: '/admin/invites', label: 'Invites', icon: Mail },
        { to: '/admin/jobs', label: 'Jobs', icon: Timer },
        { to: '/admin/audit', label: 'Instance audit', icon: FileText },
      ]}
    />
  )
}
