/**
 * Auth guard (web-ui.md §2.1). The guard route's loader makes sure `GET /me` is in the cache before any
 * protected page renders; a 401 redirects to `/login?next=<path and query>`. The component keeps watching
 * `me`, so a session that ends later (refetch on focus) also lands on the login page.
 */
import type { QueryClient } from '@tanstack/react-query'
import { type LoaderFunction, Navigate, Outlet, redirect, useLocation } from 'react-router'
import { ApiError } from '../api/client'
import { meQueryOptions, useMe } from '../api/hooks'
import { loginPath } from '../lib/paths'
import { ErrorState, Spinner } from '../ui'

export function authLoader(qc: QueryClient): LoaderFunction {
  return async ({ request }) => {
    try {
      await qc.ensureQueryData(meQueryOptions())
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        const url = new URL(request.url)
        throw redirect(loginPath(url.pathname + url.search))
      }
      throw e
    }
    return null
  }
}

export function AuthGuard() {
  const me = useMe()
  const location = useLocation()
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to={loginPath(location.pathname + location.search)} replace />
  }
  if (me.isPending) return <FullPageSpinner />
  if (me.isError && !me.data) {
    return (
      <div className="mx-auto max-w-md p-6">
        <ErrorState error={me.error} onRetry={() => me.refetch()} />
      </div>
    )
  }
  return <Outlet />
}

export function FullPageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center text-muted">
      <Spinner />
    </div>
  )
}
