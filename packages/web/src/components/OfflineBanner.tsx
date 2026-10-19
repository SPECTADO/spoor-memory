import { useEffect, useState } from 'react'

/** Shown while the browser reports no network (web-ui.md §9); forms keep their content meanwhile. */
export function OfflineBanner() {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  if (online) return null
  return (
    <div role="status" className="border-b border-warning/40 bg-warning-soft px-4 py-2 text-sm">
      You are offline. Changes cannot be saved until the connection is back.
    </div>
  )
}
