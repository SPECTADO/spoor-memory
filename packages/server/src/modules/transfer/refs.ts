/**
 * Reference resolution over an in-memory set of items (data-model.md sections 0, 3), for links into the
 * shared space on import and for links inside a folder of Markdown files. The resolution order itself is the
 * shared `pickRefTarget` (one copy, also behind the item service's resolver); wikilink extraction is the
 * shared `extractWikilinks`. Pure; the caller loads the rows.
 */
import { canonicalRef, pickRefTarget, refTarget } from '@spoor/shared'
import type { Space } from '../../ports.js'

export interface RefRow {
  id: string
  space: Space
  number: number
  adrNumber: number | null
  slug: string
}

export class RefIndex {
  readonly #bySpaceSlug = new Map<string, string>()
  readonly #bySlug = new Map<string, RefRow[]>()
  readonly #byHandle = new Map<string, RefRow>()
  readonly #rows = new Map<string, RefRow>()

  constructor(rows: Iterable<RefRow>) {
    for (const r of rows) this.add(r)
  }

  add(r: RefRow): void {
    this.#rows.set(r.id, r)
    this.#bySpaceSlug.set(`${r.space}/${r.slug}`, r.id)
    this.#bySlug.set(r.slug, [...(this.#bySlug.get(r.slug) ?? []), r])
    const handle =
      r.space === 'memories' ? `m${r.number}` : r.space === 'docs' ? `d${r.number}` : `adr-${r.adrNumber}`
    if (r.space !== 'decisions' || r.adrNumber !== null) this.#byHandle.set(handle, r)
  }

  rowOf(id: string): RefRow | undefined {
    return this.#rows.get(id)
  }

  /** Exact `<space>/<slug>` (the form of a typed edge to a shared item). */
  bySpaceSlug(spaceSlug: string): string | undefined {
    return this.#bySpaceSlug.get(spaceSlug)
  }

  /** Wikilink text (or canonical ref) without the `shared:` prefix, resolved by `pickRefTarget`. */
  resolveWikilink(text: string, srcSpace: Space): string | undefined {
    const ref = canonicalRef(text)
    const t = refTarget(ref)
    const cands =
      t.kind === 'slug' ? (this.#bySlug.get(ref) ?? []) : [this.#byHandle.get(ref)].filter((r) => r)
    return pickRefTarget(cands as RefRow[], srcSpace, ref)?.id
  }
}
