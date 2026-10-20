import { describe, expect, it } from 'vitest'
import { capAnchored } from './context.js'

describe('capAnchored (tier 3 cap)', () => {
  const rows = (ids: string[]) => ids.map((id) => ({ id }))

  it('keeps the first cap rows when tier 0 lists none of them', () => {
    expect(capAnchored(rows(['a', 'b', 'c', 'd']), new Set(), 2).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it("tier 0's anchored library pages pass in order without taking a slot", () => {
    const ordered = rows(['L1', 'L2', 'm1', 'L3', 'm2', 'm3', 'm4'])
    const out = capAnchored(ordered, new Set(['L1', 'L2', 'L3']), 3)
    expect(out.map((r) => r.id)).toEqual(['L1', 'L2', 'm1', 'L3', 'm2', 'm3'])
    // the cap still holds for everything tier 0 did not list
    expect(out.filter((r) => !r.id.startsWith('L'))).toHaveLength(3)
  })

  it('30 matched library pages ahead of 30 memories no longer push the memories out', () => {
    const pages = Array.from({ length: 30 }, (_, i) => `L${i}`)
    const memories = Array.from({ length: 35 }, (_, i) => `m${i}`)
    const out = capAnchored(rows([...pages, ...memories]), new Set(pages), 30)
    expect(out.filter((r) => r.id.startsWith('m')).map((r) => r.id)).toEqual(memories.slice(0, 30))
  })
})
