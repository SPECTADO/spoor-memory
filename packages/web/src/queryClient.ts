import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { ApiError } from './api/client'
import { qk } from './api/keys'

export interface QueryClientOptions {
  /**
   * Called when any query or mutation answers 401 `unauthenticated` (the session ended). main.tsx sends the
   * user to `/login?next=…` and clears the cache. The `['me']` query is excluded: the route guard handles it.
   */
  onUnauthenticated?: () => void
}

const STARTING_RETRIES = 24 // 2 minutes at 5 s

/** Defaults of docs/design/web-ui.md §3. */
export function createQueryClient(opts: QueryClientOptions = {}): QueryClient {
  const unauth = (err: unknown, key?: readonly unknown[]) => {
    if (!(err instanceof ApiError) || err.code !== 'unauthenticated') return
    if (key && key[0] === qk.me()[0]) return
    opts.onUnauthenticated?.()
  }
  return new QueryClient({
    queryCache: new QueryCache({ onError: (err, query) => unauth(err, query.queryKey) }),
    mutationCache: new MutationCache({ onError: (err) => unauth(err) }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        // 4xx: never; 503 `starting`: every 5 s for a while; network errors and other 5xx: once
        retry: (count, err) => {
          if (!(err instanceof ApiError)) return count < 1
          if (err.code === 'starting') return count < STARTING_RETRIES
          if (err.status >= 400 && err.status < 500) return false
          return count < 1
        },
        retryDelay: (count, err) =>
          err instanceof ApiError && err.code === 'starting' ? 5_000 : Math.min(1_000 * 2 ** count, 10_000),
      },
      mutations: { retry: false },
    },
  })
}
