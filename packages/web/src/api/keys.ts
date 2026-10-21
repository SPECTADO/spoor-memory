/**
 * Query keys (docs/design/web-ui.md §3). Keys are hierarchical arrays so a prefix invalidates a family:
 * `qk.items(slug)` covers every space and filter of the project, `qk.item(slug)` every item page of it.
 * Always build keys here; never write a key literal in a component.
 */
import type {
  AuditFilters,
  ContextParams,
  GraphParams,
  InviteFilters,
  ItemListFilters,
  RequestFilters,
  ReviewSection,
  SearchParams,
  Space,
  UserFilters,
} from './types'

export const qk = {
  me: () => ['me'] as const,
  instance: () => ['instance'] as const,
  invitePreview: (token: string) => ['invite-preview', token] as const,
  deviceLookup: (code: string) => ['device-lookup', code] as const,

  projects: () => ['projects'] as const,
  project: (slug: string) => ['project', slug] as const,
  dashboard: (slug: string) => ['dashboard', slug] as const,
  context: (slug: string, params?: ContextParams) =>
    params ? (['context', slug, params] as const) : (['context', slug] as const),
  members: (slug: string) => ['members', slug] as const,
  tokens: (slug: string, includeRevoked?: boolean) =>
    includeRevoked === undefined
      ? (['tokens', slug] as const)
      : (['tokens', slug, { includeRevoked }] as const),
  jobs: (slug: string) => ['jobs', slug] as const,

  items: (slug: string, space?: Space, filters?: Omit<ItemListFilters, 'cursor'>) =>
    space === undefined
      ? (['items', slug] as const)
      : filters === undefined
        ? (['items', slug, space] as const)
        : (['items', slug, space, filters] as const),
  item: (slug: string, ref?: string) =>
    ref === undefined ? (['item', slug] as const) : (['item', slug, ref] as const),
  edges: (slug: string, ref?: string) =>
    ref === undefined ? (['edges', slug] as const) : (['edges', slug, ref] as const),
  revisions: (slug: string, ref?: string) =>
    ref === undefined ? (['revisions', slug] as const) : (['revisions', slug, ref] as const),
  revision: (slug: string, ref: string, n: number) => ['revision', slug, ref, n] as const,
  graph: (slug: string, params?: GraphParams) =>
    params ? (['graph', slug, params] as const) : (['graph', slug] as const),
  related: (slug: string, ref?: string, limit?: number) =>
    ref === undefined ? (['related', slug] as const) : (['related', slug, ref, limit ?? null] as const),
  resolve: (slug: string, ref: string, from?: string) => ['resolve', slug, ref, from ?? null] as const,
  search: (slug: string, params?: SearchParams) =>
    params ? (['search', slug, params] as const) : (['search', slug] as const),
  review: (slug: string, section?: ReviewSection) =>
    section === undefined ? (['review', slug] as const) : (['review', slug, section] as const),
  /** Counts live under the same prefix as the sections, so `qk.review(slug)` refreshes both. */
  reviewCounts: (slug: string) => ['review', slug, 'counts'] as const,
  /** Under the review prefix too: any item write that refreshes the queue refreshes it. */
  undrafted: (slug: string) => ['review', slug, 'undrafted'] as const,
  audit: (slug: string, filters?: Omit<AuditFilters, 'cursor'>) =>
    filters ? (['audit', slug, filters] as const) : (['audit', slug] as const),
  requests: (slug: string, filters?: Omit<RequestFilters, 'cursor'>) =>
    filters ? (['requests', slug, filters] as const) : (['requests', slug] as const),

  users: (filters?: Omit<UserFilters, 'cursor'>) =>
    filters ? (['users', filters] as const) : (['users'] as const),
  user: (id: string) => ['users', 'one', id] as const,
  invites: (filters?: Omit<InviteFilters, 'cursor'>) =>
    filters ? (['invites', filters] as const) : (['invites'] as const),
  adminJobs: () => ['admin-jobs'] as const,
  instanceAudit: (filters?: Omit<AuditFilters, 'cursor' | 'item'>) =>
    filters ? (['instance-audit', filters] as const) : (['instance-audit'] as const),
}
