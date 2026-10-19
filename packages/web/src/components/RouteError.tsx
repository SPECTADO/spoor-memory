import { isRouteErrorResponse, useRouteError } from 'react-router'
import { ApiError } from '../api/client'
import { Button, ErrorState, NotFound } from '../ui'

/** Route `errorElement`: never a white page. Shows the error and an id to quote to the admin. */
export function RouteError() {
  const error = useRouteError()
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFound />
  if (error instanceof ApiError) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <ErrorState error={error} />
        <Button className="mt-4" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    )
  }
  const id = Date.now().toString(36)
  console.error(`[spoor] render error ${id}`, error)
  return (
    <div role="alert" className="mx-auto max-w-lg p-6">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted">
        The page failed to render. Error id <code className="font-mono">{id}</code> (details are in the
        browser console).
      </p>
      <Button className="mt-4" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  )
}
