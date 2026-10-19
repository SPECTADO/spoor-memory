import { ChevronDown, LogOut, UserRound } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useMe } from '../api/hooks'
import { Badge } from '../ui'
import { useSignOut } from './session'

/** Disclosure menu (button + list): name, email, Account, Log out. Esc and outside clicks close it. */
export function AccountMenu() {
  const me = useMe()
  const { signOut, pending } = useSignOut()
  const [open, setOpen] = useState(false)
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        button.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const user = me.data?.user
  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-surface-2"
      >
        <UserRound className="size-4" aria-hidden="true" />
        <span className="hidden max-w-32 truncate sm:inline">{user?.name ?? 'Account'}</span>
        <span className="sr-only sm:hidden">Account menu</span>
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div
          id={id}
          className="absolute right-0 z-40 mt-1 w-64 rounded-md border border-border bg-bg p-1 shadow-lg"
        >
          {user && (
            <div className="border-b border-border px-3 py-2">
              <p className="truncate text-sm font-medium">{user.name}</p>
              <p className="truncate text-xs text-muted">{user.email}</p>
              <div className="mt-1 flex gap-1">
                {user.is_admin && <Badge tone="accent">Instance admin</Badge>}
                {user.shared_editor && <Badge>Shared editor</Badge>}
              </div>
            </div>
          )}
          <ul className="py-1">
            <li>
              <Link
                to="/account"
                onClick={() => setOpen(false)}
                className="block rounded px-3 py-1.5 text-sm hover:bg-surface-2"
              >
                Account and password
              </Link>
            </li>
            <li>
              <button
                type="button"
                disabled={pending}
                onClick={signOut}
                className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm hover:bg-surface-2"
              >
                <LogOut className="size-4" aria-hidden="true" />
                Log out
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  )
}
