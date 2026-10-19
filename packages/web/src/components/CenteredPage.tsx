import type { ReactNode } from 'react'
import { useInstance } from '../api/hooks'

/** Frame of the pages outside the shell (login, invite, device): one centred column and the version footer. */
export function CenteredPage({
  title,
  children,
  wide = false,
}: {
  title: ReactNode
  children: ReactNode
  wide?: boolean
}) {
  const instance = useInstance()
  return (
    <div className="flex min-h-screen flex-col bg-bg px-4 py-10 text-fg">
      <main className={`mx-auto w-full ${wide ? 'max-w-lg' : 'max-w-sm'} flex-1`}>
        <p className="mb-6 text-center text-lg font-semibold tracking-tight">Spoor</p>
        <div className="rounded-lg border border-border bg-bg p-5 shadow-sm sm:p-6">
          <h1 className="mb-4 text-lg font-semibold">{title}</h1>
          {children}
        </div>
      </main>
      {instance.data && (
        <footer className="mt-8 text-center text-xs text-muted">Spoor {instance.data.version}</footer>
      )}
    </div>
  )
}
