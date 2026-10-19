import { describe, expect, it } from 'vitest'
import { handleOf, markedHandle } from './rows.js'

const base = { number: 42, adrNumber: null, projectKind: 'project' as const, provenance: 'human' as const }
const fromProject = { projectId: 'p', projectIsShared: false }
const fromShared = { projectId: 's', projectIsShared: true }

describe('handles and the provenance marker', () => {
  it('formats per space and adds S: for shared items seen from a project', () => {
    expect(handleOf({ ...base, space: 'memories' }, fromProject)).toBe('m42')
    expect(handleOf({ ...base, space: 'docs' }, fromProject)).toBe('d42')
    expect(handleOf({ ...base, space: 'decisions', adrNumber: 7 }, fromProject)).toBe('ADR-0007')
    expect(handleOf({ ...base, space: 'docs', projectKind: 'shared' }, fromProject)).toBe('S:d42')
    expect(handleOf({ ...base, space: 'docs', projectKind: 'shared' }, fromShared)).toBe('d42')
  })
  it('agent-written content carries ~ after the handle', () => {
    expect(markedHandle({ ...base, space: 'memories', provenance: 'agent' }, fromProject)).toBe('m42~')
    expect(markedHandle({ ...base, space: 'memories' }, fromProject)).toBe('m42')
    expect(
      markedHandle({ ...base, space: 'memories', provenance: 'agent', projectKind: 'shared' }, fromProject),
    ).toBe('S:m42~')
  })
})
