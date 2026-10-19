import { lazy, Suspense } from 'react'
import { SkeletonRows } from '../../ui'

const Impl = lazy(() => import('./ReviewPageImpl').then((m) => ({ default: m.ReviewPageImpl })))

/** Route element of `…/review`; the page code is its own chunk. */
export function ReviewPage() {
  return (
    <Suspense fallback={<SkeletonRows rows={4} />}>
      <Impl />
    </Suspense>
  )
}
