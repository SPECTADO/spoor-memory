import { useNavigate } from 'react-router'
import { useProjects } from '../api/hooks'
import { projectPath, SHARED_SLUG } from '../lib/paths'
import { controlClass } from '../ui'

/** Native select: Shared knowledge plus every project the user can see (all of them for an instance admin). */
export function ProjectSwitcher({ current }: { current: string | null }) {
  const projects = useProjects()
  const navigate = useNavigate()
  const items = projects.data?.items ?? []
  return (
    <div className="min-w-0 max-w-[45vw] sm:max-w-56">
      <label htmlFor="project-switcher" className="sr-only">
        Switch project
      </label>
      <select
        id="project-switcher"
        className={`${controlClass} h-8 truncate`}
        value={current ?? ''}
        onChange={(e) => {
          const v = e.target.value
          navigate(v ? projectPath(v) : '/projects')
        }}
      >
        <option value="">All projects</option>
        <option value={SHARED_SLUG}>Shared knowledge</option>
        {items.map((p) => (
          <option key={p.slug} value={p.slug}>
            {p.name}
          </option>
        ))}
        {current && current !== SHARED_SLUG && !items.some((p) => p.slug === current) && (
          <option value={current}>{current}</option>
        )}
      </select>
    </div>
  )
}
