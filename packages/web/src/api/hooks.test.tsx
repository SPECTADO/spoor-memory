import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { createQueryClient } from '../queryClient'
import { apiError, mockApi } from '../test/utils'
import {
  flattenPages,
  revisionConflict,
  useItemAction,
  usePatchItem,
  useReviewBulk,
  useReviewSection,
} from './hooks'
import { qk } from './keys'

function setup() {
  const qc = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  return { qc, wrapper }
}

/** A reply held until `release()` is called, to observe the optimistic state. */
function deferred(res: () => Response) {
  let release = () => {}
  const reply = () => new Promise<Response>((r) => (release = () => r(res())))
  return { reply, release: () => release() }
}

const row = (handle: string) => ({ handle, days_to_archive: 10, used_since_stale: false })

describe('review actions', () => {
  it('remove rows at once and restore them when the call fails', async () => {
    const bulk = deferred(() => apiError(403, 'forbidden'))
    mockApi({
      'GET /api/v1/projects/acme/review/stale': [200, { items: [row('m1'), row('m2')], next_cursor: null }],
      'POST /api/v1/projects/acme/review/bulk': bulk.reply,
    })
    const { wrapper } = setup()
    const { result } = renderHook(
      () => ({ list: useReviewSection('acme', 'stale'), bulk: useReviewBulk('acme', 'stale') }),
      { wrapper },
    )
    await waitFor(() => expect(flattenPages(result.current.list.data)).toHaveLength(2))
    act(() => result.current.bulk.mutate({ action: 'verify', refs: ['m1'], rowKeys: ['m1'] }))
    await waitFor(() => expect(flattenPages(result.current.list.data).map((r) => r.handle)).toEqual(['m2']))
    bulk.release()
    await waitFor(() => expect(result.current.bulk.isError).toBe(true))
    expect(flattenPages(result.current.list.data).map((r) => r.handle)).toEqual(['m1', 'm2'])
  })
})

describe('item writes', () => {
  it('pin flips `pinned` optimistically and rolls back on error', async () => {
    const pin = deferred(() => apiError(403, 'forbidden'))
    mockApi({ 'POST /api/v1/projects/acme/items/m1/pin': pin.reply })
    const { qc, wrapper } = setup()
    qc.setQueryData(qk.item('acme', 'm1'), { handle: 'm1', pinned: false })
    const { result } = renderHook(() => useItemAction('acme'), { wrapper })
    act(() => result.current.mutate({ ref: 'm1', action: 'pin' }))
    await waitFor(() =>
      expect(qc.getQueryData<{ pinned: boolean }>(qk.item('acme', 'm1'))?.pinned).toBe(true),
    )
    pin.release()
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(qc.getQueryData<{ pinned: boolean }>(qk.item('acme', 'm1'))?.pinned).toBe(false)
  })

  it('surfaces a revision conflict with the current item', async () => {
    const current = { handle: 'm1', revision: 7, title: 'theirs' }
    mockApi({
      'PATCH /api/v1/projects/acme/items/m1': apiError(409, 'revision_conflict', {
        details: { current_revision: 7, current },
      }),
    })
    const { wrapper } = setup()
    const { result } = renderHook(() => usePatchItem('acme', 'm1'), { wrapper })
    act(() => result.current.mutate({ revision: 5, title: 'mine' }))
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(revisionConflict(result.current.error)).toEqual({ current_revision: 7, current })
    expect(revisionConflict(new Error('x'))).toBeNull()
  })
})
