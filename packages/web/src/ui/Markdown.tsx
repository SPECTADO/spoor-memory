/**
 * `MarkdownView` (web-ui.md §4.1): react-markdown + remark-gfm + the wikilink plugin. No raw HTML (no
 * rehype-raw); the default urlTransform drops `javascript:` and other unsafe URLs. In-app paths render as
 * react-router links, external links open in a new tab, and images load only from this origin (the CSP
 * blocks the rest anyway): a remote image shows as a link with its alt text.
 */
import { type ComponentProps, memo, useMemo } from 'react'
import Markdown, { type Components } from 'react-markdown'
import { Link } from 'react-router'
import remarkGfm from 'remark-gfm'
import { remarkWikiLinks } from '../lib/wikilinks'
import { cx } from './cx'

/** Paths the server owns: a full page load, not a client-side navigation. */
const SERVER_PATH = /^\/(?:api|p)\/|^\/healthz(?:$|[?#])/

export const isInAppPath = (href: string | undefined): boolean =>
  !!href && href.startsWith('/') && !href.startsWith('//') && !SERVER_PATH.test(href)

const isSameOriginPath = (src: string | undefined): src is string =>
  !!src && src.startsWith('/') && !src.startsWith('//')

function A({ href, children, className, node: _node, ...rest }: ComponentProps<'a'> & { node?: unknown }) {
  if (href && isInAppPath(href)) {
    return (
      <Link to={href} className={className} {...rest}>
        {children}
      </Link>
    )
  }
  if (!href || href.startsWith('#') || href.startsWith('/')) {
    return (
      <a href={href} className={className} {...rest}>
        {children}
      </a>
    )
  }
  return (
    <a href={href} className={className} target="_blank" rel="noreferrer noopener" {...rest}>
      {children}
    </a>
  )
}

function Img({ src, alt, node: _node, ...rest }: ComponentProps<'img'> & { node?: unknown }) {
  const s = typeof src === 'string' ? src : undefined
  if (isSameOriginPath(s)) return <img src={s} alt={alt ?? ''} loading="lazy" {...rest} />
  if (!s) return <span>{alt}</span>
  return (
    <a href={s} target="_blank" rel="noreferrer noopener">
      {alt || s}
    </a>
  )
}

const components: Components = { a: A, img: Img }

export interface MarkdownViewProps {
  source: string
  /** Project the wikilinks resolve in (`_shared` on shared items). */
  slug: string
  /** Space of the page the Markdown belongs to; sent as `from` when a wikilink is resolved (sets the rank only). */
  from?: string
  className?: string
}

export const MarkdownView = memo(function MarkdownView({ source, slug, from, className }: MarkdownViewProps) {
  const remarkPlugins = useMemo(
    () => [remarkGfm, [remarkWikiLinks, { slug, from }]] as ComponentProps<typeof Markdown>['remarkPlugins'],
    [slug, from],
  )
  return (
    <div className={cx('md', className)}>
      <Markdown remarkPlugins={remarkPlugins} components={components}>
        {source}
      </Markdown>
    </div>
  )
})
