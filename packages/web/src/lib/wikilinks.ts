/**
 * remark plugin: `[[ref]]`, `[[ref|label]]`, `[[ref#heading]]` and `shared:` refs become links to the
 * wikilink resolver route (`/projects/<slug>/w/<ref>`), which resolves them exactly like stored edges.
 * The grammar is the shared `WIKILINK_RE` (data-model.md §3). Only `text` nodes are rewritten, so inline code
 * and code blocks stay untouched, and text already inside a link is left alone.
 */
import { WIKILINK_RE } from '@spoor/shared'
import type { Link, Parent, PhrasingContent, Root, RootContent, Text } from 'mdast'
import { wikiPath } from './paths'

export interface WikiLinkOptions {
  /** Project whose resolver the links point at (`_shared` for the shared space). */
  slug: string
  /** Space of the page holding the link; the resolver uses it only to rank candidates. */
  from?: string
}

export interface ParsedWikilink {
  /** Ref as written, `shared:` prefix kept (the resolver canonicalises it). */
  ref: string
  heading: string | null
  label: string
}

/** Parse the inside of one `[[…]]` match. */
export function parseWikilink(match: string): ParsedWikilink | null {
  const inner = match.slice(2, -2)
  const bar = inner.indexOf('|')
  const target = bar === -1 ? inner : inner.slice(0, bar)
  const alias = bar === -1 ? null : inner.slice(bar + 1).trim()
  const hash = target.indexOf('#')
  const ref = (hash === -1 ? target : target.slice(0, hash)).trim()
  const heading = hash === -1 ? null : target.slice(hash + 1).trim() || null
  if (!ref || ref === 'shared:') return null
  return { ref, heading, label: alias || target.trim() }
}

export function wikilinkHref(slug: string, link: ParsedWikilink, from?: string): string {
  const query = from ? `?from=${encodeURIComponent(from)}` : ''
  return `${wikiPath(slug, link.ref)}${query}${link.heading ? `#${encodeURIComponent(link.heading)}` : ''}`
}

function splitText(node: Text, slug: string, from?: string): PhrasingContent[] {
  const re = new RegExp(WIKILINK_RE.source, 'g')
  const out: PhrasingContent[] = []
  let last = 0
  for (const m of node.value.matchAll(re)) {
    const parsed = parseWikilink(m[0])
    if (!parsed) continue
    const at = m.index ?? 0
    if (at > last) out.push({ type: 'text', value: node.value.slice(last, at) })
    const link: Link = {
      type: 'link',
      url: wikilinkHref(slug, parsed, from),
      children: [{ type: 'text', value: parsed.label }],
      data: { hProperties: { className: ['wikilink'], 'data-wikilink': parsed.ref } },
    }
    out.push(link)
    last = at + m[0].length
  }
  if (out.length === 0) return [node]
  if (last < node.value.length) out.push({ type: 'text', value: node.value.slice(last) })
  return out
}

function walk(parent: Parent, slug: string, from?: string) {
  const next: RootContent[] = []
  for (const child of parent.children as RootContent[]) {
    if (child.type === 'text') {
      next.push(...splitText(child, slug, from))
    } else {
      if (child.type !== 'link' && child.type !== 'linkReference' && 'children' in child)
        walk(child, slug, from)
      next.push(child)
    }
  }
  parent.children = next as Parent['children']
}

export function remarkWikiLinks(options: WikiLinkOptions) {
  return (tree: Root) => walk(tree, options.slug, options.from)
}
