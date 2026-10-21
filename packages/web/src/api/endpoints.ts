/**
 * One typed function per `/api/v1` endpoint the SPA calls (docs/design/api.md). No caching here: the
 * TanStack Query hooks in hooks.ts wrap these. Path segments always go through `seg()`.
 */
import { API_PREFIX, api, apiUrl, type QueryParams, seg } from './client'
import type {
  AdminUserJson,
  AuditFilters,
  AuditRowJson,
  ContextParams,
  ContextPreview,
  DashboardJson,
  DeviceApproveResponse,
  DeviceLookup,
  EdgeJson,
  EdgesResponse,
  ImportResult,
  InstanceJobsJson,
  InstanceJson,
  InviteAcceptBody,
  InviteCreateBody,
  InviteCreateResponse,
  InviteFilters,
  InviteJson,
  InvitePreview,
  ItemAction,
  ItemCreateBody,
  ItemJson,
  ItemListFilters,
  ItemPatchBody,
  ItemSummary,
  ItemsOf,
  ItemWriteResponse,
  LoginBody,
  MemberJson,
  MeResponse,
  Page,
  PageParams,
  PasswordChangeBody,
  ProjectCreateRequest,
  ProjectJobsJson,
  ProjectJson,
  ProjectListItem,
  ProjectPatchRequest,
  ProjectRole,
  RelationKind,
  RequestFilters,
  RequestRowJson,
  RestoreBody,
  ReviewBulkBody,
  ReviewBulkResult,
  ReviewCounts,
  ReviewRowOf,
  ReviewSection,
  RevisionSnapshot,
  RevisionSummary,
  RunJobResult,
  SearchParams,
  SearchResponse,
  Space,
  SupersedeBody,
  SupersedeResponse,
  TokenCreateRequest,
  TokenCreateResponse,
  TokenJson,
  UndraftedDecisionsResponse,
  UserFilters,
  UserJson,
  UserPatchBody,
} from './types'

type Sig = { signal?: AbortSignal }
const P = (slug: string) => `/projects/${seg(slug)}`
const I = (slug: string, ref: string) => `${P(slug)}/items/${seg(ref)}`

// ---- 1. auth, me, instance ---------------------------------------------------------------------------

export const login = (body: LoginBody) => api<{ user: UserJson }>('/auth/login', { body })
export const logout = () => api<void>('/auth/logout', { method: 'POST' })
export const getMe = (o: Sig = {}) => api<MeResponse>('/me', o)
export const patchMe = (body: { name: string }) => api<{ user: UserJson }>('/me', { method: 'PATCH', body })
export const changePassword = (body: PasswordChangeBody) => api<void>('/me/password', { body })
export const getInstance = (o: Sig = {}) => api<InstanceJson>('/instance', o)

// ---- 2.1 invites -------------------------------------------------------------------------------------

/** A read, but POST: the token goes in the body, never in a URL. */
export const previewInvite = (token: string, o: Sig = {}) =>
  api<InvitePreview>('/invites/preview', { body: { token }, ...o })
export const acceptInvite = (body: InviteAcceptBody) => api<{ user: UserJson }>('/invites/accept', { body })
export const listInvites = (f: InviteFilters = {}, o: Sig = {}) =>
  api<Page<InviteJson>>('/invites', { query: { ...f }, ...o })
export const createInvite = (body: InviteCreateBody) => api<InviteCreateResponse>('/invites', { body })
export const revokeInvite = (id: string) => api<void>(`/invites/${seg(id)}`, { method: 'DELETE' })

// ---- 2.2 users (instance admin) ----------------------------------------------------------------------

export const listUsers = (f: UserFilters = {}, o: Sig = {}) =>
  api<Page<AdminUserJson>>('/users', { query: { ...f }, ...o })
export const getUser = (id: string, o: Sig = {}) => api<AdminUserJson>(`/users/${seg(id)}`, o)
export const patchUser = (id: string, body: UserPatchBody) =>
  api<AdminUserJson>(`/users/${seg(id)}`, { method: 'PATCH', body })
export const deleteUser = (id: string, confirmEmail: string) =>
  api<void>(`/users/${seg(id)}`, { method: 'DELETE', query: { confirm: confirmEmail } })

// ---- 3. device flow (browser side) -------------------------------------------------------------------

export const deviceLookup = (code: string, o: Sig = {}) =>
  api<DeviceLookup>('/device/lookup', { query: { code }, ...o })
export const deviceApprove = (code: string, readOnly: boolean) =>
  api<DeviceApproveResponse>('/device/approve', { body: { code, read_only: readOnly } })
