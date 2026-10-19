/**
 * Toasts: short confirmations ("Saved as r4") and action errors. One polite live region; error toasts are
 * announced assertively and stay longer. `useToast().error(e)` renders an ApiError's message, hint and
 * request id (web-ui.md §9).
 */
import { X } from 'lucide-react'
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { ApiError } from '../api/client'
import { IconButton } from './Button'
import { cx } from './cx'

export type ToastKind = 'success' | 'info' | 'error'

export interface ToastInput {
  kind?: ToastKind
  message: ReactNode
  detail?: ReactNode
  /** ms; default 5 s, errors 10 s. */
  duration?: number
}

interface ToastItem extends Required<Pick<ToastInput, 'kind' | 'message'>> {
  id: number
  detail?: ReactNode
}

export interface ToastApi {
  show: (t: ToastInput) => void
  success: (message: ReactNode, detail?: ReactNode) => void
  /** An ApiError (message, hint, request id) or any other error / text. */
  error: (e: unknown, fallback?: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

/** Human text for an error thrown by `api()` (or anything else). */
export function errorText(
  e: unknown,
  fallback = 'Something went wrong.',
): { message: string; detail?: string } {
  if (e instanceof ApiError) {
    if (e.status === 403 && !e.body?.message) return { message: 'You do not have permission to do that.' }
    const bits = [e.hint, e.requestId ? `Request id ${e.requestId}` : undefined].filter(Boolean)
    return { message: e.message || fallback, detail: bits.join(' · ') || undefined }
  }
  if (e instanceof Error && e.message) return { message: e.message }
  if (typeof e === 'string') return { message: e }
  return { message: fallback }
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((t) => t.id !== id)), [])
  const show = useCallback(
    (t: ToastInput) => {
      const id = nextId.current++
      const kind = t.kind ?? 'info'
      setItems((xs) => [...xs.slice(-3), { id, kind, message: t.message, detail: t.detail }])
      setTimeout(() => dismiss(id), t.duration ?? (kind === 'error' ? 10_000 : 5_000))
    },
    [dismiss],
  )
  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (message, detail) => show({ kind: 'success', message, detail }),
      error: (e, fallback) => show({ kind: 'error', ...errorText(e, fallback) }),
    }),
    [show],
  )
  const polite = items.filter((t) => t.kind !== 'error')
  const urgent = items.filter((t) => t.kind === 'error')
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end">
        <div role="status" aria-live="polite" className="flex flex-col gap-2">
          {polite.map((t) => (
            <ToastCard key={t.id} t={t} onDismiss={dismiss} />
          ))}
        </div>
        <div role="alert" aria-live="assertive" className="flex flex-col gap-2">
          {urgent.map((t) => (
            <ToastCard key={t.id} t={t} onDismiss={dismiss} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  )
}

function ToastCard({ t, onDismiss }: { t: ToastItem; onDismiss: (id: number) => void }) {
  return (
    <div
      className={cx(
        'pointer-events-auto flex w-[min(24rem,calc(100vw-2rem))] items-start gap-3 rounded-md border px-3 py-2 text-sm shadow-lg',
        t.kind === 'error'
          ? 'border-danger/50 bg-danger-soft'
          : t.kind === 'success'
            ? 'border-success/50 bg-success-soft'
            : 'border-border bg-surface',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t.message}</p>
        {t.detail && <p className="mt-0.5 text-xs text-muted">{t.detail}</p>}
      </div>
      <IconButton
        label="Dismiss"
        icon={<X className="size-4" aria-hidden="true" />}
        onClick={() => onDismiss(t.id)}
      />
    </div>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast needs <ToastProvider>')
  return ctx
}
