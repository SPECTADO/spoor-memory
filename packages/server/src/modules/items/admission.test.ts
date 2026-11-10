import { describe, expect, it } from 'vitest'
import { PushAdmission } from './admission.js'

describe('PushAdmission', () => {
  it('caps the requests in flight per project; another project still enters', () => {
    const a = new PushAdmission(2, 10)
    const r1 = a.tryEnter('p1')
    const r2 = a.tryEnter('p1')
    expect(r1).toBeTypeOf('function')
    expect(r2).toBeTypeOf('function')
    expect(a.tryEnter('p1')).toBeUndefined()
    expect(a.tryEnter('p2')).toBeTypeOf('function')
    expect(a.inFlight('p1')).toBe(2)
    expect(a.inFlight()).toBe(3)
  })

  it('caps the requests in flight over all projects', () => {
    const a = new PushAdmission(2, 3)
    expect(a.tryEnter('p1')).toBeDefined()
    expect(a.tryEnter('p2')).toBeDefined()
    expect(a.tryEnter('p3')).toBeDefined()
    expect(a.tryEnter('p4')).toBeUndefined()
    expect(a.tryEnter('p1')).toBeUndefined()
  })

  it('release frees the slot; a double release counts once; the entry is deleted at zero', () => {
    const a = new PushAdmission(1, 2)
    const r1 = a.tryEnter('p1') as () => void
    const other = a.tryEnter('p2') as () => void
    expect(a.tryEnter('p1')).toBeUndefined()
    r1()
    r1()
    expect(a.inFlight('p1')).toBe(0)
    expect(a.inFlight()).toBe(1)
    const r2 = a.tryEnter('p1') as () => void
    expect(r2).toBeTypeOf('function')
    // the double release above did not free p2's slot
    expect(a.tryEnter('p3')).toBeUndefined()
    r2()
    other()
    expect(a.inFlight()).toBe(0)
  })

  it('deletes the map entry when a project reaches zero', () => {
    const a = new PushAdmission(3, 3)
    const r1 = a.tryEnter('p1') as () => void
    const r2 = a.tryEnter('p1') as () => void
    const q = a.tryEnter('p2') as () => void
    expect(a.activeProjects).toBe(2)
    r1()
    expect(a.activeProjects).toBe(2)
    r2()
    expect(a.activeProjects).toBe(1)
    q()
    q()
    expect(a.activeProjects).toBe(0)
    expect(a.inFlight()).toBe(0)
  })
})