export const deviceDeny = (code: string) => api<{ status: 'denied' }>('/device/deny', { body: { code } })

// ---- 4.1 projects ------------------------------------------------------------------------------------

export const listProjects = (o: Sig = {}) => api<ItemsOf<ProjectListItem>>('/projects', o)
export const getProject = (slug: string, o: Sig = {}) => api<ProjectJson>(P(slug), o)
export const createProject = (body: ProjectCreateRequest) => api<ProjectJson>('/projects', { body })
export const patchProject = (slug: string, body: ProjectPatchRequest) =>
  api<ProjectJson>(P(slug), { method: 'PATCH', body })
export const deleteProject = (slug: string) =>
  api<void>(P(slug), { method: 'DELETE', query: { confirm: slug } })
export const getDashboard = (slug: string, o: Sig = {}) => api<DashboardJson>(`${P(slug)}/dashboard`, o)
/** Digest preview (cookie twin of the hook endpoint), always as JSON. */
export const getContextPreview = (slug: string, params: ContextParams = {}, o: Sig = {}) =>
  api<ContextPreview>(`${P(slug)}/context`, { query: { ...params, format: 'json' } as QueryParams, ...o })

// ---- 4.2 memberships ---------------------------------------------------------------------------------

export const listMembers = (slug: string, o: Sig = {}) => api<ItemsOf<MemberJson>>(`${P(slug)}/members`, o)
export const addMember = (
  slug: string,
  body: { email: string; role: ProjectRole; library_editor?: boolean },
) => api<MemberJson>(`${P(slug)}/members`, { body })
export const setMember = (
  slug: string,
  userId: string,
  patch: { role?: ProjectRole; library_editor?: boolean },
) => api<MemberJson>(`${P(slug)}/members/${seg(userId)}`, { method: 'PUT', body: patch })
export const removeMember = (slug: string, userId: string) =>
  api<void>(`${P(slug)}/members/${seg(userId)}`, { method: 'DELETE' })

// ---- 4.3 tokens --------------------------------------------------------------------------------------

export const listTokens = (slug: string, includeRevoked = false, o: Sig = {}) =>
  api<ItemsOf<TokenJson>>(`${P(slug)}/tokens`, {
    query: { include: includeRevoked ? 'revoked' : undefined },
    ...o,
  })
export const createToken = (slug: string, body: TokenCreateRequest) =>
  api<TokenCreateResponse>(`${P(slug)}/tokens`, { body })
export const revokeToken = (slug: string, id: string) =>
  api<void>(`${P(slug)}/tokens/${seg(id)}`, { method: 'DELETE' })

// ---- 5.1 / 5.2 items ---------------------------------------------------------------------------------

export function itemListQuery(f: ItemListFilters): QueryParams {
  return {
    type: f.type?.join(','),
    status: f.status?.join(','),
    lifecycle: f.lifecycle?.join(','),
    tag: f.tag,
    pinned: f.pinned ? 'true' : undefined,
    anchor: f.anchor,
    q_title: f.q_title,
    sort: f.sort,
    dir: f.dir,
    cursor: f.cursor,
    limit: f.limit,
  }
}
export const listItems = (slug: string, space: Space, f: ItemListFilters = {}, o: Sig = {}) =>
  api<Page<ItemSummary>>(`${P(slug)}/spaces/${seg(space)}/items`, { query: itemListQuery(f), ...o })
export const createItem = (slug: string, space: Space, body: ItemCreateBody) =>
  api<ItemWriteResponse>(`${P(slug)}/spaces/${seg(space)}/items`, { body })
export const getItem = (slug: string, ref: string, o: Sig = {}) => api<ItemJson>(I(slug, ref), o)
export const patchItem = (slug: string, ref: string, body: ItemPatchBody) =>
  api<ItemWriteResponse>(I(slug, ref), { method: 'PATCH', body })
/** Hard delete; `handle` must be the item's handle (the server checks `confirm`). */
export const deleteItem = (slug: string, handle: string) =>
  api<void>(I(slug, handle), { method: 'DELETE', query: { confirm: handle } })

// ---- 5.3 operational actions -------------------------------------------------------------------------

export const itemAction = (slug: string, ref: string, action: ItemAction, note?: string) =>
  api<{ item: ItemJson }>(`${I(slug, ref)}/${action}`, note ? { body: { note } } : { method: 'POST' })
