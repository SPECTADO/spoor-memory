/** Slug rules (docs/design/data-model.md section 6). */

export const SLUG_MAX = 80
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const PROJECT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
export const SHARED_PROJECT_SLUG = '_shared'
export const RESERVED_PROJECT_SLUGS = [
  'api',
  'assets',
  'device',
  'invite',
  'login',
  'admin',
  'projects',
  'shared',
] as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function cutAtBoundary(s: string): string {
  if (s.length <= SLUG_MAX) return s
  const head = s.slice(0, SLUG_MAX + 1)
  const dash = head.lastIndexOf('-', SLUG_MAX)
  return dash > 0 ? head.slice(0, dash) : head.slice(0, SLUG_MAX)
}

/** NFKD, drop marks, lower-case, non [a-z0-9] runs to '-', trim '-', cut to 80 at a '-' boundary. Empty gives 'item'. */
export function slugify(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const cut = cutAtBoundary(base).replace(/-+$/g, '')
  return cut === '' ? 'item' : cut
}

/** True for slug shapes that would shadow handles: m42, d7, adr-7, uuid. */
export function isReservedSlugShape(slug: string): boolean {
  return /^[md]\d+$/.test(slug) || /^adr-\d+$/.test(slug) || UUID_RE.test(slug)
}

/** slugify plus the `x-` prefix for reserved shapes (so the result never shadows a handle). */
export function itemSlug(title: string): string {
  const s = slugify(title)
  return isReservedSlugShape(s) ? cutAtBoundary(`x-${s}`) : s
}

/** Resolve a collision inside (project, space): append -2, -3, ... keeping the 80-char cap. */
export function uniqueSlug(slug: string, taken: ReadonlySet<string>): string {
  if (!taken.has(slug)) return slug
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = `${slug.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, '')}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

export function isValidProjectSlug(slug: string): boolean {
  return PROJECT_SLUG_RE.test(slug) && !(RESERVED_PROJECT_SLUGS as readonly string[]).includes(slug)
}
