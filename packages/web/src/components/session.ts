import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { useLogout } from '../api/hooks'

/**
 * Log out: end the session on the server, leave the protected tree, then drop every cached query (navigate
 * first, so mounted pages do not refetch into a 401 while the cache empties).
 */
export function useSignOut() {
  const logout = useLogout()
  const navigate = useNavigate()
  const qc = useQueryClient()
  return {
    pending: logout.isPending,
    signOut: () =>
      logout.mutate(undefined, {
        onSettled: async () => {
          await navigate('/login', { replace: true })
          qc.clear()
        },
      }),
  }
}
