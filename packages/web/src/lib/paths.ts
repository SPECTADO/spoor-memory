/**
 * SPA paths (docs/design/web-ui.md §2). `/shared/...` is the same route tree as `/projects/:slug/...` with
 * the slug fixed to `_shared`; build every in-app link with these helpers so both prefixes stay right.
 */
import { SHARED_PROJECT_SLUG } from '@spoor/shared'
import { useMatch, useParams } from 'react-router'

export const SHARED_SLUG = SHARED_PROJECT_SLUG

export const isShared = (slug: string | undefined): boolean => slug === SHARED_SLUG

export function projectPath(slug: string, rest = ''): string {
  const tail = rest ? `/${rest.replace(/^\//, '')}` : ''
  return isShared(slug) ? `/shared${tail}` : `/projects/${encodeURIComponent(slug)}${tail}`
}

export const itemPath = (slug: string, ref: string, rest = '') =>
  projectPath(slug, `i/${encodeURIComponent(ref)}${rest ? `/${rest}` : ''}`)

/** Wikilink resolver route: resolves `ref` (may carry `shared:`) then replaces itself with the item page. */
export const wikiPath = (slug: string, ref: string) => projectPath(slug, `w/${encodeURIComponent(ref)}`)

/** Inside the project route tree: the project's slug (`_shared` under `/shared`). */
export function useProjectSlug(): string {
  const params = useParams()
  return params.slug ?? SHARED_SLUG
}

/** Anywhere (the shell): the project the current URL is in, or null outside a project. */
export function useCurrentProjectSlug(): string | null {
  const project = useMatch('/projects/:slug/*')
  const shared = useMatch('/shared/*')
  if (project?.params.slug) return project.params.slug
  return shared ? SHARED_SLUG : null
}

/** A `?next=` target is honoured only when it is an in-app path (one leading `/`, not `//` or `/\`). */
export function safeNext(next: string | null | undefined, fallback = '/projects'): string {
  if (!next?.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback
  return next
}

export const loginPath = (next?: string) =>
  next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login'
