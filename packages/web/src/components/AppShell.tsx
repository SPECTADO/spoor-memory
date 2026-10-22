/**
 * The shell (web-ui.md §4 "shell"): top bar (menu toggle on phones, logo, project switcher, project search,
 * account menu), a sidebar with the project nav, for instance admins the admin nav, and the version footer.
 * Under the `md` breakpoint the sidebar becomes a toggled panel.
 */
import { useIsFetching, useIsMutating } from '@tanstack/react-query'
import { Menu, Search, X } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router'
import { useInstance, useMe } from '../api/hooks'
import { projectPath, useCurrentProjectSlug } from '../lib/paths'
import { WEB_VERSION } from '../lib/version'
import { IconButton, Input } from '../ui'
import { AccountMenu } from './AccountMenu'
import { AdminNav, ProjectNav } from './Nav'
import { OfflineBanner } from './OfflineBanner'
import { ProjectSwitcher } from './ProjectSwitcher'

export function AppShell() {
  const me = useMe()
  const slug = useCurrentProjectSlug()
  const location = useLocation()
  const [navOpen, setNavOpen] = useState(false)

  // close the phone nav on every navigation
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on location change by design
  useEffect(() => setNavOpen(false), [location.pathname])

  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-bg focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <TopProgress />
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-bg px-3 sm:px-4">
        <IconButton
          className="md:hidden"
          label={navOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={navOpen}
          aria-controls="sidebar"
          icon={
            navOpen ? (
              <X className="size-5" aria-hidden="true" />
            ) : (
              <Menu className="size-5" aria-hidden="true" />
            )
          }
          onClick={() => setNavOpen((o) => !o)}
        />
        <Link to="/projects" className="mr-1 font-semibold tracking-tight">
          Spoor
        </Link>
        <ProjectSwitcher current={slug} />
        <div className="flex-1" />
        {slug && <ProjectSearchBox slug={slug} />}
        <AccountMenu />
      </header>
      <OfflineBanner />
      <div className="flex min-h-0 flex-1">
        <aside
          id="sidebar"
          aria-label="Sidebar"
          className={`${navOpen ? 'flex' : 'hidden'} fixed inset-x-0 top-14 bottom-0 z-20 flex-col overflow-y-auto border-r border-border bg-bg p-3 md:sticky md:flex md:h-[calc(100vh-3.5rem)] md:w-56 md:shrink-0`}
        >
          {slug && <ProjectNav slug={slug} />}
          {me.data?.user.is_admin && <AdminNav />}
          {!slug && !me.data?.user.is_admin && (
            <nav aria-label="Main">
              <Link to="/projects" className="block rounded-md px-2 py-1.5 text-sm hover:bg-surface-2">
                Projects
              </Link>
            </nav>
          )}
          <VersionFooter />
        </aside>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 px-4 py-6 sm:px-6 focus:outline-none">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

/** Search the current project; the query goes to the search page's URL (`?q=`). */
function ProjectSearchBox({ slug }: { slug: string }) {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const t = q.trim()
    if (t) navigate(projectPath(slug, `search?q=${encodeURIComponent(t)}`))
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: <search> is not in the JSX types; role="search" is equivalent
    <form role="search" onSubmit={submit} className="relative hidden w-56 sm:block lg:w-72">
      <Search
        className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted"
        aria-hidden="true"
      />
      <Input
        label="Search this project"
        hideLabel
        type="search"
        placeholder="Search this project"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        inputClassName="pl-8"
      />
    </form>
  )
}

/** Bottom of the sidebar: the web UI's version and, once known, the server's. */
function VersionFooter() {
  const server = useInstance().data?.version
  return (
    <p className="mt-auto px-2 pt-4 text-xs text-muted">
      Web {WEB_VERSION}
      {server && <> · Server {server}</>}
    </p>
  )
}

/** Thin bar while anything loads in the background (no spinners over content). */
function TopProgress() {
  const busy = useIsFetching() + useIsMutating() > 0
  return (
    <div aria-hidden="true" className="fixed inset-x-0 top-0 z-40 h-0.5 overflow-hidden">
      {busy && (
        <div className="h-full w-1/3 animate-[progress_1.2s_ease-in-out_infinite] bg-accent motion-reduce:animate-none" />
      )}
    </div>
  )
}
