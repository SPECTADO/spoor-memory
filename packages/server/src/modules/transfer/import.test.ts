// The library edge and claim rules of an import (ADR-0014), without a database.
// Layering: the importer refuses any supersedes of or by a library page; the DB trigger alone accepts a
// library-to-library supersedes, so the two layers differ by design (import never writes one).
import { describe, expect, it } from 'vitest'
import { libraryClaimAllowed, refusedLibraryEdge } from './import.js'

describe('refusedLibraryEdge', () => {
  it('keeps wikilinks and refines / supports / depends_on in both directions', () => {
    for (const kind of ['wikilink', 'refines', 'supports', 'depends_on']) {
      expect(refusedLibraryEdge(kind, 'library', 'memories'), kind).toBe(false)
      expect(refusedLibraryEdge(kind, 'memories', 'library'), kind).toBe(false)
      expect(refusedLibraryEdge(kind, 'library', 'library'), kind).toBe(false)
    }
  })

  it('refuses conflicts_with across the boundary, drafted_from into a library page, any supersedes with one', () => {
    expect(refusedLibraryEdge('conflicts_with', 'library', 'docs')).toBe(true)
    expect(refusedLibraryEdge('conflicts_with', 'memories', 'library')).toBe(true)
    expect(refusedLibraryEdge('conflicts_with', 'library', 'library')).toBe(false)
    expect(refusedLibraryEdge('drafted_from', 'decisions', 'library')).toBe(true)
    expect(refusedLibraryEdge('drafted_from', 'decisions', 'memories')).toBe(false)
    expect(refusedLibraryEdge('supersedes', 'memories', 'library')).toBe(true)
    expect(refusedLibraryEdge('supersedes', 'library', 'memories')).toBe(true)
    expect(refusedLibraryEdge('supersedes', 'library', 'library')).toBe(true)
    expect(refusedLibraryEdge('supersedes', 'memories', 'memories')).toBe(false)
  })

  it('refuses supersedes and conflicts_with from a library page even to an unresolved target', () => {
    expect(refusedLibraryEdge('supersedes', 'library', null)).toBe(true)
    expect(refusedLibraryEdge('conflicts_with', 'library', null)).toBe(true)
  })

  it('keeps other edges to an unresolved target', () => {
    expect(refusedLibraryEdge('wikilink', 'library', null)).toBe(false)
    expect(refusedLibraryEdge('refines', 'library', null)).toBe(false)
    expect(refusedLibraryEdge('supersedes', 'memories', null)).toBe(false)
    expect(refusedLibraryEdge('conflicts_with', 'memories', null)).toBe(false)
  })
})

describe('libraryClaimAllowed', () => {
  it('a library source is claimed only while dangling and only by a library page', () => {
    expect(libraryClaimAllowed('library', null, 'library')).toBe(true)
    expect(libraryClaimAllowed('library', null, 'docs')).toBe(false)
    expect(libraryClaimAllowed('library', 'some-id', 'library')).toBe(false)
  })

  it('other sources are unrestricted', () => {
    expect(libraryClaimAllowed('memories', null, 'docs')).toBe(true)
    expect(libraryClaimAllowed('memories', 'some-id', 'library')).toBe(true)
  })
})
