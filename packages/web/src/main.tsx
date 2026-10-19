import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router/dom'
import './index.css'
import { loginPath } from './lib/paths'
import { createQueryClient } from './queryClient'
import { createRouter } from './router'
import { ToastProvider } from './ui'

let router: ReturnType<typeof createRouter> | null = null

// A 401 on any later request means the session ended: back to the login page, then drop the cache.
const queryClient = createQueryClient({
  onUnauthenticated: () => {
    const loc = router?.state.location
    if (!router || !loc || loc.pathname === '/login' || loc.pathname === '/invite') return
    void router
      .navigate(loginPath(loc.pathname + loc.search), { replace: true })
      .then(() => queryClient.clear())
  },
})
router = createRouter(queryClient)

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
