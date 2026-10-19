import { useCallback, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router'

/**
 * `useSearchParams` whose updates never lose each other. Writing the query is a router navigation: it waits for
 * the revalidating loaders (the auth route) and commits in a transition, so for a moment the rendered params
 * lag behind the last write. A second change made in that window (a quick click on the next filter) would be
 * computed from the stale params and drop the first one; react-router's own `setSearchParams(prev => …)`
 * passes the rendered params too. Here writes that the URL does not show yet are remembered, and `update`
 * builds on the newest of them. Writes replace the history entry (a filter change is not a page of its own).
 */
export function useSearchParamsState(): [
  URLSearchParams,
  (change: (prev: URLSearchParams) => URLSearchParams) => void,
] {
  const [params, setParams] = useSearchParams()
  const search = params.toString()
  const pending = useRef<string[]>([])

  useEffect(() => {
    // a write landed (drop it and the writes it replaced), or the URL changed elsewhere (back button): either way
    // the URL is the truth again for everything up to here
    const i = pending.current.indexOf(search)
    pending.current = i === -1 ? [] : pending.current.slice(i + 1)
  }, [search])

  const update = useCallback(
    (change: (prev: URLSearchParams) => URLSearchParams) => {
      const prev = pending.current.at(-1) ?? search
      const next = change(new URLSearchParams(prev)).toString()
      if (next === prev) return
      pending.current.push(next)
      setParams(next, { replace: true })
    },
    [search, setParams],
  )

  return [params, update]
}