export const restoreItem = (slug: string, ref: string, body: RestoreBody = {}) =>
  api<{ item: ItemJson }>(`${I(slug, ref)}/restore`, Object.keys(body).length ? { body } : { method: 'POST' })
export const supersedeItem = (slug: string, ref: string, body: SupersedeBody) =>
  api<SupersedeResponse>(`${I(slug, ref)}/supersede`, { body })

// ---- 5.4 revisions -----------------------------------------------------------------------------------

export const listRevisions = (slug: string, ref: string, p: PageParams = {}, o: Sig = {}) =>
  api<Page<RevisionSummary>>(`${I(slug, ref)}/revisions`, { query: { ...p }, ...o })
export const getRevision = (slug: string, ref: string, n: number, o: Sig = {}) =>
  api<RevisionSnapshot>(`${I(slug, ref)}/revisions/${seg(n)}`, o)

// ---- 5.5 edges, resolve ------------------------------------------------------------------------------

export const getEdges = (slug: string, ref: string, o: Sig = {}) =>
  api<EdgesResponse>(`${I(slug, ref)}/edges`, o)
export const addEdge = (slug: string, ref: string, body: { kind: RelationKind; to: string }) =>
  api<{ edge: EdgeJson }>(`${I(slug, ref)}/edges`, { body })
export const removeEdge = (slug: string, edgeId: string) =>
  api<void>(`${P(slug)}/edges/${seg(edgeId)}`, { method: 'DELETE' })
export const resolveRef = (slug: string, ref: string, o: Sig = {}, from?: string) =>
  api<{ item: ItemSummary }>(`${P(slug)}/resolve`, { query: from ? { ref, from } : { ref }, ...o })

// ---- 6. search ---------------------------------------------------------------------------------------

export const search = (slug: string, p: SearchParams, o: Sig = {}) =>
  api<SearchResponse>(`${P(slug)}/search`, { query: { ...p }, ...o })

// ---- 8. review queue ---------------------------------------------------------------------------------

export const getReviewCounts = (slug: string, o: Sig = {}) => api<ReviewCounts>(`${P(slug)}/review`, o)
export const listReviewSection = <S extends ReviewSection>(
  slug: string,
  section: S,
  p: PageParams = {},
  o: Sig = {},
) => api<Page<ReviewRowOf[S]>>(`${P(slug)}/review/${seg(section)}`, { query: { ...p }, ...o })
export const reviewBulk = (slug: string, body: ReviewBulkBody) =>
  api<ReviewBulkResult>(`${P(slug)}/review/bulk`, { body })
/** Decision memories without an ADR yet (cookie twin of the Stop hook's bearer list), every member's. */
export const listUndraftedDecisions = (slug: string, o: Sig = {}) =>
  api<UndraftedDecisionsResponse>(`${P(slug)}/decisions/undrafted`, o)

// ---- 9. export / import ------------------------------------------------------------------------------

/** A plain link (the browser downloads the zip with the cookie); not fetched through `api()`. */
export const exportUrl = (slug: string, withHistory = true): string =>
  apiUrl(`${P(slug)}/export`, { history: withHistory ? undefined : '0' })
export function importIntoProject(slug: string, file: File, remapIds: boolean) {
  const form = new FormData()
  form.append('file', file)
  form.append('remap_ids', String(remapIds))
  return api<ImportResult>(`${P(slug)}/import`, { body: form })
}

// ---- 10. audit and jobs ------------------------------------------------------------------------------

export const listProjectAudit = (slug: string, f: AuditFilters = {}, o: Sig = {}) =>
  api<Page<AuditRowJson>>(`${P(slug)}/audit`, { query: { ...f }, ...o })
export const listInstanceAudit = (f: Omit<AuditFilters, 'item'> = {}, o: Sig = {}) =>
  api<Page<AuditRowJson>>('/audit', { query: { ...f }, ...o })
export const listProjectRequests = (slug: string, f: RequestFilters = {}, o: Sig = {}) =>
  api<Page<RequestRowJson>>(`${P(slug)}/requests`, { query: { ...f }, ...o })
export const getProjectJobs = (slug: string, o: Sig = {}) => api<ProjectJobsJson>(`${P(slug)}/jobs`, o)
export const getInstanceJobs = (o: Sig = {}) => api<InstanceJobsJson>('/jobs', o)
export const runJob = (name: string) => api<RunJobResult>(`/jobs/${seg(name)}/run`, { method: 'POST' })

/** Public install doc of a project (served by the server, not under /api). */
export const installDocUrl = (slug: string) => `/p/${seg(slug)}/install.md`
export { API_PREFIX }
