import { lazy, Suspense } from 'react'
import { Skeleton } from './Spinner'

export interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  /** Accessible name of the editing surface (`.cm-content`); the Playwright smoke test looks for "Editor". */
  label?: string
  minHeight?: string
  maxHeight?: string
  readOnly?: boolean
  autoFocus?: boolean
  onBlur?: () => void
}

const Impl = lazy(() => import('./MarkdownEditorImpl'))

/** Markdown editor (CodeMirror 6, lazy-loaded). Pair with `MarkdownView` for the live preview. */
export function MarkdownEditor(props: MarkdownEditorProps) {
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <Impl {...props} />
    </Suspense>
  )
}
