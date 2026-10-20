import type { QueryClient } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import { createBrowserRouter, createMemoryRouter, Navigate, type RouteObject } from 'react-router'
import { AppShell } from './components/AppShell'
import { AuthGuard, authLoader, FullPageSpinner } from './components/AuthGuard'
import { ProjectScope } from './components/ProjectScope'
import { RequireRole } from './components/RequireRole'
import { RouteError } from './components/RouteError'
import * as P from './pages'

/**
 * Mounted twice: under /projects/:slug and under /shared (slug fixed to `_shared`, see lib/paths.ts).
 * Role gates for whole pages wrap the element in <RequireRole>; finer gates live in the pages.
 */
export const projectRoutes: RouteObject[] = [
  { index: true, lazy: page(() => import('./pages/DashboardPage'), 'DashboardPage') },
  { path: 'memories', lazy: page(() => import('./pages/SpaceListPage'), 'SpaceListPage') },
  { path: 'decisions', lazy: page(() => import('./pages/SpaceListPage'), 'SpaceListPage') },
  { path: 'docs', lazy: page(() => import('./pages/SpaceListPage'), 'SpaceListPage') },
  { path: 'library', lazy: page(() => import('./pages/SpaceListPage'), 'SpaceListPage') },
  { path: ':space/new', element: <P.EditorNewPage /> },
  { path: 'i/:ref', element: <P.ItemPage /> },
  { path: 'i/:ref/edit', element: <P.ItemEditPage /> },
  { path: 'i/:ref/history', element: <P.HistoryPage /> },
  { path: 'w/:ref', lazy: page(() => import('./pages/WikilinkPage'), 'WikilinkPage') },
  { path: 'search', lazy: page(() => import('./pages/SearchPage'), 'SearchPage') },
  { path: 'review', element: <P.ReviewPage /> },
  { path: 'audit', element: <P.AuditPage /> },
  { path: 'tokens', element: <P.TokensPage /> },
  {
    path: 'members',
    element: (
      <RequireRole gate="admin">
        <P.MembersPage />
      </RequireRole>
    ),
  },
  { path: 'settings', element: <P.SettingsPage /> },
]

const ia = (el: React.JSX.Element) => <RequireRole gate="ia">{el}</RequireRole>

/**
 * Code-split page: `lazy: page(() => import('./pages/LoginPage'), 'LoginPage')`. Each page module is its own
 * chunk, so the shell loads without the page libraries (zod forms, Markdown, CodeMirror, diff).
 */
export function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  return async () => ({ Component: (await load())[name] })
}

export function createRoutes(qc: QueryClient): RouteObject[] {
  return [
    {
      errorElement: <RouteError />,
      hydrateFallbackElement: <FullPageSpinner />,
      children: [
        { path: '/login', lazy: page(() => import('./pages/LoginPage'), 'LoginPage') },
        { path: '/invite', lazy: page(() => import('./pages/InvitePage'), 'InvitePage') },
        {
          id: 'auth',
          loader: authLoader(qc),
          element: <AuthGuard />,
          hydrateFallbackElement: <FullPageSpinner />,
          children: [
            { path: '/device', lazy: page(() => import('./pages/DevicePage'), 'DevicePage') },
            {
              element: <AppShell />,
              children: [
                {
                  // render errors inside the shell keep the navigation usable
                  errorElement: <RouteError />,
                  children: [
                    { path: '/', element: <Navigate to="/projects" replace /> },
                    { path: '/projects', lazy: page(() => import('./pages/ProjectsPage'), 'ProjectsPage') },
                    { path: '/projects/:slug', element: <ProjectScope />, children: projectRoutes },
                    { path: '/shared', element: <ProjectScope />, children: projectRoutes },
                    { path: '/account', lazy: page(() => import('./pages/AccountPage'), 'AccountPage') },
                    { path: '/admin/projects', element: ia(<P.AdminProjectsPage />) },
                    { path: '/admin/users', element: ia(<P.AdminUsersPage />) },
                    { path: '/admin/invites', element: ia(<P.AdminInvitesPage />) },
                    { path: '/admin/jobs', element: ia(<P.AdminJobsPage />) },
                    { path: '/admin/audit', element: ia(<P.AdminAuditPage />) },
                    { path: '*', element: <P.NotFoundPage /> },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ]
}

export const createRouter = (qc: QueryClient) => createBrowserRouter(createRoutes(qc))
export const createTestRouter = (qc: QueryClient, initialEntries: string[]) =>
  createMemoryRouter(createRoutes(qc), { initialEntries })
