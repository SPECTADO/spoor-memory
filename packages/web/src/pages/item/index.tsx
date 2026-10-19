/**
 * Route elements of the item pages (web-ui.md §4.2, §5, §6): item view, editor (create and edit) and
 * revision history. Each page is its own chunk, loaded on first use (Markdown, diff and the editor stay out
 * of the shell bundle).
 */
import { lazy, Suspense } from 'react'
import { SkeletonRows } from '../../ui'

const ItemView = lazy(() => import('./ItemPageImpl').then((m) => ({ default: m.ItemPageImpl })))
const Editor = lazy(() => import('./EditorPageImpl').then((m) => ({ default: m.EditorPageImpl })))
const History = lazy(() => import('./HistoryPageImpl').then((m) => ({ default: m.HistoryPageImpl })))

const fallback = <SkeletonRows rows={4} />

/** `…/i/:ref` */
export function ItemPage() {
  return (
    <Suspense fallback={fallback}>
      <ItemView />
    </Suspense>
  )
}

/** `…/:space/new` */
export function EditorNewPage() {
  return (
    <Suspense fallback={fallback}>
      <Editor mode="create" />
    </Suspense>
  )
}

/** `…/i/:ref/edit` */
export function ItemEditPage() {
  return (
    <Suspense fallback={fallback}>
      <Editor mode="edit" />
    </Suspense>
  )
}

/** `…/i/:ref/history` */
export function HistoryPage() {
  return (
    <Suspense fallback={fallback}>
      <History />
    </Suspense>
  )
}
